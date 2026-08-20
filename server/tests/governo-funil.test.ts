/**
 * [Onda 3] O TESTE-ESPELHO do governo unificado, nas rotas do CHASSIS:
 * "efeito sem decisão do portão não executa" — cobrindo a rota MCP
 * (/api/plugins/call) e o render de componente (/api/components/:name/…),
 * que agora entram pelo action-gateway (funil) montado no kernel.
 *
 * Os espiões são o efeito: a chamada de rede do MCP e a leitura de dados do
 * componente só podem acontecer DEPOIS do veredito do Gate — e a prova é a
 * contagem de chamadas deles, não a resposta HTTP.
 */

import { afterEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { Context } from "@aibot2/harness-kernel";
import { SqliteEventStore, type Envelope } from "@aibot2/domain-events";
import { SessionBus } from "@aibot2/harness-openbot-bridge";
import { ActionGatewayService } from "@aibot2/plugin-action-gateway";
import { SpecialistRegistry } from "@aibot2/specialist-registry";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { criarConversaDoCanal } from "../src/channels/conversa";
import { createComponentRoutes } from "../src/components/routes";
import type { ComponentStore } from "../src/components/store";
import { CHASSIS_BOT_TOOLS, criarExecutorDoChassi } from "../src/governo/executor";
import { criarFunilDoChassi } from "../src/governo/funil";
import { createEnvelopeAuditRoutes } from "../src/governo/rotas-auditoria";
import { diretorioDoRegistry } from "../src/montagem/seams";
import { createPluginRoutes } from "../src/plugins/routes";
import { PluginRefusedError, type PluginStore } from "../src/plugins/store";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const asSignedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "u1", email: "someone@openbot.test" });
  return next();
};

/** O espião do efeito MCP: a ida à rede de outra empresa. */
function fakePluginStore(options?: {
  effect?: "read" | "write";
  refuse?: string;
}) {
  const calls: { ref: string; args: Record<string, unknown> }[] = [];
  const store = {
    async classify(ref: string) {
      const [server = "", ...rest] = ref.split("/");
      return { server, tool: rest.join("/"), effect: options?.effect ?? "write" };
    },
    async callTool(input: { ref: string; args: Record<string, unknown> }) {
      if (options?.refuse) {
        throw new PluginRefusedError(options.refuse, null);
      }
      calls.push({ ref: input.ref, args: input.args });
      return { text: "42 issues", isError: false };
    },
  } as unknown as PluginStore;
  return { store, calls };
}

/** O espião do efeito de componente: a leitura de dados do deployment. */
function fakeComponentStore(options?: { granted?: boolean; mayCall?: boolean }) {
  const decisions: string[] = [];
  const reads: string[] = [];
  const store = {
    async decide(name: string) {
      decisions.push(name);
      return options?.granted === false
        ? { allowed: false as const, reason: "This Bot does not hold it." }
        : { allowed: true as const, description: "Published." };
    },
    async mayCall() {
      return options?.mayCall !== false;
    },
    async callFunction(functionName: string) {
      reads.push(functionName);
      return { rows: [] };
    },
  } as unknown as ComponentStore;
  return { store, decisions, reads };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

interface RigOptions {
  policy?: unknown;
  approvalTimeoutMs?: number;
  mcpEffect?: "read" | "write";
  mcpRefuse?: string;
  componentGranted?: boolean;
  componentMayCall?: boolean;
}

/** O rig: kernel mínimo (registry + funil) + as DUAS rotas atrás dele. */
async function rig(options?: RigOptions) {
  const eventLog = SqliteEventStore.open(":memory:");
  cleanups.push(() => eventLog.close());
  const ctx = new Context();
  const registry = new SpecialistRegistry(ctx);
  const mcp = fakePluginStore({
    ...(options?.mcpEffect ? { effect: options.mcpEffect } : {}),
    ...(options?.mcpRefuse ? { refuse: options.mcpRefuse } : {}),
  });
  const componente = fakeComponentStore({
    ...(options?.componentGranted !== undefined ? { granted: options.componentGranted } : {}),
    ...(options?.componentMayCall !== undefined ? { mayCall: options.componentMayCall } : {}),
  });
  const audit = fakeAudit();
  const gateway = new ActionGatewayService(ctx, {
    store: eventLog,
    tools: criarExecutorDoChassi({
      pluginStore: mcp.store,
      componentStore: componente.store,
      auditStore: audit.store,
    }),
    directory: diretorioDoRegistry(registry, CHASSIS_BOT_TOOLS),
    approvalTimeoutMs: options?.approvalTimeoutMs ?? 80,
    ...(options?.policy !== undefined ? { policy: options.policy } : {}),
  });
  const conversa = criarConversaDoCanal(eventLog, new SessionBus(eventLog));
  const funil = criarFunilDoChassi({ gateway, conversa, pluginStore: mcp.store });
  const app = new Hono()
    .route("/plugins", createPluginRoutes(mcp.store, asSignedIn, funil))
    .route(
      "/components",
      createComponentRoutes(componente.store, asSignedIn, audit.store, funil),
    );
  return { app, gateway, eventLog, mcp, componente, audit };
}

async function post(app: Hono, url: string, body: Record<string, unknown>) {
  const response = await app.request(`http://chassi.local${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function envelopes(store: SqliteEventStore, sessionId: string): Promise<Envelope[]> {
  return store.since(sessionId, 0, 500);
}

describe("teste-espelho: efeito sem decisão do portão não executa — rota MCP", () => {
  test("escrita MCP sem ninguém decidindo o ask é RECUSADA e a rede nunca é tocada", async () => {
    // Efeito desconhecido = escrita (unknown=write) e a política padrão é
    // "aprovar edições": escrita PERGUNTA — e sem resposta dentro do prazo, o
    // silêncio recusa. O espião prova que o efeito nunca aconteceu.
    const r = await rig({ mcpEffect: "write", approvalTimeoutMs: 80 });
    const resposta = await post(r.app, "/plugins/call", {
      ref: "jira/editJiraIssue",
      args: { issue: "DSV-1" },
      agentId: "bot-do-chassi",
    });
    expect(resposta.status).toBe(403);
    expect(r.mcp.calls).toHaveLength(0);

    // A trilha durável mostra o caminho inteiro: pedido, pergunta, recusa.
    const trail = await envelopes(r.eventLog, "governo-bot-do-chassi");
    expect(trail.map((e) => e.kind)).toEqual([
      "tool.call",
      "approval.request",
      "tool.result",
    ]);
    expect((trail[2]!.payload as { ok: boolean }).ok).toBe(false);
  });

  test("leitura MCP anunciada pelo catálogo revisado passa sem pergunta e executa", async () => {
    const r = await rig({ mcpEffect: "read" });
    const resposta = await post(r.app, "/plugins/call", {
      ref: "jira/searchJiraIssuesUsingJql",
      args: { jql: "project = DSV" },
      agentId: "bot-do-chassi",
    });
    expect(resposta.status).toBe(200);
    expect(resposta.body).toEqual({ text: "42 issues", isError: false });
    expect(r.mcp.calls).toHaveLength(1);
    // E deixou os DOIS envelopes — o efeito só existe com registro.
    const kinds = (await envelopes(r.eventLog, "governo-bot-do-chassi")).map((e) => e.kind);
    expect(kinds).toEqual(["tool.call", "tool.result"]);
  });

  test("deniedTools da política declarada recusa mcp.call antes de qualquer grant", async () => {
    const r = await rig({ policy: { mode: "all", deniedTools: ["mcp.call"] } });
    const resposta = await post(r.app, "/plugins/call", {
      ref: "jira/searchJiraIssuesUsingJql",
      args: {},
      agentId: "bot-do-chassi",
    });
    expect(resposta.status).toBe(403);
    expect(r.mcp.calls).toHaveLength(0);
  });

  test("aprovada pela pessoa, a MESMA chamada executa — a decisão viaja pelo funil", async () => {
    const r = await rig({ mcpEffect: "write", approvalTimeoutMs: 5000 });
    const emVoo = post(r.app, "/plugins/call", {
      ref: "jira/editJiraIssue",
      args: { issue: "DSV-1" },
      agentId: "bot-do-chassi",
    });
    // O cartão pendente é reconstruível do log (é o que a UI redesenha)…
    // A sessão de governo nasce DENTRO da chamada em voo, então a sondagem
    // tolera "sessão ainda não existe" — é corrida de teste, não defeito.
    const pendente = await (async () => {
      for (;;) {
        const lista = await r.gateway
          .pendingApprovals("governo-bot-do-chassi")
          .catch(() => []);
        if (lista[0]) return lista[0];
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    // …e a decisão da pessoa libera a execução.
    r.gateway.decide({ callId: pendente.request.callId, allow: true, scope: "once" });
    const resposta = await emVoo;
    expect(resposta.status).toBe(200);
    expect(r.mcp.calls).toHaveLength(1);
  });

  test("not_granted do chassis volta como recusa legível — e não como falha de servidor", async () => {
    const r = await rig({
      mcpEffect: "read",
      mcpRefuse: "This Bot has not been given the tool jira/editJiraIssue.",
    });
    const resposta = await post(r.app, "/plugins/call", {
      ref: "jira/editJiraIssue",
      args: {},
      agentId: "bot-do-chassi",
    });
    expect(resposta.status).toBe(403);
    expect(String(resposta.body["error"])).toContain("has not been given");
    expect(r.mcp.calls).toHaveLength(0);
  });
});

describe("teste-espelho: efeito sem decisão do portão não executa — render de componente", () => {
  test("render negado pela política declarada nem chega ao store de grants", async () => {
    const r = await rig({ policy: { mode: "all", toolRules: { "component.render": "deny" } } });
    const resposta = await post(r.app, "/components/showActivityReport/decision", {
      agentId: "bot-do-chassi",
    });
    expect(resposta.status).toBe(200);
    expect(resposta.body["allowed"]).toBe(false);
    // O portão recusou ANTES do efeito: a decisão de grant nunca rodou.
    expect(r.componente.decisions).toHaveLength(0);
  });

  test("render permitido pelo portão ainda respeita o grant do componente — decisão POR CHAMADA", async () => {
    const r = await rig({ componentGranted: false });
    const resposta = await post(r.app, "/components/showActivityReport/decision", {
      agentId: "bot-do-chassi",
    });
    expect(resposta.status).toBe(200);
    expect(resposta.body["allowed"]).toBe(false);
    expect(r.componente.decisions).toEqual(["showActivityReport"]);
    // A recusa de grant ficou na trilha relacional (component.refused).
    expect(r.audit.rows.map((row) => row.eventType)).toContain("component.refused");
  });

  test("a leitura de dados só roda com portão E grants abertos — e deixa envelopes", async () => {
    const r = await rig();
    const resposta = await post(r.app, "/components/showActivityReport/call", {
      agentId: "bot-do-chassi",
      function: "recentRefusals",
      args: { limit: 5 },
    });
    expect(resposta.status).toBe(200);
    expect(resposta.body["allowed"]).toBe(true);
    expect(r.componente.reads).toEqual(["recentRefusals"]);
    const kinds = (await envelopes(r.eventLog, "governo-bot-do-chassi")).map((e) => e.kind);
    expect(kinds).toEqual(["tool.call", "tool.result"]);
  });

  test("a leitura negada pelo portão não executa a data function", async () => {
    const r = await rig({ policy: { mode: "all", toolRules: { "component.data": "deny" } } });
    const resposta = await post(r.app, "/components/showActivityReport/call", {
      agentId: "bot-do-chassi",
      function: "recentRefusals",
    });
    expect(resposta.status).toBe(200);
    expect(resposta.body["allowed"]).toBe(false);
    expect(r.componente.reads).toHaveLength(0);
  });

  test("função sem grant recusa DENTRO do funil e audita function_refused", async () => {
    const r = await rig({ componentMayCall: false });
    const resposta = await post(r.app, "/components/showActivityReport/call", {
      agentId: "bot-do-chassi",
      function: "recentRefusals",
    });
    expect(resposta.status).toBe(200);
    expect(resposta.body["allowed"]).toBe(false);
    expect(r.componente.reads).toHaveLength(0);
    expect(r.audit.rows.map((row) => row.eventType)).toContain(
      "component.function_refused",
    );
  });
});

/**
 * [Onda 3] As rotas de LEITURA de auditoria sobre os envelopes (plano §5):
 * admin-only, recorte nos kinds de auditoria, payload redigido pela mesma
 * régua da trilha relacional, e as pendências vivas por sessão.
 */
describe("rotas de auditoria sobre os envelopes", () => {
  const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "u1",
      email: "admin@openbot.test",
      role: "admin",
    } as AppVariables["actor"]);
    return next();
  };

  test("a trilha de uma sessão sai recortada em kinds de auditoria e com segredo redigido", async () => {
    const r = await rig({ mcpEffect: "read" });
    // Uma chamada real deixa tool.call + tool.result no log de governo…
    await post(r.app, "/plugins/call", {
      ref: "jira/search",
      args: { jql: "project = DSV", api_key: "nao-pode-vazar" },
      agentId: "bot-x",
    });
    const rotas = new Hono().route(
      "/envelopes",
      createEnvelopeAuditRoutes(
        {
          store: r.eventLog,
          pendentes: (sessionId) => r.gateway.pendingApprovals(sessionId),
        },
        asAdmin,
      ),
    );

    const indice = await rotas.request("http://chassi.local/envelopes");
    const sessoes = (await indice.json()) as { sessions: { id: string }[] };
    expect(sessoes.sessions.map((s) => s.id)).toContain("governo-bot-x");

    const resposta = await rotas.request(
      "http://chassi.local/envelopes/governo-bot-x",
    );
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      envelopes: { kind: string; payload: unknown }[];
      exhausted: boolean;
    };
    expect(corpo.envelopes.map((e) => e.kind)).toEqual(["tool.call", "tool.result"]);
    expect(corpo.exhausted).toBe(true);
    // A chave sensível dos argumentos saiu REDIGIDA — a mesma régua da trilha.
    const texto = JSON.stringify(corpo.envelopes);
    expect(texto).not.toContain("nao-pode-vazar");
    expect(texto).toContain("[REDACTED]");

    const pendentes = await rotas.request(
      "http://chassi.local/envelopes/governo-bot-x/pendentes",
    );
    expect(((await pendentes.json()) as { pending: unknown[] }).pending).toEqual([]);
  });

  test("sem papel de admin, as rotas recusam — auditoria não é leitura de qualquer sessão logada", async () => {
    const r = await rig();
    const rotas = new Hono().route(
      "/envelopes",
      createEnvelopeAuditRoutes(
        {
          store: r.eventLog,
          pendentes: (sessionId) => r.gateway.pendingApprovals(sessionId),
        },
        asSignedIn,
      ),
    );
    const resposta = await rotas.request("http://chassi.local/envelopes");
    expect(resposta.status).toBe(403);
  });

  test("sessão que não existe é 404 dito, não stack de servidor", async () => {
    const r = await rig();
    const rotas = new Hono().route(
      "/envelopes",
      createEnvelopeAuditRoutes(
        {
          store: r.eventLog,
          pendentes: (sessionId) => r.gateway.pendingApprovals(sessionId),
        },
        asAdmin,
      ),
    );
    const resposta = await rotas.request("http://chassi.local/envelopes/nao-existe");
    expect(resposta.status).toBe(404);
  });
});
