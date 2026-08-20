import type { AbstractAgent } from "@ag-ui/client";

/**
 * [Onda 2 — a morte anunciada na onda 1] O que o copilot.ts fazia de HISTÓRIA
 * morreu aqui: `mountCopilotRuntime` (CopilotRuntime + Intelligence + handler
 * Hono), o mapa de agentes por request e o BuiltInAgent saíram junto com a
 * dependência `@copilotkit/runtime` — a conversa É o nosso event log
 * (channels/conversa.ts + o stream servido pelo chassis, R3/§4.6), e um
 * runtime de chat paralelo seria a segunda verdade que o R3 existe para
 * impedir.
 *
 * O que FICA são os fatos duráveis sobre coworkers que o resto do server já
 * consome (agents/runtime-agents.ts): a normalização de linhas do registro em
 * `RegisteredAgent` e a mensagem de papel permanente que um bot EXTERNO recebe
 * por AG-UI. Decisão registrada desta onda (plano §4.6): `@ag-ui/*` PERMANECE
 * como protocolo de bots externos — agents/connection-test.ts fala AG-UI com
 * endpoints de terceiros e isso não tem relação com o Intelligence.
 */

type RegisteredBuiltInAgent = {
  id: string;
  name: string;
  type: "built_in";
  systemPrompt: string;
};

type RegisteredRemoteAgent = {
  id: string;
  name: string;
  type: "remote_ag_ui";
  endpoint: string;
  standingMessage: StandingRoleMessage;
  /** The key this agent sits behind, resolved from the vault at load time. Never logged. */
  headers?: Record<string, string>;
};

/**
 * A coworker the caller may see but may not run: its profile was deleted while a channel it worked
 * in still exists. Every run is refused without contacting the endpoint.
 */
type RegisteredUnavailableAgent = {
  id: string;
  name: string;
  type: "unavailable";
  reason: string;
};

export type RegisteredAgent =
  | RegisteredBuiltInAgent
  | RegisteredRemoteAgent
  | RegisteredUnavailableAgent;

type AgentRunInput = Parameters<AbstractAgent["run"]>[0];
type AgentMessage = AgentRunInput["messages"][number];
export type StandingRoleMessage = Extract<AgentMessage, { role: "system" }>;

/** The durable part of a coworker: who it is and what its standing job is. */
export type AgentStandingProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
};

/**
 * The coworker's job, as one system message.
 *
 * It is an ordinary AG-UI system message rather than framework-specific state
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server, and
 * a system message is the only thing all of them already understand. The id is derived from the
 * agent so a run can recognise a copy of it and refuse to send a second.
 */
export function standingRoleMessage(
  profile: AgentStandingProfile,
): StandingRoleMessage {
  return {
    id: `standing-role:${profile.id}`,
    role: "system",
    content: [
      `You are ${profile.name}, ${profile.title}.`,
      profile.roleDescription,
      "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
    ].join("\n\n"),
  };
}

type RuntimeAgentRow = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui";
  configuration: unknown;
  title: string;
  roleDescription: string;
};

export function registeredAgentFromRow(
  row: RuntimeAgentRow,
): RegisteredAgent | null {
  if (!isPlainObject(row.configuration)) {
    return null;
  }
  const configuration = row.configuration;
  if (row.type === "built_in") {
    const systemPrompt = configuration?.systemPrompt;
    const trimmedSystemPrompt =
      typeof systemPrompt === "string" ? systemPrompt.trim() : "";
    return trimmedSystemPrompt.length > 0
      ? {
          id: row.id,
          name: row.name,
          type: "built_in",
          systemPrompt: trimmedSystemPrompt,
        }
      : null;
  }

  const endpoint = configuration?.endpoint;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: "remote_ag_ui",
        endpoint,
        standingMessage: standingRoleMessage(row),
      }
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
