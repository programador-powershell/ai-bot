/**
 * [Onda 3] As rotas de LEITURA de auditoria sobre os ENVELOPES (plano §5).
 *
 * A trilha relacional (audit_events, /api/admin/audit-events) continua sendo a
 * do chassis; ESTAS rotas leem a outra verdade — o event log durável onde o
 * funil grava tool.call/tool.result/approval.* — porque é lá que mora a
 * resposta de "o que este Bot tentou, o que o portão decidiu e o que a pessoa
 * autorizou", na ordem exata em que aconteceu (audit-before-act é a ordem DO
 * LOG, não uma anotação).
 *
 * Só leitura, só admin, e payload REDIGIDO com a MESMA régua da trilha
 * relacional (redactAuditPayload): argumentos de ferramenta podem carregar
 * segredo, e uma rota de auditoria que vaza o que audita é pior que nenhuma.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  MAX_EVENT_BATCH,
  SessionNotFoundError,
  type StorageDriver,
} from "@aibot2/domain-events";
import type { PendingApproval } from "@aibot2/plugin-action-gateway";
import { redactAuditPayload } from "../audit";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";

/** Os kinds que são AUDITORIA de efeito — o recorte padrão destas rotas. */
export const KINDS_DE_AUDITORIA: readonly string[] = [
  "tool.call",
  "tool.result",
  "approval.request",
  "approval.decision",
];

export interface DepsDaAuditoria {
  store: StorageDriver;
  /** As aprovações vivas, reconstruídas do replay (o cartão que a UI redesenha). */
  pendentes: (sessionId: string) => Promise<PendingApproval[]>;
}

export function createEnvelopeAuditRoutes(
  deps: DepsDaAuditoria,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /** As sessões que têm log — o índice de onde ler. Metadados, nunca conteúdo. */
  routes.get("/", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const sessions = await deps.store.listSessions();
    return context.json({
      sessions: sessions.map((meta) => ({
        id: meta.id,
        title: meta.title,
        updatedAt: meta.updatedAt,
        turns: meta.turns,
        ...(meta.specialist !== undefined ? { specialist: meta.specialist } : {}),
      })),
    });
  });

  /**
   * Os envelopes de auditoria de UMA sessão, na ordem do log (seq), com cursor
   * `from` (exclusivo) e teto de lote — a mesma forma do replay, porque É o
   * replay, recortado nos kinds de auditoria.
   */
  routes.get("/:sessionId", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const sessionId = context.req.param("sessionId");
    const url = new URL(context.req.url);
    const from = Number.parseInt(url.searchParams.get("from") ?? "0", 10);
    const limitPedido = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isFinite(limitPedido)
      ? Math.min(Math.max(limitPedido, 1), MAX_EVENT_BATCH)
      : 100;
    const kindsPedidos = (url.searchParams.get("kinds") ?? "")
      .split(",")
      .map((kind) => kind.trim())
      .filter(Boolean);
    const kinds = kindsPedidos.length > 0 ? kindsPedidos : KINDS_DE_AUDITORIA;

    try {
      // Lê lotes do log e FILTRA pelos kinds pedidos, avançando o cursor pelo
      // seq real: quem pagina recebe `nextFrom` e nunca perde envelope entre
      // páginas (o buraco no meio é o defeito que o log numerado impede).
      const selecionados: unknown[] = [];
      let cursor = Number.isFinite(from) && from > 0 ? from : 0;
      let esgotou = false;
      while (selecionados.length < limit && !esgotou) {
        const lote = await deps.store.since(sessionId, cursor, MAX_EVENT_BATCH);
        if (lote.length === 0) {
          // Fim do log — inclusive o caso da sessão vazia: quem pagina precisa
          // saber que não há mais nada, não receber um "talvez" eterno.
          esgotou = true;
          break;
        }
        for (const envelope of lote) {
          cursor = envelope.seq;
          if (!kinds.includes(envelope.kind)) continue;
          selecionados.push({
            ...envelope,
            // A MESMA régua da trilha relacional: chave sensível vira
            // [REDACTED] antes de sair por uma rota de leitura.
            payload: redactAuditPayload(envelope.payload),
          });
          if (selecionados.length >= limit) break;
        }
        esgotou = lote.length < MAX_EVENT_BATCH;
      }
      return context.json({
        session: sessionId,
        kinds,
        envelopes: selecionados,
        nextFrom: cursor,
        exhausted: esgotou && selecionados.length < limit,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return context.json({ error: `There is no session called ${sessionId}.` }, 404);
      }
      throw error;
    }
  });

  /** As aprovações PENDENTES de uma sessão — o que reaparece na tela após reinício. */
  routes.get("/:sessionId/pendentes", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const sessionId = context.req.param("sessionId");
    try {
      const pendentes = await deps.pendentes(sessionId);
      return context.json({
        session: sessionId,
        pending: pendentes.map((item) => ({
          sessionId: item.sessionId,
          turn: item.turn,
          // O ts ORIGINAL viaja junto: é dele que qualquer tela conta o prazo.
          ts: item.ts,
          request: item.request,
        })),
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return context.json({ error: `There is no session called ${sessionId}.` }, 404);
      }
      throw error;
    }
  });

  return routes;
}
