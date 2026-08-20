/**
 * [Onda 3] O executor de ferramentas do CHASSIS — o que o funil (action-
 * gateway) chama DEPOIS que o portão decidiu e a auditoria durável foi
 * escrita. Só o funil segura este objeto: entregá-lo a mais alguém na
 * montagem é abrir a porta lateral que o pacote do funil existe para fechar
 * ("nenhum efeito por fora").
 *
 * Três ferramentas intermediadas, e o resto recusa com o motivo:
 *
 *  - `mcp.call`          → pluginStore.callTool (grant por especialista +
 *                          política + not_granted auditado + rede);
 *  - `component.render`  → a decisão POR RENDER (grant do componente + das
 *                          data functions que ele nomeia);
 *  - `component.data`    → a leitura de dados de um componente (grant + run).
 *
 * As recusas de GRANT voltam DENTRO do JSON de saída ({allowed:false,reason})
 * em vez de exceção: recusa de grant é uma decisão do deployment, não uma
 * falha — e o funil grava tool.result ok com o veredito legível, exatamente o
 * que a trilha precisa. Exceção fica para o que quebrou de verdade (rede,
 * leitura de dados) — o funil a transforma em tool.result de erro.
 */

import { recordAuditEvent, type AuditStore } from "../audit";
import { dataFunction } from "../components/functions";
import type { ComponentStore } from "../components/store";
import { PluginRefusedError, type PluginStore } from "../plugins/store";
import type { ToolExecutor } from "@aibot2/plugin-action-gateway";

/** As ferramentas que o chassis intermedeia — o catálogo dos Bots do chassis no Gate. */
export const CHASSIS_BOT_TOOLS: readonly string[] = [
  "mcp.call",
  "component.render",
  "component.data",
];

export interface DepsDoExecutor {
  pluginStore: PluginStore;
  componentStore: ComponentStore;
  auditStore: AuditStore;
}

/** O objeto que cruza um campo obrigatório ausente — engano de chamador faz barulho. */
function exigirTexto(args: Record<string, unknown>, campo: string): string {
  const valor = args[campo];
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new Error(`executor do chassis: faltou o campo "${campo}" nos argumentos`);
  }
  return valor;
}

function comoObjeto(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("executor do chassis: argumentos precisam ser um objeto");
  }
  return args as Record<string, unknown>;
}

export function criarExecutorDoChassi(deps: DepsDoExecutor): ToolExecutor {
  const { pluginStore, componentStore, auditStore } = deps;

  /** A recusa de grant como SAÍDA estruturada (o contrato das rotas de componente). */
  const recusa = (reason: string) => JSON.stringify({ allowed: false, reason });

  async function chamarMcp(args: Record<string, unknown>): Promise<string> {
    const ref = exigirTexto(args, "ref");
    const botId = exigirTexto(args, "botId");
    const actorId = exigirTexto(args, "actorId");
    const corpo =
      args["args"] !== null && typeof args["args"] === "object" && !Array.isArray(args["args"])
        ? (args["args"] as Record<string, unknown>)
        : {};
    try {
      // O grant, a política relida e o not_granted auditado moram DENTRO do
      // store — o funil acrescenta os envelopes duráveis e a decisão humana.
      const result = await pluginStore.callTool({ ref, args: corpo, botId, actorId });
      return JSON.stringify({ text: result.text, isError: result.isError });
    } catch (error) {
      if (error instanceof PluginRefusedError) {
        // Recusa de grant/política do chassis: decisão, não falha — vira o
        // JSON de recusa que a rota devolve como 403 legível.
        return recusa(error.message);
      }
      throw error;
    }
  }

  /** A decisão POR RENDER: o componente e cada data function que ele nomeia. */
  async function decidirRender(args: Record<string, unknown>): Promise<string> {
    const name = exigirTexto(args, "name");
    const agentId = exigirTexto(args, "agentId");
    const actorId = exigirTexto(args, "actorId");
    const functions = Array.isArray(args["functions"])
      ? (args["functions"] as unknown[]).filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];

    const decision = await componentStore.decide(name, agentId);
    if (!decision.allowed) {
      await recordAuditEvent(auditStore, {
        eventType: "component.refused",
        targetType: "component",
        targetId: name,
        payload: { actor: actorId, bot: agentId, reason: decision.reason },
      });
      return recusa(decision.reason);
    }
    for (const functionName of functions) {
      if (await componentStore.mayCall(name, functionName)) continue;
      const reason = `${name} has not been granted the function ${functionName}. An administrator grants each function to each component.`;
      await recordAuditEvent(auditStore, {
        eventType: "component.function_refused",
        targetType: "component",
        targetId: name,
        payload: { actor: actorId, bot: agentId, function: functionName, reason },
      });
      return recusa(reason);
    }
    return JSON.stringify({ allowed: true });
  }

  /** A leitura de dados de um componente — o efeito de verdade do render. */
  async function lerDados(args: Record<string, unknown>): Promise<string> {
    const name = exigirTexto(args, "name");
    const agentId = exigirTexto(args, "agentId");
    const actorId = exigirTexto(args, "actorId");
    const functionName = exigirTexto(args, "function");
    const corpo =
      args["args"] !== null && typeof args["args"] === "object" && !Array.isArray(args["args"])
        ? (args["args"] as Record<string, unknown>)
        : {};

    const refuse = async (reason: string) => {
      await recordAuditEvent(auditStore, {
        eventType: "component.function_refused",
        targetType: "component",
        targetId: name,
        payload: { actor: actorId, bot: agentId, function: functionName, reason },
      });
      return recusa(reason);
    };

    // O componente primeiro: um componente que este Bot não pode usar não lê
    // em nome dele — a mesma ordem da rota original.
    const decision = await componentStore.decide(name, agentId);
    if (!decision.allowed) return refuse(decision.reason);

    const fn = dataFunction(functionName);
    if (!fn) {
      return refuse(`There is no data function called ${functionName} in this deployment.`);
    }
    if (!(await componentStore.mayCall(name, functionName))) {
      return refuse(
        `${name} has not been granted the function ${functionName}. An administrator grants each function to each component.`,
      );
    }

    try {
      const data = await componentStore.callFunction(functionName, corpo);
      await recordAuditEvent(auditStore, {
        eventType: "component.function_called",
        targetType: "component",
        targetId: name,
        payload: { actor: actorId, bot: agentId, function: functionName, reads: fn.reads },
      });
      return JSON.stringify({ allowed: true, data });
    } catch (error) {
      // Leitura quebrada não é recusa e não pode ser lida como uma: registra
      // como falha e SOBE — o funil grava tool.result de erro e a rota devolve
      // o 502 do contrato original.
      await recordAuditEvent(auditStore, {
        eventType: "component.function_failed",
        targetType: "component",
        targetId: name,
        payload: {
          actor: actorId,
          bot: agentId,
          function: functionName,
          failure: error instanceof Error ? error.message : "The read failed.",
        },
      });
      throw error instanceof Error ? error : new Error("The read failed.");
    }
  }

  return {
    async call(_sessionId: string, tool: string, args: unknown): Promise<string> {
      const corpo = comoObjeto(args);
      switch (tool) {
        case "mcp.call":
          return chamarMcp(corpo);
        case "component.render":
          return decidirRender(corpo);
        case "component.data":
          return lerDados(corpo);
        default:
          // Ferramenta nativa (fs/git/proc) ainda não portada para o chassis —
          // dívida declarada; o funil já decidiu e registrou, o efeito não roda.
          throw new Error(
            `a ferramenta ${tool} não é intermediada pelo chassis — só ${CHASSIS_BOT_TOOLS.join(", ")} têm executor nesta montagem`,
          );
      }
    },
  };
}
