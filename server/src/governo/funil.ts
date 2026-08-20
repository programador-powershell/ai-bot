/**
 * [Onda 3] O FUNIL do chassis: a porta única pela qual as rotas HTTP do
 * chassis (MCP e componentes generativos) chegam ao action-gateway montado no
 * kernel. As rotas não seguram executor nenhum — quem executa é o funil, que
 * antes decide (Gate), registra (tool.call/tool.result duráveis) e, quando o
 * risco pede, espera a decisão humana (approval.request/decision, durável e
 * rearmável após reinício).
 *
 * A SESSÃO dos envelopes: uma chamada vinda de uma thread usa a própria
 * sessão da thread (o cartão de aprovação aparece NA conversa onde a chamada
 * nasceu). Chamada sem thread — a página de admin, um teste de conector — cai
 * na sessão de governo do Bot (`governo-<bot>`, get-or-create): todo efeito
 * tem um log de envelopes onde morar, nunca um efeito órfão.
 */

import type {
  ActionResult,
  ActionGatewayService,
  PendingApproval,
} from "@aibot2/plugin-action-gateway";
import type { ConversaDoCanal } from "../channels/conversa";
import type { PluginStore } from "../plugins/store";

export interface ChamadaMcp {
  ref: string;
  args: Record<string, unknown>;
  agentId: string;
  actorId: string;
  threadId?: string;
}

export interface ChamadaDeComponente {
  name: string;
  agentId: string;
  actorId: string;
  threadId?: string;
  /** As data functions que o render nomeia (decisão cobre o que ele vai ler). */
  functions?: readonly string[];
  /** Presentes só em component.data. */
  function?: string;
  args?: Record<string, unknown>;
}

export interface FunilDoChassi {
  chamarMcp(chamada: ChamadaMcp): Promise<ActionResult>;
  decidirRender(chamada: ChamadaDeComponente): Promise<ActionResult>;
  lerDadosDeComponente(chamada: ChamadaDeComponente): Promise<ActionResult>;
  /** As aprovações vivas de uma sessão — o cartão que a UI redesenha do replay. */
  pendentes(sessionId: string): Promise<PendingApproval[]>;
}

export interface DepsDoFunil {
  gateway: ActionGatewayService;
  conversa: ConversaDoCanal;
  pluginStore: PluginStore;
}

export function criarFunilDoChassi(deps: DepsDoFunil): FunilDoChassi {
  const { gateway, conversa, pluginStore } = deps;

  /** A sessão onde os envelopes desta chamada moram (get-or-create). */
  async function sessaoDe(threadId: string | undefined, agentId: string): Promise<string> {
    const limpo = threadId?.trim() ?? "";
    const alvo = limpo !== "" ? limpo : `governo-${agentId}`;
    const meta = await conversa.garantirSessao(alvo, `Governo — ${agentId}`);
    return meta.id;
  }

  return {
    async chamarMcp(chamada) {
      const sessionId = await sessaoDe(chamada.threadId, chamada.agentId);
      // O efeito ANUNCIADO vem do catálogo revisado, nunca do nome — e o que
      // não é positivamente leitura é escrita, no intent E no risco do portão.
      const mcp = await pluginStore.classify(chamada.ref);
      const args = {
        ref: chamada.ref,
        args: chamada.args,
        botId: chamada.agentId,
        actorId: chamada.actorId,
      };
      return gateway.execute({
        sessionId,
        specialistId: chamada.agentId,
        actor: { kind: "user", id: chamada.actorId, specialist: chamada.agentId },
        tool: "mcp.call",
        args,
        mcp,
      });
    },

    async decidirRender(chamada) {
      const sessionId = await sessaoDe(chamada.threadId, chamada.agentId);
      return gateway.execute({
        sessionId,
        specialistId: chamada.agentId,
        actor: { kind: "user", id: chamada.actorId, specialist: chamada.agentId },
        tool: "component.render",
        args: {
          name: chamada.name,
          agentId: chamada.agentId,
          actorId: chamada.actorId,
          functions: [...(chamada.functions ?? [])],
        },
      });
    },

    async lerDadosDeComponente(chamada) {
      const sessionId = await sessaoDe(chamada.threadId, chamada.agentId);
      return gateway.execute({
        sessionId,
        specialistId: chamada.agentId,
        actor: { kind: "user", id: chamada.actorId, specialist: chamada.agentId },
        tool: "component.data",
        args: {
          name: chamada.name,
          agentId: chamada.agentId,
          actorId: chamada.actorId,
          function: chamada.function ?? "",
          args: chamada.args ?? {},
        },
      });
    },

    pendentes(sessionId) {
      return gateway.pendingApprovals(sessionId);
    },
  };
}

/**
 * Traduz o desfecho do funil para o contrato HTTP das rotas de componente:
 * recusa do PORTÃO (deny/ask recusado) vira {allowed:false, reason}; saída do
 * executor volta como veio (ele já fala {allowed, …}); falha com o portão
 * aberto (leitura quebrada) é o 502 do contrato original.
 */
export function comoRespostaDeComponente(result: ActionResult):
  | { status: 200; body: unknown }
  | { status: 502; body: { allowed: true; error: string } } {
  if (result.ok) {
    try {
      return { status: 200, body: JSON.parse(result.output ?? "{}") };
    } catch {
      return { status: 502, body: { allowed: true, error: "That data could not be read." } };
    }
  }
  if (result.decision === "allow") {
    // O portão deixou passar e o efeito quebrou: falha, não recusa.
    return { status: 502, body: { allowed: true, error: "That data could not be read." } };
  }
  return {
    status: 200,
    body: { allowed: false, reason: result.error ?? "Refused by this deployment's gate." },
  };
}
