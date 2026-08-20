/**
 * [Onda 2] A conversa dos channels É o event log (plano §5/Onda 2, R3).
 *
 * O openbot guardava a história das threads no CopilotKit Intelligence (SaaS);
 * a onda 1 cortou o mount e deixou a promessa. Aqui ela é paga: o que uma
 * thread contém vem do replay do log de envelopes (@aibot2/domain-events), e o
 * que se diz numa thread entra pelo session bus — gravado ANTES de distribuído,
 * numerado pelo store, replayável amanhã.
 *
 * O MAPEAMENTO thread → sessão é IDENTIDADE, de propósito: o threadId já é
 * cunhado pelo deployment (thread-identity.ts, com a impressão digital dele) e
 * o StorageDriver aceita id arbitrário na criação. Uma tabela de mapeamento no
 * chassis.db seria uma segunda verdade para a mesma pergunta — o plano permite
 * ao chassis guardar "mapeamento/metadados", e o menor mapeamento correto é
 * nenhum. O chassis.db segue dono só dos METADADOS de canal (nome, membros,
 * preview do roster) — o conteúdo mora no events.db e drizzle nunca toca aqui
 * (fronteira do §4.4).
 */

import {
  SessionExistsError,
  SessionNotFoundError,
  MAX_EVENT_BATCH,
  type Envelope,
  type SessionMeta,
  type StorageDriver,
} from "@aibot2/domain-events";
import type {
  EnvelopeDeEntrada,
  SessionBus,
} from "@aibot2/harness-openbot-bridge";

/** Uma linha de conversa projetada do log — o que a superfície de canal desenha. */
export type MensagemDoLog = {
  id: string;
  seq: number;
  role: string;
  text: string;
  ts: string;
  turn?: string;
  specialist?: string;
};

export type ConversaDoCanal = {
  /**
   * Garante que a sessão da thread EXISTE no log (get-or-create idempotente).
   * Chamado na criação do canal e na primeira leitura de uma thread — o hello
   * com sessionHint só reabre sessão que existe; sem isto, o transporte
   * criaria uma sessão de id sortido e a thread apontaria para o vazio.
   */
  garantirSessao(threadId: string, titulo?: string): Promise<SessionMeta>;
  /** A conversa da thread, projetada do REPLAY do log (kind message). */
  mensagens(threadId: string): Promise<MensagemDoLog[]>;
  /**
   * O funil de entrada do transporte (onInbound): um `prompt` vira o envelope
   * `message` do usuário no log — gravado e distribuído pelo bus, para todo
   * espectador da sessão (o app, o desktop, um watch) ver a MESMA linha.
   * A RESPOSTA a esse prompt é da onda 3 (agent loop no funil); aqui o
   * transporte não interpreta nada além de persistir o que a pessoa disse.
   */
  receberDoTransporte(sessionId: string, envelope: EnvelopeDeEntrada): Promise<void>;
};

/** A forma mínima de um payload de prompt vindo do fio (o resto é do funil). */
function textoDoPrompt(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const texto = (payload as { text?: unknown }).text;
  return typeof texto === "string" && texto.trim() !== "" ? texto : undefined;
}

export function criarConversaDoCanal(
  store: StorageDriver,
  bus: SessionBus,
): ConversaDoCanal {
  let contador = 0;
  const novoId = (prefixo: string) => `${prefixo}-${Date.now()}-${++contador}`;

  return {
    async garantirSessao(threadId, titulo) {
      try {
        return await store.getSession(threadId);
      } catch (erro) {
        if (!(erro instanceof SessionNotFoundError)) throw erro;
      }
      try {
        return await store.createSession({
          id: threadId,
          ...(titulo !== undefined && titulo !== "" ? { title: titulo } : {}),
        });
      } catch (erro) {
        // Corrida com outra criação da MESMA thread: quem perdeu lê o que o
        // vencedor criou — o resultado é o mesmo e ninguém explode.
        if (erro instanceof SessionExistsError) {
          return store.getSession(threadId);
        }
        throw erro;
      }
    },

    async mensagens(threadId) {
      const sessao = await this.garantirSessao(threadId);
      const linhas: MensagemDoLog[] = [];
      let cursor = 0;
      for (;;) {
        const lote: Envelope[] = await store.since(sessao.id, cursor, MAX_EVENT_BATCH);
        for (const envelope of lote) {
          if (envelope.kind !== "message") continue;
          const payload = envelope.payload as
            | { role?: unknown; text?: unknown; specialist?: unknown }
            | undefined;
          if (typeof payload?.role !== "string" || typeof payload.text !== "string") {
            continue;
          }
          linhas.push({
            id: envelope.id,
            seq: envelope.seq,
            role: payload.role,
            text: payload.text,
            ts: envelope.ts,
            ...(envelope.turn !== undefined ? { turn: envelope.turn } : {}),
            ...(typeof payload.specialist === "string"
              ? { specialist: payload.specialist }
              : {}),
          });
        }
        if (lote.length < MAX_EVENT_BATCH) return linhas;
        cursor = lote[lote.length - 1]?.seq ?? cursor;
      }
    },

    async receberDoTransporte(sessionId, envelope) {
      if (envelope.kind !== "prompt") {
        // Decisões/aprovações/etc. são do funil (onda 3). Ignorar aqui é
        // honesto: nada fingiu tratá-las.
        return;
      }
      const texto = textoDoPrompt(envelope.payload);
      if (texto === undefined) return;
      // O turno nasce no prompt, como no oráculo: tudo que a onda 3 produzir
      // em resposta agrupa por este id.
      await bus.publish(sessionId, {
        id: novoId("e"),
        turn: novoId("t"),
        kind: "message",
        from: { kind: "user" },
        payload: { role: "user", text: texto },
      });
    },
  };
}
