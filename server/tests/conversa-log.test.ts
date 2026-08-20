/**
 * [Onda 2] CHANNELS = EVENT LOG: a conversa das threads é o log de envelopes
 * (@aibot2/domain-events) atrás do session bus — o chassis.db não guarda uma
 * linha de conteúdo. Cobre as três pontas do contrato:
 *
 *  - ESCRITA: um `prompt` chegando pelo transporte vira envelope `message`
 *    durável, numerado pelo store e replayável;
 *  - LEITURA: a superfície renderiza do REPLAY (mensagens projetadas do log,
 *    fixtures do oráculo por valor);
 *  - ROTA: GET /api/threads/:threadId/messages atrás do session guard, com a
 *    garantia get-or-create que deixa o hello reabrir a MESMA sessão.
 */

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventStore, type StorageDriver } from "@aibot2/domain-events";
import { SessionBus } from "@aibot2/harness-openbot-bridge";
import { semearSessaoDeFixture } from "@aibot2/harness-openbot-bridge/teste-fixtures";

import { createDevRequireUser } from "../src/auth/dev-actor";
import type { AppVariables } from "../src/auth/guards";
import { criarConversaDoCanal } from "../src/channels/conversa";
import { createThreadRoutes } from "../src/channels/thread-routes";
import { createThreadIdentity } from "../src/channels/thread-identity";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function montarConversa() {
  const store: StorageDriver = SqliteEventStore.open(":memory:");
  cleanups.push(() => store.close());
  const bus = new SessionBus(store);
  return { store, bus, conversa: criarConversaDoCanal(store, bus) };
}

describe("a conversa do canal É o event log", () => {
  it("um prompt do transporte vira envelope message durável — gravado, numerado e replayável", async () => {
    const { store, conversa } = montarConversa();
    await conversa.garantirSessao("thread-1", "Canal de teste");

    await conversa.receberDoTransporte("thread-1", {
      kind: "prompt",
      payload: { text: "Guarde no log o que eu disse." },
    });

    // A verdade está no STORE, não num estado paralelo: o replay devolve a
    // linha com seq atribuído pelo log.
    const envelopes = await store.since("thread-1", 0);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      seq: 1,
      kind: "message",
      from: { kind: "user" },
      payload: { role: "user", text: "Guarde no log o que eu disse." },
    });
    // O turno nasce no prompt (a resposta da onda 3 agrupa por ele).
    expect(typeof envelopes[0]?.turn).toBe("string");

    // E a projeção da superfície lê exatamente do replay.
    const mensagens = await conversa.mensagens("thread-1");
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ role: "user", text: "Guarde no log o que eu disse.", seq: 1 });
  });

  it("verbos que não são prompt são ignorados sem fingir tratamento (o funil é da onda 3)", async () => {
    const { store, conversa } = montarConversa();
    await conversa.garantirSessao("thread-2");
    await conversa.receberDoTransporte("thread-2", { kind: "approval.decision", payload: {} });
    await conversa.receberDoTransporte("thread-2", { kind: "prompt", payload: { text: "   " } });
    expect(await store.since("thread-2", 0)).toHaveLength(0);
  });

  it("a projeção renderiza a MESMA sessão gravada do oráculo Go (fixtures por valor)", async () => {
    const { store, conversa } = montarConversa();
    const meta = await semearSessaoDeFixture(store, "chat-simples");

    const mensagens = await conversa.mensagens(meta.id);
    // O log da fixture tem 4 envelopes: message(user), route, message(assistant), done —
    // a superfície desenha as DUAS mensagens, na ordem do log, com o texto intacto.
    expect(mensagens).toHaveLength(2);
    expect(mensagens[0]).toMatchObject({
      role: "user",
      text: "Explique em uma frase o que é um WebSocket.",
      seq: 1,
    });
    expect(mensagens[1]?.role).toBe("assistant");
    expect(mensagens[1]?.text).toContain("Resposta de mentira");
    expect(mensagens[1]?.specialist).toBe("chat");
  });

  it("garantirSessao é get-or-create idempotente — a corrida de duas criações não explode", async () => {
    const { conversa } = montarConversa();
    const [primeira, segunda] = await Promise.all([
      conversa.garantirSessao("thread-corrida", "título"),
      conversa.garantirSessao("thread-corrida", "título"),
    ]);
    expect(primeira.id).toBe("thread-corrida");
    expect(segunda.id).toBe("thread-corrida");
  });
});

describe("GET /api/threads/:threadId/messages (a superfície lê do replay)", () => {
  function montarRotas() {
    const { store, bus, conversa } = montarConversa();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/threads",
      createThreadRoutes(createThreadIdentity("teste"), createDevRequireUser(), conversa),
    );
    return { app, store, bus, conversa };
  }

  it("devolve as mensagens projetadas do log e GARANTE a sessão na primeira leitura", async () => {
    const { app, store } = montarRotas();

    // Primeira leitura de uma thread nova: vazia, mas a sessão agora EXISTE —
    // é o que permite ao hello com sessionHint reabrir a mesma conversa.
    const vazia = await app.request("http://local/api/threads/thread-nova/messages");
    expect(vazia.status).toBe(200);
    await expect(vazia.json()).resolves.toEqual({ messages: [] });
    await expect(store.getSession("thread-nova")).resolves.toMatchObject({ id: "thread-nova" });

    // O que entra pelo bus aparece na leitura seguinte.
    const bus = new SessionBus(store);
    await bus.publish("thread-nova", {
      id: "e-1",
      kind: "message",
      from: { kind: "user" },
      payload: { role: "user", text: "olá pelo log" },
    });
    const cheia = await app.request("http://local/api/threads/thread-nova/messages");
    const corpo = (await cheia.json()) as { messages: Array<{ text: string }> };
    expect(corpo.messages).toHaveLength(1);
    expect(corpo.messages[0]?.text).toBe("olá pelo log");
  });
});
