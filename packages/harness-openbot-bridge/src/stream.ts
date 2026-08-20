/**
 * O canal ao vivo: um WebSocket por sessão — porte da FORMA do
 * transport/stream.go do oráculo Go.
 *
 * A autenticação é NO PRIMEIRO FRAME, nunca na URL. Token em query string entra
 * em log de proxy, em histórico do navegador e em mensagem de erro — e o
 * WebSocket não passa por CORS, então sem token qualquer página aberta na
 * estação abriria este socket e mandaria o AI-BOT executar ferramenta.
 *
 * As três invariantes de ordem que este arquivo carrega (cada uma tem o seu
 * teste nomeado em stream.test.ts):
 *
 *  (a) a assinatura do barramento vem ANTES da leitura do lastSeq que vai no
 *      ready — invertido, um evento que nasce entre a última linha lida do log
 *      e a assinatura some para sempre;
 *  (b) a troca de sessão (re-hello na MESMA conexão) PARA a leitura até o
 *      "ack": o frame seguinte ao hello já pertence à sessão nova — processá-lo
 *      antes da troca o gravaria na conversa errada (foi exatamente o defeito
 *      que o oráculo consertou: o segundo hello era ignorado em silêncio e
 *      todo pedido seguinte caía na sessão antiga);
 *  (c) `liveOnly` não faz replay e o cursor nasce no MESMO lastSeq do ready:
 *      nada anterior trafega e, mesmo assim, nada que nascer na janela entre
 *      assinar e ler o lastSeq se perde — porque a assinatura de (a) é anterior.
 *
 * No Go, leitura e escrita são duas goroutines conversando por canais
 * (switches/acks). Aqui as duas viram dois laços assíncronos: a BOMBA (entrega
 * do barramento ao socket) e o laço de ENTRADA (frames do cliente). O ack do
 * oráculo vira construção: o laço de entrada é sequencial, então ele só pega o
 * próximo frame DEPOIS que a troca de sessão assentou — não há como um prompt
 * passar na frente do próprio hello.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  MAX_EVENT_BATCH,
  SessionNotFoundError,
  VERSION,
  type Envelope,
  type Environment,
  type EnvironmentInfo,
  type Hello,
  type Model,
  type Ready,
  type SessionMeta,
  type SessionSummary,
  type StorageDriver,
} from '@aibot2/domain-events'

import type { ConexaoDeStream } from './conexao.js'
import { SessionBus, type Assinatura } from './eventbus.js'
import {
  CLOSE_GOING_AWAY,
  CLOSE_INTERNAL,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_TRY_AGAIN_LATER,
  OP_TEXT,
  UpgradeRecusadoError,
  upgradeWebSocket,
} from './ws.js'

/* ------------------------------- constantes ------------------------------ */

/**
 * Quanto o servidor espera pelo `hello`. Conexão que abre e fica calada é
 * sonda ou cliente quebrado; nos dois casos, fechar é o certo. (Mesmo valor do
 * helloDeadline do oráculo.)
 */
export const HELLO_DEADLINE_MS = 15_000

/** Mantém a conexão viva através de proxies e detecta o cliente que sumiu sem fechar. */
export const PING_INTERVAL_MS = 25_000

/**
 * Prazo de UMA escrita. É o que evita que um cliente que parou de ler prenda a
 * bomba para sempre — o writeDeadline do oráculo, traduzido em corrida de
 * promise porque socket do Node não tem deadline nativo.
 */
export const WRITE_DEADLINE_MS = 20_000

/**
 * Quantas conversas vão na lista do `ready`. A barra lateral só mostra as
 * recentes, e mandar o histórico inteiro atrasaria o primeiro quadro da janela
 * em nome de linhas que ninguém rolou até ver.
 */
export const READY_SESSION_LIMIT = 50

/* --------------------------------- tipos --------------------------------- */

/**
 * Um frame de ENTRADA já decodificado do JSON, ainda sem interpretação. Não é
 * o Envelope do log de propósito: o cliente manda `session:""` e `seq:0` (quem
 * numera é o servidor), então validar com a régua do log recusaria o hello
 * legítimo — o oráculo também só faz Unmarshal aqui, nunca Validate().
 */
export interface EnvelopeDeEntrada {
  kind: string
  payload?: unknown
  [campo: string]: unknown
}

/** O ambiente ativo e o catálogo com disponibilidade JÁ medida (ver sendReady do oráculo). */
export interface EstadoDeAmbientes {
  environment?: Environment
  environments?: EnvironmentInfo[]
}

/** O seam do registro de ambientes (E7/E8 pluga o de verdade; hoje é config). */
export type ProvedorDeAmbientes = (
  sessionId: string,
) => EstadoDeAmbientes | Promise<EstadoDeAmbientes>

/** Log mínimo do transporte. Seam, não biblioteca: o server decide o destino. */
export type LogDoTransporte = (mensagem: string, campos?: Record<string, unknown>) => void

export interface StreamOptions {
  store: StorageDriver
  bus: SessionBus
  /** O segredo que separa "meu app" de "qualquer página do navegador". Obrigatório. */
  token: string
  /** Origens de navegador aceitas no handshake (ver checkOrigin em ws.ts). */
  allowOrigins?: readonly string[]
  /**
   * A lista de especialistas que vai no ready — e que valida o dono de sessão
   * nova. [Onda 3] Aceita também um PROVEDOR (função), porque o catálogo real
   * mora no specialist-registry e troca A QUENTE (overlay publicado): uma
   * cópia tirada na subida anunciaria para sempre o catálogo do boot.
   */
  specialists?: readonly string[] | (() => readonly string[])
  /** O catálogo de modelos que vai no ready — mesmo contrato de provedor. */
  models?: readonly Model[] | (() => readonly Model[])
  environments?: ProvedorDeAmbientes
  /**
   * Para onde vão os verbos do cliente (prompt, decisões…). O transporte NÃO
   * interpreta: quem decide é o supervisor (E6) — aqui só se entrega.
   */
  onInbound?: (sessionId: string, envelope: EnvelopeDeEntrada) => void
  helloTimeoutMs?: number
  pingIntervalMs?: number
  writeTimeoutMs?: number
  readySessionLimit?: number
  /** Prazo entre o close e o destroy do socket (repassado ao WsConn). */
  lingerMs?: number
  /** Fábrica de ids (a forma do newID do oráculo). Injetável para teste determinístico. */
  idFactory?: (prefixo: string) => string
  log?: LogDoTransporte
}

/** A bomba: o laço que entrega o barramento ao socket. */
interface Bomba {
  cancelar(): void
  /** Assenta quando o laço termina. NUNCA rejeita — erro de escrita encerra por dentro. */
  fim: Promise<void>
}

/* ------------------------------- o servidor ------------------------------ */

export class StreamServer {
  readonly #store: StorageDriver
  readonly #bus: SessionBus
  readonly #token: Buffer
  readonly #allowOrigins: readonly string[]
  /** Sempre funções por dentro: lista fixa vira provedor constante na subida. */
  readonly #specialists: () => readonly string[]
  readonly #models: () => readonly Model[]
  readonly #ambientes: ProvedorDeAmbientes
  readonly #onInbound: (sessionId: string, envelope: EnvelopeDeEntrada) => void
  readonly #helloTimeoutMs: number
  readonly #pingIntervalMs: number
  readonly #writeTimeoutMs: number
  readonly #readySessionLimit: number
  readonly #lingerMs: number | undefined
  readonly #idFactory: (prefixo: string) => string
  readonly #log: LogDoTransporte

  /** Conexões vivas — para o encerramento do processo fechá-las educadamente. */
  readonly #conexoes = new Set<ConexaoDeStream>()

  #contadorDeIds = 0

  constructor(options: StreamOptions) {
    if (options.token.trim() === '') {
      // Sem token, qualquer página em loopback conversa com um executor de
      // ferramenta. Subir assim não é configuração: é vulnerabilidade.
      throw new Error('transporte sem token — o hello não teria como autenticar ninguém')
    }
    this.#store = options.store
    this.#bus = options.bus
    this.#token = Buffer.from(options.token, 'utf8')
    this.#allowOrigins = options.allowOrigins ?? []
    this.#specialists = comoProvedor(options.specialists ?? [])
    this.#models = comoProvedor(options.models ?? [])
    this.#ambientes = options.environments ?? (() => ({}))
    this.#onInbound = options.onInbound ?? (() => {})
    this.#helloTimeoutMs = options.helloTimeoutMs ?? HELLO_DEADLINE_MS
    this.#pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS
    this.#writeTimeoutMs = options.writeTimeoutMs ?? WRITE_DEADLINE_MS
    this.#readySessionLimit = options.readySessionLimit ?? READY_SESSION_LIMIT
    this.#lingerMs = options.lingerMs
    this.#idFactory =
      options.idFactory ?? ((prefixo) => `${prefixo}${Date.now()}${++this.#contadorDeIds}`)
    this.#log = options.log ?? (() => {})
  }

  /** Quantas conexões estão vivas — só diagnóstico e teste. */
  get conexoes(): number {
    return this.#conexoes.size
  }

  /**
   * Assume um upgrade HTTP. Handshake que falha responde o HTTP cru (o socket
   * ainda é HTTP nesse ponto) com o MESMO corpo opaco do oráculo: dizer qual
   * checagem reprovou é ajuda para quem está sondando — o motivo real vai só
   * para o log do servidor.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let conn: ConexaoDeStream
    try {
      conn = upgradeWebSocket(
        req,
        socket,
        head,
        this.#allowOrigins,
        this.#lingerMs !== undefined ? { lingerMs: this.#lingerMs } : undefined,
      )
    } catch (erro) {
      const status = erro instanceof UpgradeRecusadoError ? erro.status : 400
      this.#log('upgrade recusado', {
        erro: erro instanceof Error ? erro.message : String(erro),
        remoto: req.socket?.remoteAddress,
      })
      recusarUpgrade(socket, status)
      return
    }
    void this.atender(conn, { origem: primeiroHeader(req.headers.origin) })
  }

  /**
   * [Onda 2] Atende uma conexão JÁ negociada — o seam por onde o transporte
   * nativo do Bun (e qualquer outro que implemente ConexaoDeStream) entrega o
   * socket ao protocolo. O handshake HTTP (origem, caminho, 101) é obrigação
   * de quem chama; daqui para dentro valem as invariantes do stream.
   */
  async atender(conn: ConexaoDeStream, info?: { origem?: string | undefined }): Promise<void> {
    this.#conexoes.add(conn)
    try {
      await this.#atender(conn, info?.origem)
    } finally {
      this.#conexoes.delete(conn)
    }
  }

  /** Fecha todas as conexões vivas — o caminho do encerramento do processo. */
  fecharTodas(codigo: number = CLOSE_GOING_AWAY, motivo = 'servidor encerrando'): void {
    for (const conn of this.#conexoes) {
      conn.close(codigo, motivo)
    }
  }

  /* ----------------------------- o protocolo ----------------------------- */

  async #atender(conn: ConexaoDeStream, origem: string | undefined): Promise<void> {
    const entrada = new FilaDeEntrada(conn)
    let assinatura: Assinatura | undefined
    let bomba: Bomba | undefined
    let ping: NodeJS.Timeout | undefined

    try {
      // 1. hello — autenticação e escolha da sessão, com prazo.
      const primeira = await entrada.proxima(this.#helloTimeoutMs)
      if (primeira === 'prazo' || primeira === 'fim') {
        conn.close(CLOSE_PROTOCOL_ERROR, 'esperava hello')
        return
      }
      const abertura = parseEnvelopeDeEntrada(primeira)
      if (abertura === undefined || abertura.kind !== 'hello') {
        conn.close(CLOSE_PROTOCOL_ERROR, 'primeiro frame precisa ser hello')
        return
      }
      const hello = decodeHello(abertura.payload)
      if (hello === undefined) {
        conn.close(CLOSE_PROTOCOL_ERROR, 'hello inválido')
        return
      }
      if (!this.#tokenConfere(hello.token)) {
        // Ao CLIENTE não se diz qual parte falhou. Ao LOG do servidor sim — o
        // silêncio aqui já custou uma tarde de diagnóstico no oráculo. O
        // comprimento não é o segredo: separa "token vazio" (o cliente não
        // conseguiu lê-lo) de "token errado" (leu o de outra instalação).
        this.#log('handshake recusado: token não confere', {
          origem,
          tamanho_recebido: Buffer.byteLength(hello.token ?? '', 'utf8'),
          tamanho_esperado: this.#token.length,
        })
        conn.close(CLOSE_POLICY, 'não autorizado')
        return
      }

      let meta: SessionMeta
      try {
        meta = await this.#resolverSessao(hello.sessionHint, hello.specialist)
      } catch (erro) {
        conn.close(CLOSE_INTERNAL, 'não foi possível abrir a sessão')
        this.#log('abrir sessão', { erro: mensagemDe(erro) })
        return
      }
      let sessionId = meta.id

      // 2. Assina ANTES do replay (invariante a). Assinar depois abre uma
      // janela em que um evento nasce entre a última linha lida do log e a
      // assinatura — e some para sempre.
      assinatura = this.#bus.subscribe(sessionId)

      // 3. ready — tudo o que a tela precisa para se montar sem segunda chamada.
      const lastSeq = await this.#enviarReady(conn, sessionId, meta)

      // 4. replay a partir do cursor do cliente — ou, em liveOnly, cursor no
      // MESMO lastSeq que acabou de ir no ready (invariante c): tudo até ali
      // conta como entregue e a bomba abaixo já descarta seq <= entregue.
      const entregue =
        hello.liveOnly === true
          ? lastSeq
          : await this.#replay(conn, sessionId, hello.resumeFrom ?? 0)

      // 5. bomba (escritor) e laço de entrada (leitor) em paralelo.
      bomba = this.#bombear(conn, assinatura, entregue)
      ping = setInterval(() => {
        // Ping é sinal de vida: se o socket morreu, o 'close' dele encerra
        // tudo — o catch aqui só impede uma rejeição órfã.
        void conn.ping().catch(() => {})
      }, this.#pingIntervalMs)
      ping.unref?.()

      for (;;) {
        const quadro = await entrada.proxima()
        if (quadro === 'fim' || quadro === 'prazo') {
          return
        }
        const envelope = parseEnvelopeDeEntrada(quadro)
        if (envelope === undefined) {
          // Frame ilegível é ignorado, não punido — o mesmo continue do
          // readLoop do oráculo.
          continue
        }

        if (envelope.kind === 'hello') {
          // TROCA DE SESSÃO (invariante b). O hello de troca REAPRESENTA o
          // token: um frame forjado dentro de uma conexão autenticada não pode
          // escolher a sessão de ninguém.
          const troca = decodeHello(envelope.payload)
          if (troca === undefined) {
            continue
          }
          if (!this.#tokenConfere(troca.token)) {
            this.#log('troca de sessão recusada: token não confere', {
              origem,
              tamanho_recebido: Buffer.byteLength(troca.token ?? '', 'utf8'),
              tamanho_esperado: this.#token.length,
            })
            conn.close(CLOSE_POLICY, 'não autorizado')
            return
          }
          let novaMeta: SessionMeta
          try {
            novaMeta = await this.#resolverSessao(troca.sessionHint, troca.specialist)
          } catch (erro) {
            conn.close(CLOSE_INTERNAL, 'não foi possível abrir a sessão')
            this.#log('abrir sessão na troca', { erro: mensagemDe(erro) })
            return
          }

          // A bomba velha é PARADA e aguardada antes do ready novo: sem a
          // espera, um envelope da sessão antiga já na fila dela poderia sair
          // no fio DEPOIS do ready da nova — e o cliente montaria a conversa
          // errada por um frame.
          bomba.cancelar()
          assinatura.close()
          await bomba.fim

          // Mesma ordem do começo: assina ANTES de ler o lastSeq que vai no
          // ready — invertido, um evento nascido no meio some para sempre.
          sessionId = novaMeta.id
          assinatura = this.#bus.subscribe(sessionId)
          const novoLastSeq = await this.#enviarReady(conn, sessionId, novaMeta)
          const novoEntregue =
            troca.liveOnly === true
              ? novoLastSeq
              : await this.#replay(conn, sessionId, troca.resumeFrom ?? 0)
          bomba = this.#bombear(conn, assinatura, novoEntregue)

          // O "ack" do oráculo é este continue: o laço é sequencial, então o
          // próximo frame só é lido com a troca JÁ assentada — e pertence,
          // por construção, à sessão nova.
          continue
        }

        this.#onInbound(sessionId, envelope)
      }
    } catch (erro) {
      // Erro de escrita (prazo estourado, socket morto) chega aqui: a conexão
      // já era — o close abaixo é idempotente e o log guarda o porquê.
      this.#log('conexão encerrada com erro', { erro: mensagemDe(erro) })
    } finally {
      if (ping !== undefined) clearInterval(ping)
      bomba?.cancelar()
      assinatura?.close()
      conn.close(CLOSE_NORMAL, 'encerrado')
      await bomba?.fim
    }
  }

  /**
   * A bomba: consome a assinatura e escreve no socket. É PULL — o ritmo é do
   * socket, e é a diferença entre produção e consumo que enche a fila do
   * barramento e dispara o `atrasado`.
   */
  #bombear(conn: ConexaoDeStream, assinatura: Assinatura, entregueInicial: number): Bomba {
    let cancelada = false
    const fim = (async () => {
      let entregue = entregueInicial
      for (;;) {
        const item = await assinatura.proximo()
        // Checar DEPOIS do await: a troca de sessão cancela e fecha — nada da
        // sessão velha pode sair no fio depois disso.
        if (cancelada || item.tipo === 'fechada') {
          return
        }
        if (item.tipo === 'atrasado') {
          // O cliente ficou para trás e foi desconectado do barramento. Ele
          // reconecta e refaz o replay — por isso o log é numerado.
          conn.close(CLOSE_TRY_AGAIN_LATER, 'cliente atrasado — reconecte pedindo replay')
          return
        }
        const envelope = item.envelope
        // O replay já entregou tudo até `entregue`; reentregar duplicaria a
        // mensagem na tela de quem reconectou no meio do turno.
        if (envelope.seq !== 0 && envelope.seq <= entregue) {
          continue
        }
        if (envelope.seq !== 0) {
          entregue = envelope.seq
        }
        try {
          await this.#escreverComPrazo(conn, () =>
            conn.writeText(Buffer.from(JSON.stringify(envelope), 'utf8')),
          )
        } catch {
          // Escrita que não drenou: a conexão já foi fechada pelo prazo (ou o
          // socket caiu). A bomba morre; o laço de entrada acaba pelo onclose.
          return
        }
      }
    })()
    return {
      cancelar: () => {
        cancelada = true
      },
      fim,
    }
  }

  /**
   * replay entrega o histórico a partir do cursor (exclusivo) e devolve o
   * último seq entregue. Erro de LEITURA encerra o replay e preserva a conexão
   * — o log ilegível não pode derrubar a sessão que a pessoa está abrindo;
   * erro de ESCRITA sobe, porque sem socket não há conexão a preservar.
   */
  async #replay(conn: ConexaoDeStream, sessionId: string, desde: number): Promise<number> {
    let entregue = desde
    for (;;) {
      let lote: Envelope[]
      try {
        lote = await this.#store.since(sessionId, entregue, MAX_EVENT_BATCH)
      } catch {
        return entregue
      }
      if (lote.length === 0) {
        return entregue
      }
      // A RAJADA do oráculo: um prazo por lote e uma escrita em lote, em vez
      // de uma ida ao socket por envelope — os bytes no fio são idênticos,
      // muda só a fronteira das syscalls.
      const quadros = lote.map((envelope) => Buffer.from(JSON.stringify(envelope), 'utf8'))
      await this.#escreverComPrazo(conn, () => conn.writeTextBurst(quadros))
      entregue = lote[lote.length - 1]!.seq
      if (lote.length < MAX_EVENT_BATCH) {
        return entregue
      }
    }
  }

  /**
   * Manda o `ready` da sessão — tudo o que a tela precisa para se montar sem
   * uma segunda chamada — e devolve o lastSeq que foi nele.
   */
  async #enviarReady(conn: ConexaoDeStream, sessionId: string, meta: SessionMeta): Promise<number> {
    const lastSeq = await this.#store.lastSeq(sessionId)
    const ambientes = await this.#ambientes(sessionId)
    const payload: Ready = {
      session: sessionId,
      seq: lastSeq,
      // Lidos do PROVEDOR a cada ready: o catálogo real (registry) troca a
      // quente, e o que a tela recebe é o de agora — não o do boot.
      specialists: [...this.#specialists()],
      models: [...this.#models()],
      // Os opcionais espelham os omitempty do Go: ausente e vazio são a mesma coisa.
      ...(meta.specialist !== undefined && meta.specialist !== ''
        ? { activeSpecialist: meta.specialist }
        : {}),
      ...(meta.model !== undefined && meta.model !== '' ? { activeModel: meta.model } : {}),
      ...(ambientes.environment !== undefined ? { environment: ambientes.environment } : {}),
      ...(ambientes.environments !== undefined ? { environments: ambientes.environments } : {}),
      sessions: await this.#resumosDeSessao(),
    }
    // O envelope do ready não vem do log (id vazio, seq 0) — é a forma exata
    // do writeEnvelope do oráculo, e as fixtures gravaram exatamente isso.
    const envelope: Envelope = {
      v: VERSION,
      id: '',
      ts: new Date().toISOString(),
      seq: 0,
      session: sessionId,
      kind: 'ready',
      from: { kind: 'system' },
      payload,
    }
    await this.#escreverComPrazo(conn, () =>
      conn.writeText(Buffer.from(JSON.stringify(envelope), 'utf8')),
    )
    return lastSeq
  }

  /**
   * A lista de conversas do `ready`. Falha do store devolve lista VAZIA, nunca
   * erro: a barra lateral é acessório e a sessão que a pessoa está abrindo
   * funciona sem ela.
   */
  async #resumosDeSessao(): Promise<SessionSummary[]> {
    let metas: SessionMeta[]
    try {
      metas = await this.#store.listSessions()
    } catch (erro) {
      this.#log('listar sessões para o ready', { erro: mensagemDe(erro) })
      return []
    }
    // listSessions já vem ordenado por updatedAt decrescente: cortar o começo
    // é ficar com as mais recentes.
    if (metas.length > this.#readySessionLimit) {
      metas = metas.slice(0, this.#readySessionLimit)
    }
    return metas.map((meta) => ({
      id: meta.id,
      title: meta.title,
      ...(meta.specialist !== undefined ? { specialist: meta.specialist } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      updatedAt: meta.updatedAt,
      turns: meta.turns,
      ...(meta.botId !== undefined ? { botId: meta.botId } : {}),
      ...(meta.parentId !== undefined ? { parentId: meta.parentId } : {}),
      ...(meta.lastGoal !== undefined ? { lastGoal: meta.lastGoal } : {}),
    }))
  }

  /** Abre a sessão pedida ou cria uma nova (a forma do resolveSession do oráculo). */
  async #resolverSessao(
    hint: string | undefined,
    dono: string | undefined,
  ): Promise<SessionMeta> {
    if (hint !== undefined && hint !== '') {
      try {
        // Sessão existente IGNORA o dono pedido: o modo gravado é dela, e
        // deixar um hello trocá-lo reescreveria com quem a pessoa conversa.
        return await this.#store.getSession(hint)
      } catch (erro) {
        if (!(erro instanceof SessionNotFoundError)) {
          throw erro
        }
      }
    }
    // O dono só vale na CRIAÇÃO, e só se for um especialista de verdade: a
    // conversa nasce do bot e o primeiro pedido vai direto a ele em vez de
    // descer a cascata.
    const especialista =
      dono !== undefined && this.#specialists().includes(dono) ? dono : ''
    return this.#store.createSession({
      id: this.#idFactory('s'),
      ...(especialista !== '' ? { specialist: especialista } : {}),
    })
  }

  /**
   * Comparação em tempo constante (a forma do constantTimeEqual do oráculo,
   * sobre node:crypto.timingSafeEqual). O comprimento é comparado antes porque
   * o timingSafeEqual EXIGE buffers do mesmo tamanho — e o comprimento não é o
   * segredo, como o comentário do oráculo explica.
   */
  #tokenConfere(recebido: string | undefined): boolean {
    const candidato = Buffer.from(recebido ?? '', 'utf8')
    if (candidato.length !== this.#token.length) {
      return false
    }
    return timingSafeEqual(candidato, this.#token)
  }

  /**
   * Corrida entre a escrita e o prazo — o writeDeadline do oráculo. Estourar o
   * prazo FECHA a conexão (o cliente parou de ler; segurar a bomba por ele
   * seria deixar a memória crescer no lugar dele) e propaga o erro.
   */
  async #escreverComPrazo(conn: ConexaoDeStream, escrever: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const prazo = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('prazo de escrita estourado')),
        this.#writeTimeoutMs,
      )
      timer.unref?.()
    })
    try {
      const pendente = escrever()
      // A promise abandonada pela corrida não pode virar unhandled rejection
      // quando o destroy do socket a rejeitar lá na frente.
      pendente.catch(() => {})
      await Promise.race([pendente, prazo])
    } catch (erro) {
      conn.close(CLOSE_GOING_AWAY, 'escrita não drenou a tempo')
      throw erro
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/* ------------------------------ fila de entrada --------------------------- */

/**
 * Converte o `onmessage` dirigido a evento do WsConn num consumo PULL: é o que
 * permite ao laço de entrada PARAR durante a troca de sessão (invariante b) —
 * os frames que chegarem no meio esperam aqui, na ordem, em vez de serem
 * processados contra a sessão errada.
 */
class FilaDeEntrada {
  readonly #mensagens: Buffer[] = []
  #fim = false
  #acordar: (() => void) | undefined

  constructor(conn: ConexaoDeStream) {
    conn.onmessage = (opcode, payload) => {
      // Só texto interessa ao protocolo — binário é ignorado, como o
      // `if opcode != OpText { continue }` do oráculo.
      if (opcode !== OP_TEXT) return
      this.#mensagens.push(payload)
      this.#despertar()
    }
    conn.onclose = () => {
      this.#fim = true
      this.#despertar()
    }
  }

  /** Espera a próxima mensagem de texto, o fim da conexão ou o prazo. */
  async proxima(prazoMs?: number): Promise<Buffer | 'fim' | 'prazo'> {
    const limite = prazoMs !== undefined ? Date.now() + prazoMs : undefined
    for (;;) {
      const mensagem = this.#mensagens.shift()
      if (mensagem !== undefined) return mensagem
      if (this.#fim) return 'fim'
      if (limite !== undefined && Date.now() >= limite) return 'prazo'

      let timer: NodeJS.Timeout | undefined
      await new Promise<void>((resolve) => {
        this.#acordar = resolve
        if (limite !== undefined) {
          timer = setTimeout(resolve, Math.max(0, limite - Date.now()))
          timer.unref?.()
        }
      })
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #despertar(): void {
    const acordar = this.#acordar
    this.#acordar = undefined
    acordar?.()
  }
}

/* --------------------------------- apoio --------------------------------- */

/**
 * Decodifica um frame de entrada. Ilegível devolve undefined — quem chama
 * decide se ignora (frame do meio) ou fecha (o primeiro, que TEM de ser hello).
 */
export function parseEnvelopeDeEntrada(payload: Buffer): EnvelopeDeEntrada | undefined {
  let valor: unknown
  try {
    valor = JSON.parse(payload.toString('utf8'))
  } catch {
    return undefined
  }
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    return undefined
  }
  const kind = (valor as Record<string, unknown>)['kind']
  if (typeof kind !== 'string' || kind === '') {
    return undefined
  }
  return valor as EnvelopeDeEntrada
}

/**
 * Decodifica o payload de um hello com a tolerância do json.Unmarshal do Go:
 * campo ausente (ou null) fica no zero-value; campo com TIPO errado invalida o
 * hello inteiro. resumeFrom negativo também invalida — no Go ele é uint64 e um
 * negativo nem desserializa.
 */
export function decodeHello(payload: unknown): Hello | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined
  }
  const bruto = payload as Record<string, unknown>
  const hello: Hello = { client: '', version: '' }

  const textos: Array<'client' | 'version' | 'token' | 'sessionHint' | 'specialist'> = [
    'client',
    'version',
    'token',
    'sessionHint',
    'specialist',
  ]
  for (const campo of textos) {
    const valor = bruto[campo]
    if (valor === undefined || valor === null) continue
    if (typeof valor !== 'string') return undefined
    if (campo === 'client') hello.client = valor
    else if (campo === 'version') hello.version = valor
    else hello[campo] = valor
  }

  const resumeFrom = bruto['resumeFrom']
  if (resumeFrom !== undefined && resumeFrom !== null) {
    if (typeof resumeFrom !== 'number' || !Number.isInteger(resumeFrom) || resumeFrom < 0) {
      return undefined
    }
    hello.resumeFrom = resumeFrom
  }

  const liveOnly = bruto['liveOnly']
  if (liveOnly !== undefined && liveOnly !== null) {
    if (typeof liveOnly !== 'boolean') return undefined
    hello.liveOnly = liveOnly
  }

  return hello
}

/**
 * Resposta HTTP crua para um upgrade recusado. O corpo é o envelope de erro
 * OPACO do oráculo (`fail(w, 400, "upgrade", ...)`): o motivo real fica no log
 * do servidor, nunca na resposta de quem está sondando.
 */
function recusarUpgrade(socket: Duplex, status: 400 | 403): void {
  const corpo = JSON.stringify({
    error: { code: 'upgrade', message: 'handshake de websocket inválido' },
  })
  const razao = status === 403 ? 'Forbidden' : 'Bad Request'
  try {
    socket.write(
      `HTTP/1.1 ${status} ${razao}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(corpo)}\r\n` +
        'Connection: close\r\n\r\n' +
        corpo,
    )
  } catch {
    // O socket já caiu — o destroy abaixo resolve.
  }
  socket.end()
  // O destroy imediato cortaria a resposta antes de sair do buffer; end()
  // deixa o kernel entregá-la e fecha em seguida.
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro)
}

/**
 * Normaliza lista-ou-provedor para provedor. A lista fixa vira uma função
 * constante — por dentro do servidor só existe UM jeito de perguntar pelo
 * catálogo, e o chamador escolhe se a resposta é viva (registry) ou congelada
 * (teste, config estática).
 */
function comoProvedor<T>(valor: readonly T[] | (() => readonly T[])): () => readonly T[] {
  return typeof valor === 'function' ? valor : () => valor
}

/** Header do node:http pode vir repetido; para o log de origem vale o primeiro. */
function primeiroHeader(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header
}
