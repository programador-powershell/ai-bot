import { describe, expect, test } from "vitest";
import { Context } from "@aibot2/harness-kernel";
import * as browserRuntime from "@aibot2/plugin-browser-runtime";
import type { ExecutionTarget } from "@aibot2/plugin-browser-runtime";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  ActionRefusedError,
  createExecutionComputerGateway,
  HumanControlError,
  SessionUnknownError,
} from "../src/computer/execution-gateway";
import type { ActionPolicy } from "../src/computer/policy";

/**
 * A cirurgia §3 provada como PROPRIEDADES, contra o seam REAL (ctx.browser →
 * browser-runtime) com um agent-computer FALSO (fetch injetado). O que importa:
 *
 *  - o navegador NASCE no open da execução e MORRE no close — por runtimeId,
 *    NUNCA por botId; nenhum perfil permanente sobrevive (aceite literal);
 *  - Take the Wheel: com a pessoa no volante, a ação do bot é RECUSADA (não
 *    enfileirada) e vira linha própria de auditoria;
 *  - as três garantias portadas do gateway do openbot: recusa de política não
 *    chega ao computador, a linha é escrita nos dois casos, e o texto digitado
 *    nunca entra no payload.
 */

const TARGET: ExecutionTarget = {
  taskRunId: "run-t1-a1",
  workerId: "pc-02",
  leaseEpoch: 3,
  runtimeId: "rt-t1-a1",
};

const SNAPSHOT_ELEMENTS = [
  { ref: "e1", role: "input", name: "Customer name:" },
  { ref: "e9", role: "button", name: "Submit order" },
];

/**
 * O agent-computer roteirizado: registra tudo o que chegou (para "não chegou ao
 * computador" ser afirmável), guarda quem está com o volante por runtime, e
 * responde 409 humanHasControl no /act enquanto a pessoa segura — o mesmo
 * contrato do server.ts real.
 */
function fakeAgentComputer() {
  const acts: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const holder = new Map<string, "bot" | "human">();

  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    paths.push(path);
    const segments = path.split("/").filter(Boolean); // ["session", "<rt>", ...verb]
    const runtimeId = decodeURIComponent(segments[1] ?? "");
    const verb = segments.slice(2).join("/");
    const ok = (body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (verb === "open") return ok({ opened: true, alreadyOpen: false });
    if (verb === "close") return ok({ closed: true });
    if (verb === "navigate") {
      const body = JSON.parse(String(init.body ?? "{}")) as { url?: string };
      return ok({ url: body.url ?? "", title: "Página" });
    }
    if (verb === "snapshot") {
      return ok({
        snapshotId: 7,
        url: "https://example.com/order",
        title: "Order",
        elements: SNAPSHOT_ELEMENTS,
        truncated: false,
      });
    }
    if (verb === "control") return ok({ holder: holder.get(runtimeId) ?? "bot", since: "t", requested: false });
    if (verb === "control/take") {
      holder.set(runtimeId, "human");
      return ok({ holder: "human", since: "t", requested: false });
    }
    if (verb === "control/release") {
      holder.set(runtimeId, "bot");
      return ok({ holder: "bot", since: "t", requested: false });
    }
    if (verb === "act") {
      // Take the Wheel: enquanto o humano segura, o computador RECUSA (409) — a
      // ação não é enfileirada, é devolvida na hora.
      if (holder.get(runtimeId) === "human") {
        return new Response(
          JSON.stringify({ error: "Uma pessoa está no controle.", humanHasControl: true }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      acts.push(body);
      return ok({ action: body["kind"], url: "https://example.com/order" });
    }
    return new Response(JSON.stringify({ error: "rota desconhecida" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetchFn, acts, paths };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

const ACTOR = { id: "dev-local-user" };
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** Monta kernel + browser-runtime (fetch falso) + gateway. Devolve tudo o que os testes checam. */
function mount(policy: ActionPolicy | undefined, fetchFn: browserRuntime.Config["fetchFn"]) {
  const ctx = new Context();
  ctx.plugin(browserRuntime, {
    baseUrl: "http://127.0.0.1:9",
    token: "token-de-teste",
    ...(fetchFn !== undefined ? { fetchFn } : {}),
  });
  const { store, rows } = fakeAudit();
  const gateway = createExecutionComputerGateway({
    browser: ctx.browser,
    auditStore: store,
    policy: () => policy,
  });
  return { ctx, gateway, rows };
}

describe("o navegador task-scoped (nasce no open, morre no close)", () => {
  test("open abre a sessão POR runtimeId e grava session_opened — sem botId", async () => {
    const agent = fakeAgentComputer();
    const { gateway, rows } = mount(PERMISSIVE, agent.fetchFn);

    await gateway.open({ target: TARGET, requirements: { browser: true } });

    expect(agent.paths).toEqual(["/session/rt-t1-a1/open"]);
    // A chave é a execução: nenhum caminho carrega um botId nem um computador permanente.
    expect(agent.paths.every((path) => !/\/bot|botId/.test(path))).toBe(true);
    expect(gateway.sessions()).toEqual([
      { runtimeId: "rt-t1-a1", target: TARGET, subject: "run-t1-a1" },
    ]);
    expect(rows[0]?.eventType).toBe("computer.session_opened");
    expect(rows[0]?.payload.runtimeId).toBe("rt-t1-a1");
  });

  test("close fecha a sessão e grava session_closed — nenhum perfil sobrevive", async () => {
    const agent = fakeAgentComputer();
    const { gateway, rows } = mount(PERMISSIVE, agent.fetchFn);

    await gateway.open({ target: TARGET, requirements: { browser: true } });
    await gateway.close("rt-t1-a1");

    expect(agent.paths).toEqual(["/session/rt-t1-a1/open", "/session/rt-t1-a1/close"]);
    // Depois do close não resta sessão nenhuma — bot ocioso consome zero navegadores.
    expect(gateway.sessions()).toEqual([]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.session_opened",
      "computer.session_closed",
    ]);
  });

  test("o disposer do escopo da execução fecha o navegador DE VERDADE (fim da TaskRun)", async () => {
    const agent = fakeAgentComputer();
    const { ctx, gateway } = mount(PERMISSIVE, agent.fetchFn);

    // O escopo da TaskRun: o unload dele é o fim da tentativa.
    let taskCtx!: Context;
    const scope = ctx.plugin(function taskRun(child: Context) {
      taskCtx = child;
    });
    await scope;

    await gateway.open({ target: TARGET, requirements: { browser: true } }, taskCtx);
    expect(agent.paths).toContain("/session/rt-t1-a1/open");

    // Ninguém chama close: o fim do escopo fecha o contexto no computador.
    await scope.dispose();
    expect(agent.paths).toContain("/session/rt-t1-a1/close");
  });

  test("abrir exige requirements.browser=true — recusa antes de qualquer HTTP", async () => {
    const agent = fakeAgentComputer();
    const { gateway } = mount(PERMISSIVE, agent.fetchFn);
    // Sem o requisito declarado no plano, o browser-runtime recusa (spec §32).
    await expect(gateway.open({ target: TARGET })).rejects.toThrow();
    expect(agent.paths).toEqual([]);
  });

  test("agir num runtime não aberto é SessionUnknownError, não um browser inventado", async () => {
    const agent = fakeAgentComputer();
    const { gateway } = mount(PERMISSIVE, agent.fetchFn);
    await expect(gateway.snapshot("rt-fantasma")).rejects.toThrow(SessionUnknownError);
    expect(agent.paths).toEqual([]);
  });
});

describe("Take the Wheel (recusa, nunca enfileira)", () => {
  test("com a pessoa no volante a ação do bot é RECUSADA e vira linha própria", async () => {
    const agent = fakeAgentComputer();
    const { gateway, rows } = mount(PERMISSIVE, agent.fetchFn);
    await gateway.open({ target: TARGET, requirements: { browser: true } });
    await gateway.snapshot("rt-t1-a1");

    // Uma pessoa assume — o cartão que a UI mostra.
    await gateway.takeControl("rt-t1-a1", ACTOR);
    expect((await gateway.control("rt-t1-a1")).holder).toBe("human");

    // A ação do bot é recusada NA HORA (humanHasControl), não guardada.
    const refusal = await gateway
      .act("rt-t1-a1", ACTOR, { kind: "click", ref: "e9", snapshotId: 7 })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HumanControlError);

    // Nada foi enfileirado: o /act do computador nunca registrou o clique.
    expect(agent.acts).toEqual([]);
    // A recusa por humano é a própria linha (não action_refused de política).
    expect(rows.some((row) => row.eventType === "computer.action_blocked_by_human")).toBe(true);

    // Devolvido o volante, o bot volta a agir — a recusa não deixou fila.
    await gateway.releaseControl("rt-t1-a1", ACTOR);
    await gateway.act("rt-t1-a1", ACTOR, { kind: "click", ref: "e9", snapshotId: 7 });
    expect(agent.acts).toHaveLength(1);
  });

  test("take/release gravam o período do handover", async () => {
    const agent = fakeAgentComputer();
    const { gateway, rows } = mount(PERMISSIVE, agent.fetchFn);
    await gateway.open({ target: TARGET, requirements: { browser: true } });
    await gateway.takeControl("rt-t1-a1", ACTOR);
    await gateway.releaseControl("rt-t1-a1", ACTOR);
    const types = rows.map((row) => row.eventType);
    expect(types).toContain("computer.control_taken");
    expect(types).toContain("computer.control_released");
  });
});

describe("as garantias portadas do gateway do openbot", () => {
  async function opened(policy: ActionPolicy | undefined) {
    const agent = fakeAgentComputer();
    const mounted = mount(policy, agent.fetchFn);
    await mounted.gateway.open({ target: TARGET, requirements: { browser: true } });
    await mounted.gateway.snapshot("rt-t1-a1");
    return { ...mounted, agent };
  }

  test("uma ação permitida acontece e é gravada", async () => {
    const { gateway, rows, agent } = await opened(PERMISSIVE);
    await gateway.act("rt-t1-a1", ACTOR, { kind: "click", ref: "e9", snapshotId: 7 });
    expect(agent.acts).toHaveLength(1);
    expect(rows.some((row) => row.eventType === "computer.action_allowed")).toBe(true);
  });

  test("uma ação recusada NÃO chega ao computador", async () => {
    const { gateway, rows, agent } = await opened({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });
    await expect(
      gateway.act("rt-t1-a1", ACTOR, { kind: "click", ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);
    // A decisão acontece antes do efeito.
    expect(agent.acts).toEqual([]);
    expect(rows.at(-1)?.eventType).toBe("computer.action_refused");
  });

  test("a política vê o elemento que o SERVER resolveu, não o rótulo do chamador", async () => {
    const { gateway, agent } = await opened({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });
    await expect(
      gateway.act("rt-t1-a1", ACTOR, {
        kind: "click",
        ref: "e9",
        snapshotId: 7,
        // Fora do contrato e sem efeito nenhum, mesmo enviado.
        ...({ name: "Continuar" } as object),
      }),
    ).rejects.toThrow(ActionRefusedError);
    expect(agent.acts).toEqual([]);
  });

  test("política ausente recusa toda ação", async () => {
    const { gateway, rows, agent } = await opened(undefined);
    await expect(
      gateway.act("rt-t1-a1", ACTOR, { kind: "click", ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);
    expect(agent.acts).toEqual([]);
    expect(rows.at(-1)?.eventType).toBe("computer.action_refused");
  });

  test("o texto digitado NUNCA entra no payload da auditoria", async () => {
    const { gateway, rows } = await opened(PERMISSIVE);
    await gateway.act("rt-t1-a1", ACTOR, {
      kind: "type",
      ref: "e1",
      snapshotId: 7,
      text: "hunter2-nao-e-senha-de-verdade",
    });
    const typed = rows.find((row) => row.payload.action === "computer_type");
    expect(JSON.stringify(typed?.payload)).not.toContain("hunter2");
    expect(typed?.payload.element).toEqual({ role: "input", name: "Customer name:" });
  });

  test("uma navegação é decidida pelo DESTINO, não pela página carregada", async () => {
    const { gateway, agent } = await opened({
      ...PERMISSIVE,
      deny: ['page.host == "intranet.example.com"'],
    });
    await expect(
      gateway.navigate("rt-t1-a1", ACTOR, "https://intranet.example.com/hr"),
    ).rejects.toThrow(ActionRefusedError);
    await gateway.navigate("rt-t1-a1", ACTOR, "https://example.com/");
    expect(agent.paths).toContain("/session/rt-t1-a1/navigate");
  });

  test("uma ação permitida que FALHA ganha a própria linha, não uma de permitida", async () => {
    // Um /act que estoura no computador (não por humano) é action_failed, depois
    // da action_allowed — a trilha não implica que o efeito aconteceu.
    const agent = fakeAgentComputer();
    const explode: typeof agent.fetchFn = async (url, init) => {
      if (new URL(url).pathname.endsWith("/act")) {
        return new Response(JSON.stringify({ error: "o computador caiu" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return agent.fetchFn(url, init);
    };
    const { store, rows } = fakeAudit();
    const ctx = new Context();
    ctx.plugin(browserRuntime, { baseUrl: "http://127.0.0.1:9", token: "t", fetchFn: explode });
    const gateway = createExecutionComputerGateway({
      browser: ctx.browser,
      auditStore: store,
      policy: () => PERMISSIVE,
    });
    await gateway.open({ target: TARGET, requirements: { browser: true } });
    await gateway.snapshot("rt-t1-a1");

    await expect(
      gateway.act("rt-t1-a1", ACTOR, { kind: "click", ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow();

    const actionRows = rows.filter((row) => String(row.eventType).startsWith("computer.action"));
    expect(actionRows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_failed",
    ]);
  });
});
