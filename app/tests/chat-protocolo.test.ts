/**
 * [Onda 2] A projeção da conversa a partir do REPLAY do log — a metade do app
 * na compat dupla: o chassis prova que serve os MESMOS frames do oráculo Go
 * (server/tests/stream-compat.test.ts, por valor); aqui se prova que o app
 * forkado RENDERIZA a mesma sessão a partir desses frames — as fixtures são o
 * elo: o mesmo log.jsonl, por valor, nas duas pontas.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  aplicarEnvelope,
  CONVERSA_VAZIA,
  projetarReplay,
  type Envelope,
} from "@/lib/chat/protocolo";

function lerLog(pasta: string): Envelope[] {
  // Por process.cwd() (a raiz do repo, onde o vitest roda) e não por
  // import.meta.url: sob happy-dom a URL do módulo é http://, e file-URL
  // relativa a ela explode.
  const caminho = join(process.cwd(), "test-fixtures", "sessions", pasta, "log.jsonl");
  return readFileSync(caminho, "utf8")
    .split(/\r?\n/)
    .filter((linha) => linha.trim() !== "")
    .map((linha) => JSON.parse(linha) as Envelope);
}

describe("compat dupla — o app renderiza a MESMA sessão gravada do oráculo", () => {
  it("o replay de chat-simples projeta as duas mensagens, por valor", () => {
    const estado = projetarReplay(lerLog("chat-simples"));

    expect(estado.mensagens).toHaveLength(2);
    expect(estado.mensagens[0]).toMatchObject({
      role: "user",
      text: "Explique em uma frase o que é um WebSocket.",
    });
    expect(estado.mensagens[1]?.role).toBe("assistant");
    // O texto vem INTEIRO do log — markdown, cerca de código e acentos
    // intactos (o mesmo valor que o desktop desenha).
    expect(estado.mensagens[1]?.text).toContain("## Resposta de mentira");
    expect(estado.mensagens[1]?.text).toContain("ação, ünïcödé, 日本語");
    expect(estado.mensagens[1]?.specialist).toBe("chat");
    // O done da fixture fechou o turno.
    expect(estado.turnoAberto).toBe(false);
  });

  it("replay repetido (reconexão que reentrega) não duplica linha — dedupe por id", () => {
    const log = lerLog("chat-simples");
    const estado = projetarReplay([...log, ...log]);
    expect(estado.mensagens).toHaveLength(2);
  });
});

describe("streaming (delta → message final)", () => {
  const delta = (texto: string, turn = "t-1"): Envelope => ({
    v: 1,
    id: `e-${Math.random()}`,
    ts: new Date().toISOString(),
    seq: 0,
    session: "s1",
    turn,
    kind: "delta",
    from: { kind: "specialist", specialist: "chat" },
    payload: { text: texto },
  });

  it("deltas acumulam numa linha em stream; o message final a SUBSTITUI (sem duplicar)", () => {
    let estado = CONVERSA_VAZIA;
    estado = aplicarEnvelope(estado, delta("Olá"));
    estado = aplicarEnvelope(estado, delta(", mundo"));
    expect(estado.turnoAberto).toBe(true);
    expect(estado.mensagens).toHaveLength(1);
    expect(estado.mensagens[0]).toMatchObject({ text: "Olá, mundo", emStream: true });

    // O message durável chega com o texto integral do log.
    estado = aplicarEnvelope(estado, {
      v: 1,
      id: "e-final",
      ts: new Date().toISOString(),
      seq: 7,
      session: "s1",
      turn: "t-1",
      kind: "message",
      from: { kind: "specialist", specialist: "chat" },
      payload: { role: "assistant", text: "Olá, mundo" },
    });
    expect(estado.mensagens).toHaveLength(1);
    expect(estado.mensagens[0]).toMatchObject({ id: "e-final", text: "Olá, mundo" });

    estado = aplicarEnvelope(estado, {
      v: 1,
      id: "e-done",
      ts: new Date().toISOString(),
      seq: 8,
      session: "s1",
      turn: "t-1",
      kind: "done",
      from: { kind: "supervisor" },
      payload: {},
    });
    expect(estado.turnoAberto).toBe(false);
  });

  it("verbos fora do vocabulário da conversa não mudam o estado (nada finge desenhá-los)", () => {
    const estado = aplicarEnvelope(CONVERSA_VAZIA, {
      v: 1,
      id: "e-route",
      ts: new Date().toISOString(),
      seq: 2,
      session: "s1",
      kind: "route",
      from: { kind: "supervisor" },
      payload: { specialist: "chat" },
    });
    expect(estado).toEqual(CONVERSA_VAZIA);
  });
});
