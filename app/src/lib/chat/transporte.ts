/**
 * [Onda 2] O fio entre o app forkado e o chassis — o MESMO protocolo que o
 * desktop Tauri fala com o gateway (a forma do transport.ts do desktop,
 * portada para cá; compat dupla é falar a mesma língua, não parecida).
 *
 * As três decisões que não são detalhe:
 *
 * 1. O TOKEN VIAJA NO PRIMEIRO FRAME, nunca na URL. `new WebSocket(url)` não
 *    aceita cabeçalho, e `?token=…` entraria em log de proxy, histórico e
 *    captura de tela. No desktop quem conhece o token é o Rust; aqui é a
 *    sessão autenticada — o app o busca em /api/stream/token (atrás do session
 *    guard) e ele vive SÓ nesta closure: nunca em estado, prop ou persist.
 *
 * 2. RECONECTAR CONTINUA A RESPOSTA, não a recomeça: o último `seq` APLICADO
 *    vira `resumeFrom` no hello da reconexão. A ordem é aplica-PRIMEIRO,
 *    avança-o-marco-DEPOIS — invertida, um envelope que a redução recusa some
 *    para sempre (o replay seguinte já não o pede).
 *
 * 3. O RELÓGIO DE RECONEXÃO É ÚNICO e morre no stop(): timer solto acordando
 *    contra um transporte descartado é o vazamento clássico daqui.
 */

import {
  VERSAO_DO_PROTOCOLO,
  ehEnvelope,
  type Envelope,
  type Ready,
} from "./protocolo";

export type StatusDaConversa = "connecting" | "ready" | "offline";

/** A fatia de WebSocket que o transporte usa — injetável para teste a seco. */
export interface SocketDaConversa {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  readyState: number;
  send(texto: string): void;
  close(codigo?: number, motivo?: string): void;
}

const SOCKET_ABERTO = 1; // WebSocket.OPEN

export interface TransporteDaConversa {
  start(): void;
  stop(): void;
  /** Envia um verbo do protocolo (prompt, decisões…). Offline = descartado. */
  send(kind: string, payload: unknown): boolean;
  /** Troca de sessão NA MESMA conexão — o re-hello REAPRESENTA o token. */
  switchSession(hint: string | null, specialist?: string): void;
}

export interface OpcoesDoTransporte {
  /** ws://host/v1/stream */
  url: string;
  /** O segredo do hello. Vive só na closure — ver decisão 1. */
  token: string;
  onEnvelope: (envelope: Envelope) => void;
  onStatus: (status: StatusDaConversa) => void;
  /** Conversa a retomar na PRIMEIRA conexão (a thread do canal). */
  session?: string;
  /** Fábrica de socket — o teste injeta um dublê; produção usa o WebSocket do navegador. */
  criarSocket?: (url: string) => SocketDaConversa;
}

/** Quem está do outro lado — o servidor separa app de desktop no log por isto. */
export const NOME_DO_CLIENTE = "aibot2-app";
export const VERSAO_DO_CLIENTE = "0.1.0";

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;

/** Exponencial com jitter de metade a inteiro — todas as janelas caem juntas quando o server reinicia. */
function atrasoDeReconexao(tentativa: number): number {
  const teto = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** tentativa);
  return Math.round(teto / 2 + Math.random() * (teto / 2));
}

export function criarTransporteDaConversa(
  opcoes: OpcoesDoTransporte,
): TransporteDaConversa {
  const { url, token, onEnvelope, onStatus } = opcoes;
  const criarSocket =
    opcoes.criarSocket ??
    ((destino: string) => new WebSocket(destino) as unknown as SocketDaConversa);

  let socket: SocketDaConversa | null = null;
  let relogio: ReturnType<typeof setTimeout> | null = null;
  let tentativa = 0;
  let parado = true;
  let status: StatusDaConversa = "offline";

  /** Sessão vinda do `ready` — é ela que vai nos envelopes de saída. */
  let session = opcoes.session ?? "";
  /** Último seq APLICADO — o marco do replay. */
  let ultimoSeq = 0;

  function mudarStatus(proximo: StatusDaConversa): void {
    if (status === proximo) return;
    status = proximo;
    onStatus(proximo);
  }

  function limparRelogio(): void {
    if (relogio === null) return;
    clearTimeout(relogio);
    relogio = null;
  }

  /** Solta os manipuladores ANTES de descartar — onclose de socket abandonado agendaria reconexão dupla. */
  function soltar(alvo: SocketDaConversa): void {
    alvo.onopen = null;
    alvo.onmessage = null;
    alvo.onerror = null;
    alvo.onclose = null;
  }

  function agendarReconexao(): void {
    if (parado || relogio !== null) return;
    const atraso = atrasoDeReconexao(tentativa);
    tentativa += 1;
    relogio = setTimeout(() => {
      relogio = null;
      abrir();
    }, atraso);
  }

  function escreverEnvelope(alvo: SocketDaConversa, kind: string, payload: unknown): void {
    const envelope: Envelope = {
      v: VERSAO_DO_PROTOCOLO,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      // Quem numera é o servidor: seq é a ordem do log da sessão.
      seq: 0,
      session,
      kind,
      from: { kind: "user" },
      payload,
    };
    alvo.send(JSON.stringify(envelope));
  }

  function mandarHello(alvo: SocketDaConversa): void {
    const hello: Record<string, unknown> = {
      client: NOME_DO_CLIENTE,
      version: VERSAO_DO_CLIENTE,
      token,
      // Zero = do começo; depois de uma queda, o último seq aplicado — é o
      // que faz a resposta continuar de onde parou.
      resumeFrom: ultimoSeq,
    };
    if (session !== "") hello.sessionHint = session;
    escreverEnvelope(alvo, "hello", hello);
  }

  /** Entrega à tela e diz se foi APLICADO — o marco só anda depois do sim. */
  function entregar(envelope: Envelope): boolean {
    try {
      onEnvelope(envelope);
      return true;
    } catch (causa) {
      console.error(
        `[chat] envelope ${envelope.kind}#${envelope.seq} não pôde ser aplicado; ` +
          "o marco do replay fica onde estava para ele voltar na reconexão",
        causa,
      );
      return false;
    }
  }

  function receber(dado: unknown): void {
    // O protocolo é texto; binário é engano de quem escreveu do outro lado.
    if (typeof dado !== "string") return;
    let bruto: unknown;
    try {
      bruto = JSON.parse(dado);
    } catch {
      return;
    }
    if (!ehEnvelope(bruto)) return;

    if (bruto.kind === "ready") {
      const ready = bruto.payload as Ready | undefined;
      if (ready && typeof ready.session === "string" && ready.session !== "") {
        if (ready.session !== session) {
          // Trocou de sessão: o marco é POR sessão — zera em vez de adotar o
          // seq do ready (adotá-lo pularia o replay que vem logo atrás).
          session = ready.session;
          ultimoSeq = 0;
        }
      }
      tentativa = 0;
      mudarStatus("ready");
      entregar(bruto);
      return;
    }

    // Aplica PRIMEIRO, avança o marco DEPOIS (decisão 2 do cabeçalho).
    if (!entregar(bruto)) return;
    if (bruto.seq > ultimoSeq) ultimoSeq = bruto.seq;
  }

  function abrir(): void {
    if (parado) return;
    limparRelogio();
    mudarStatus("connecting");

    let proximo: SocketDaConversa;
    try {
      proximo = criarSocket(url);
    } catch {
      mudarStatus("offline");
      agendarReconexao();
      return;
    }
    socket = proximo;

    proximo.onopen = () => {
      if (socket !== proximo) return;
      mandarHello(proximo);
    };
    proximo.onmessage = (event) => {
      if (socket !== proximo) return;
      receber(event.data);
    };
    // onerror não traz motivo útil e SEMPRE vem seguido de onclose.
    proximo.onerror = () => {};
    proximo.onclose = () => {
      if (socket !== proximo) return;
      soltar(proximo);
      socket = null;
      mudarStatus("offline");
      // Reconexão inclusive no 1013 (cliente atrasado): o resumeFrom do
      // próximo hello recompõe exatamente o que faltou — é o contrato do log
      // numerado, e o teste de contrapressão do chassis o prova do outro lado.
      agendarReconexao();
    };
  }

  return {
    start(): void {
      if (!parado && socket !== null) return;
      parado = false;
      tentativa = 0;
      abrir();
    },

    stop(): void {
      parado = true;
      limparRelogio();
      if (socket !== null) {
        const alvo = socket;
        socket = null;
        soltar(alvo);
        // 1000 = fim normal; sem o close explícito o servidor segura a sessão
        // até o timeout e a próxima abertura convive com o fantasma.
        alvo.close(1000, "encerrado pelo cliente");
      }
      mudarStatus("offline");
    },

    send(kind: string, payload: unknown): boolean {
      if (socket === null || socket.readyState !== SOCKET_ABERTO) return false;
      // Sem fila de saída de propósito: reenviar um prompt guardado depois da
      // reconexão responderia algo que a pessoa já desistiu de perguntar.
      escreverEnvelope(socket, kind, payload);
      return true;
    },

    switchSession(hint: string | null, specialist?: string): void {
      if (socket === null || socket.readyState !== SOCKET_ABERTO) return;
      // O marco de replay é POR SESSÃO; a nova começa do zero.
      ultimoSeq = 0;
      const hello: Record<string, unknown> = {
        client: NOME_DO_CLIENTE,
        version: VERSAO_DO_CLIENTE,
        // O re-hello REAPRESENTA o token: um frame forjado numa conexão
        // autenticada não pode escolher a sessão de ninguém.
        token,
        resumeFrom: 0,
      };
      if (hint !== null && hint !== "") hello.sessionHint = hint;
      if ((hint === null || hint === "") && specialist) hello.specialist = specialist;
      escreverEnvelope(socket, "hello", hello);
    },
  };
}
