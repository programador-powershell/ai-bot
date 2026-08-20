import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { ConversaDoCanal } from "./conversa";
import type { ThreadIdentity } from "./thread-identity";

/**
 * A thread id for a conversation this deployment keeps no channel for.
 *
 * Behind the session guard because a thread id is the name of somewhere a conversation will be
 * stored, and there is no reason for anybody signed out to be handed one.
 *
 * [Onda 2] O `/messages` substitui o endpoint de histórico do CopilotKit
 * (`/api/copilotkit/threads/:id/messages`, morto com o runtime): a conversa
 * agora é o NOSSO event log, e esta rota é a projeção de LEITURA dela — a
 * superfície de canal renderiza do replay. A leitura GARANTE a sessão
 * (get-or-create idempotente) de propósito: é o que permite ao hello com
 * sessionHint reabrir a MESMA conversa em vez de ganhar uma sessão sortida.
 */
export function createThreadRoutes(
  identity: ThreadIdentity,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Ausente deixa só o mint de pé — as rotas de conversa exigem o event log. */
  conversa?: ConversaDoCanal,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/mint", requireUser, (context) =>
    context.json({ threadId: identity.mint() }),
  );

  if (conversa) {
    routes.get("/:threadId/messages", requireUser, async (context) => {
      const threadId = context.req.param("threadId");
      const messages = await conversa.mensagens(threadId);
      return context.json({ messages });
    });
  }

  return routes;
}
