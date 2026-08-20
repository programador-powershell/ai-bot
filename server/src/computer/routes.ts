import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  type ActionActor,
  type ExecutionComputerGateway,
  SessionUnknownError,
} from "./execution-gateway";
import { type PolicyStore, parseActionPolicy } from "./policy-store";

/**
 * A superfície HUMANA do navegador da execução, atrás do mesmo session guard das
 * demais rotas da API.
 *
 * [Onda 4 — cirurgia §3] O que mudou de forma: o path é por `:runtimeId` (a
 * sessão de browser da execução), NUNCA por botId. O openbot expunha aqui os
 * verbos de AÇÃO (click/type/navigate/files) porque o browser era um computador
 * permanente que o navegador do usuário dirigia via HTTP. Agora quem age no
 * browser é o agent loop, EM PROCESSO, pelo seam `ctx.browser` governado pelo
 * execution-gateway — não há mais round-trip do navegador do usuário para agir.
 *
 * O que sobra aqui é o TAKE THE WHEEL (o cartão que a UI forkada mostra e o
 * handover que a pessoa comanda) mais a política que um admin lê/edita. Enquanto
 * a pessoa segura o volante, a ação do bot é recusada lá no agent-computer — a
 * tela só precisa LER o estado e oferecer assumir/devolver.
 */
export function createComputerRoutes(
  gateway: ExecutionComputerGateway,
  policyStore: PolicyStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Quem está com o volante. Consultado pela superfície ao lado da tela, para a
   * pessoa ver o bot pedir ajuda sem recarregar nada — é o cartão do needs-you.
   */
  routes.get("/:runtimeId/control", requireUser, async (context) => {
    try {
      return context.json(
        await gateway.control(context.req.param("runtimeId")),
      );
    } catch (error) {
      return context.json({ error: describe(error) }, statusFor(error));
    }
  });

  /** O bot pedindo ajuda: diz que travou e por quê. NÃO toma o controle. */
  routes.post("/:runtimeId/control/request", requireUser, (context) =>
    act(context, (runtimeId, actor, body) =>
      gateway.requestHelp(
        runtimeId,
        actor,
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "O assistente precisa de uma pessoa para continuar.",
      ),
    ),
  );

  /** Uma pessoa assumindo o volante — a partir daqui a ação do bot é recusada. */
  routes.post("/:runtimeId/control/take", requireUser, (context) =>
    act(context, (runtimeId, actor) => gateway.takeControl(runtimeId, actor)),
  );

  /** A pessoa devolvendo o volante ao bot. */
  routes.post("/:runtimeId/control/release", requireUser, (context) =>
    act(context, (runtimeId, actor) => gateway.releaseControl(runtimeId, actor)),
  );

  /**
   * As execuções com navegador vivo agora — a presença da UI (§4.7) lida do
   * estado observável da execução (task-scoped), não de um Chromium permanente
   * por bot. Uma leitura, sem linha de auditoria.
   */
  routes.get("/", requireUser, (context) =>
    context.json({ isolation: "task-scoped" as const, sessions: gateway.sessions() }),
  );

  /**
   * A política, lida e escrita por um administrador.
   *
   * Aqui em vez de no arquivo de rotas de admin, porque este diretório é dono do
   * computador e `app.ts` gasta uma linha por mount. O armazenamento embaixo é
   * durável, então a regra de um admin sobrevive ao reinício.
   */
  routes.get("/policy", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ policy: policyStore.get() });
  });

  routes.put("/policy", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;

    const parsed = parseActionPolicy(await context.req.json().catch(() => null));
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    try {
      await policyStore.set(parsed.policy, context.var.actor.email);
    } catch {
      // Salva, ou diz que não salvou. Um limite valendo agora e sumindo no
      // próximo reinício é pior que um nunca posto — então política que não pôde
      // ser escrita é relatada como falha, não guardada mudo na memória. Nada
      // muda: a política anterior segue em vigor.
      return context.json(
        {
          error:
            "Essa regra não pôde ser salva, então não foi aplicada. O limite anterior segue em vigor.",
        },
        503,
      );
    }
    return context.json({ policy: policyStore.get() });
  });

  return routes;
}

type ComputerContext = Context<{ Variables: AppVariables }>;

/**
 * Encanamento comum das rotas de handover: resolve quem pede, roda e mapeia
 * falhas para status. Um lugar só, para uma rota nova não relatar recusa como
 * erro de servidor e para o ator ser derivado igual toda vez.
 */
async function act(
  context: ComputerContext,
  handler: (
    runtimeId: string,
    actor: ActionActor,
    body: Record<string, unknown> | null,
  ) => Promise<unknown>,
) {
  // `act` recebe o contexto genérico (não o tipado por rota), então o param
  // chega como string | undefined. Toda rota que usa `act` declara :runtimeId,
  // então a ausência é impossível em runtime — mas a checagem paga o typecheck e
  // recusa alto em vez de mandar um id vazio ao gateway.
  const runtimeId = context.req.param("runtimeId");
  if (runtimeId === undefined || runtimeId === "") {
    return context.json({ error: "runtimeId é obrigatório." }, 400);
  }
  const record = context.var.actor;
  const body = (await context.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  try {
    return context.json(
      (await handler(
        runtimeId,
        {
          id: record.id,
          // Só uma linha real de users pode ir na FK da auditoria. O ator local
          // de desenvolvimento não é uma; escrevê-lo lá falha a constraint e
          // perde a linha. Quem foi está no payload de qualquer jeito.
          ...(record.email === DEV_ACTOR_EMAIL ? {} : { userId: record.id }),
        },
        body,
      )) as Record<string, unknown>,
    );
  } catch (error) {
    return context.json({ error: describe(error) }, statusFor(error));
  }
}

/**
 * O endereço do ator local, comparado para decidir se o id é uma linha real de
 * users. Comparado em vez de importado de `auth/dev-actor` porque o computador
 * não deve depender das entranhas do módulo de autenticação; este é o único fato
 * dele que importa aqui.
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Algo deu errado.";
}

/**
 * Qual status uma falha merece.
 *
 * Uma sessão desconhecida é 404 (a execução não existe/já fechou — o navegador é
 * task-scoped); o resto é 500. O agent-computer inacessível chega como erro
 * genérico e cai no 500 — a pessoa vê "não deu para alcançar o computador".
 */
function statusFor(error: unknown): 404 | 500 {
  if (error instanceof SessionUnknownError) return 404;
  return 500;
}
