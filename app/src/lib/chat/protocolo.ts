/**
 * [Onda 2] O NOSSO protocolo de conversa, do lado do app forkado:
 * hello/ready/replay/prompt/delta/done — a forma dos envelopes do event log
 * (@aibot2/domain-events, espelhada aqui porque o app roda no navegador e não
 * importa pacotes do server) e a PROJEÇÃO pura de envelopes em transcript.
 *
 * A projeção é um reducer sem estado escondido de propósito: a conversa É o
 * replay do log — a mesma sequência de envelopes produz a mesma tela, hoje e
 * amanhã, aqui e no desktop. É o que o teste de compat do app fixa contra as
 * fixtures do oráculo Go (por valor).
 */

export const VERSAO_DO_PROTOCOLO = 1;

export type Ator = {
  kind: string;
  id?: string;
  specialist?: string;
};

/** A unidade de tráfego — a mesma forma do envelope do log (protocol.ts). */
export type Envelope = {
  v: number;
  id: string;
  ts: string;
  seq: number;
  session: string;
  turn?: string;
  kind: string;
  from: Ator;
  to?: Ator;
  payload?: unknown;
};

/** O payload do ready que o app consome (o resto fica para as ondas de UI). */
export type Ready = {
  session: string;
  seq: number;
  specialists?: string[];
  activeSpecialist?: string;
  activeModel?: string;
};

/** Uma linha desenhável do transcript, projetada do log. */
export type MensagemDaConversa = {
  id: string;
  role: "user" | "assistant";
  text: string;
  turn?: string;
  specialist?: string;
  /** true enquanto o texto ainda chega por deltas (o done fecha). */
  emStream?: boolean;
};

/**
 * [Onda 3] Um pedido de aprovação VIVO, projetado do replay: approval.request
 * sem approval.decision e sem tool.result = cartão na tela. Como a projeção é
 * pura sobre o log durável, o cartão RENASCE depois de um reinício do server —
 * e o prazo conta do `ts` ORIGINAL do pedido, nunca do momento do replay.
 */
export type AprovacaoPendente = {
  callId: string;
  tool: string;
  /** O ts do envelope original — a única fonte do prazo do cartão. */
  ts: string;
  risk?: string;
  summary?: string;
  detail?: string;
  turn?: string;
};

/** O prazo do servidor (APPROVAL_TIMEOUT_MS do funil), espelhado para a tela. */
export const PRAZO_DA_APROVACAO_MS = 10 * 60 * 1000;

export type EstadoDaConversa = {
  mensagens: MensagemDaConversa[];
  /** Há um turno aberto (prompt sem done) — o composer mostra "pensando". */
  turnoAberto: boolean;
  /** Os cartões de aprovação vivos — ver AprovacaoPendente. */
  aprovacoes: AprovacaoPendente[];
};

export const CONVERSA_VAZIA: EstadoDaConversa = {
  mensagens: [],
  turnoAberto: false,
  aprovacoes: [],
};

/**
 * Conferência estrutural do que chegou do fio — a mesma régua do desktop: o
 * dono do contrato é o servidor; aqui só não se deixa passar null, texto solto
 * ou JSON de outro protocolo.
 */
export function ehEnvelope(valor: unknown): valor is Envelope {
  if (typeof valor !== "object" || valor === null) return false;
  const candidato = valor as Partial<Envelope>;
  return (
    typeof candidato.kind === "string" &&
    typeof candidato.seq === "number" &&
    typeof candidato.session === "string" &&
    typeof candidato.from === "object" &&
    candidato.from !== null
  );
}

/** O id da linha em streaming de um turno — um por turno, substituída pelo message final. */
function idDoStream(turn: string | undefined): string {
  return `stream:${turn ?? "sem-turno"}`;
}

/**
 * Aplica UM envelope ao estado e devolve o próximo (imutável — é o contrato
 * de setState do React e o que mantém a projeção testável a seco).
 *
 * O vocabulário tratado é o da CONVERSA: message (durável, replay), delta
 * (efêmero, streaming), done (fecha o turno), error (fecha com falha). Os
 * demais verbos (route, thinking, tool.*) são das superfícies das próximas
 * ondas — ignorá-los aqui é honesto: nada finge desenhá-los.
 */
export function aplicarEnvelope(
  estado: EstadoDaConversa,
  envelope: Envelope,
): EstadoDaConversa {
  if (envelope.kind === "message") {
    const payload = envelope.payload as
      | { role?: unknown; text?: unknown; specialist?: unknown }
      | undefined;
    if (typeof payload?.role !== "string" || typeof payload.text !== "string") {
      return estado;
    }
    if (payload.role !== "user" && payload.role !== "assistant") {
      // system/tool não são linhas do transcript (a mesma decisão do
      // transcriptMessages do chassis original).
      return estado;
    }
    // O message final SUBSTITUI o acumulado de deltas do turno (o texto
    // integral veio do log; manter os dois duplicaria a resposta) — e um
    // replay repetido não duplica linha (dedupe por id do envelope).
    const semStreamDoTurno = estado.mensagens.filter(
      (mensagem) =>
        mensagem.id !== idDoStream(envelope.turn) && mensagem.id !== envelope.id,
    );
    return {
      ...estado,
      mensagens: [
        ...semStreamDoTurno,
        {
          id: envelope.id,
          role: payload.role,
          text: payload.text,
          ...(envelope.turn !== undefined ? { turn: envelope.turn } : {}),
          ...(typeof payload.specialist === "string"
            ? { specialist: payload.specialist }
            : {}),
        },
      ],
    };
  }

  if (envelope.kind === "delta") {
    const payload = envelope.payload as { text?: unknown } | undefined;
    if (typeof payload?.text !== "string") return estado;
    const id = idDoStream(envelope.turn);
    const existente = estado.mensagens.find((mensagem) => mensagem.id === id);
    if (existente !== undefined) {
      return {
        ...estado,
        turnoAberto: true,
        mensagens: estado.mensagens.map((mensagem) =>
          mensagem.id === id
            ? { ...mensagem, text: mensagem.text + payload.text }
            : mensagem,
        ),
      };
    }
    return {
      ...estado,
      turnoAberto: true,
      mensagens: [
        ...estado.mensagens,
        {
          id,
          role: "assistant",
          text: payload.text,
          ...(envelope.turn !== undefined ? { turn: envelope.turn } : {}),
          ...(envelope.from.specialist !== undefined
            ? { specialist: envelope.from.specialist }
            : {}),
          emStream: true,
        },
      ],
    };
  }

  if (envelope.kind === "done" || envelope.kind === "error") {
    // O turno fechou: o que estava em stream vira definitivo.
    return {
      ...estado,
      turnoAberto: false,
      mensagens: estado.mensagens.map((mensagem) =>
        mensagem.emStream === true ? { ...mensagem, emStream: false } : mensagem,
      ),
    };
  }

  // [Onda 3] O cartão de aprovação nasce do approval.request…
  if (envelope.kind === "approval.request") {
    const payload = envelope.payload as
      | { callId?: unknown; tool?: unknown; risk?: unknown; summary?: unknown; detail?: unknown }
      | undefined;
    if (typeof payload?.callId !== "string" || typeof payload.tool !== "string") {
      return estado;
    }
    const callId = payload.callId;
    const cartao: AprovacaoPendente = {
      callId,
      tool: payload.tool,
      ts: envelope.ts,
      ...(typeof payload.risk === "string" ? { risk: payload.risk } : {}),
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
      ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
      ...(envelope.turn !== undefined ? { turn: envelope.turn } : {}),
    };
    return {
      ...estado,
      // Replay repetido não duplica cartão: o callId é a identidade.
      aprovacoes: [
        ...estado.aprovacoes.filter((pendente) => pendente.callId !== callId),
        cartao,
      ],
    };
  }

  // …e morre com a decisão OU com o desfecho (o timeout recusa por
  // tool.result, então prazo estourado também fecha o cartão).
  if (envelope.kind === "approval.decision" || envelope.kind === "tool.result") {
    const payload = envelope.payload as { callId?: unknown } | undefined;
    if (typeof payload?.callId !== "string") return estado;
    const callId = payload.callId;
    if (!estado.aprovacoes.some((pendente) => pendente.callId === callId)) {
      return estado;
    }
    return {
      ...estado,
      aprovacoes: estado.aprovacoes.filter((pendente) => pendente.callId !== callId),
    };
  }

  return estado;
}

/** Açúcar para testes e restauração: aplica uma sequência inteira (o replay). */
export function projetarReplay(envelopes: readonly Envelope[]): EstadoDaConversa {
  return envelopes.reduce(aplicarEnvelope, CONVERSA_VAZIA);
}
