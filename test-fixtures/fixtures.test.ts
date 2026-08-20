// A guarda das fixtures do oráculo.
//
// As fixtures são a saída literal do gateway Go (commit fd1ec32) e NÃO podem
// ser editadas à mão — mas "não pode" sem teste é pedido, não invariante. Esta
// suíte fixa a FORMA que as etapas E2/E3 vão assumir: se alguém "arrumar" uma
// vírgula, regravar pela metade ou corromper a cópia, quebra aqui, antes de a
// suíte de compatibilidade provar conformidade com um gateway que nunca
// existiu.
//
// O que ela NÃO faz: reimplementar o gateway. Só afirma o que o README das
// fixtures documenta — seq contíguo, os verbos na ordem gravada, o replay da
// transcrição idêntico (por valor) ao log durável, e o silêncio do liveOnly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const raiz = import.meta.dirname;

/** Um envelope como o gateway grava — só os campos que a guarda afirma. */
interface Envelope {
  v: number;
  id: string;
  ts: string;
  seq: number;
  session: string;
  turn?: string;
  kind: string;
  from: { kind: string; id?: string; specialist?: string };
  payload?: Record<string, unknown>;
}

/** Frame de transcrição WS: o envelope mais a direção anotada pelo gravador. */
interface Frame extends Envelope {
  _dir: "->" | "<-";
}

function linhas(caminho: string): string[] {
  return readFileSync(join(raiz, caminho), "utf8").trim().split("\n");
}

function log(caminho: string): Envelope[] {
  return linhas(caminho).map((linha) => JSON.parse(linha) as Envelope);
}

function transcricao(caminho: string): Frame[] {
  return linhas(caminho).map((linha) => JSON.parse(linha) as Frame);
}

/** Afirma as invariantes que valem para QUALQUER log durável do gateway. */
function afirmaLogDuravel(eventos: Envelope[]): void {
  const sessao = eventos[0]!.session;
  const turno = eventos[0]!.turn;
  eventos.forEach((evento, indice) => {
    expect(evento.v).toBe(1);
    // Seq é 1..N sem furo nem repetição — é a base do replay.
    expect(evento.seq).toBe(indice + 1);
    expect(evento.session).toBe(sessao);
    // Conversa de 1 turno: tudo pendurado no mesmo turn.
    expect(evento.turn).toBe(turno);
  });
  // Deltas e thinking são efêmeros POR DECISÃO: aparecer um aqui significa
  // que a fixture foi regravada com a durabilidade errada.
  for (const evento of eventos) {
    expect(["delta", "thinking", "state", "notice"]).not.toContain(evento.kind);
  }
}

describe("sessions/chat-simples", () => {
  const eventos = log("sessions/chat-simples/log.jsonl");

  it("é a conversa de 1 turno como o gateway a grava", () => {
    afirmaLogDuravel(eventos);
    // O prompt entra no log como message de role user — o verbo `prompt` é o
    // pedido no fio, não o registro durável.
    expect(eventos.map((evento) => evento.kind)).toEqual(["message", "route", "message", "done"]);
    expect(eventos[0]!.from.kind).toBe("user");
    expect(eventos[0]!.payload?.role).toBe("user");
    expect(eventos[2]!.payload?.role).toBe("assistant");
  });

  it("a rota veio do fast router, sem rede", () => {
    const rota = eventos[1]!;
    expect(rota.from).toEqual({ kind: "supervisor", id: "master" });
    expect(rota.payload?.specialist).toBe("chat");
    expect(rota.payload?.reason).toBe("heuristic");
  });

  it("o meta.json fecha com o log", () => {
    const meta = JSON.parse(readFileSync(join(raiz, "sessions/chat-simples/meta.json"), "utf8")) as {
      id: string;
      lastSeq: number;
      turns: number;
      specialist: string;
    };
    expect(meta.id).toBe(eventos[0]!.session);
    expect(meta.lastSeq).toBe(eventos.length);
    expect(meta.turns).toBe(1);
    expect(meta.specialist).toBe("chat");
  });
});

describe("sessions/ferramenta-aprovada", () => {
  const eventos = log("sessions/ferramenta-aprovada/log.jsonl");

  it("é o caminho completo de ferramenta com humano no meio", () => {
    afirmaLogDuravel(eventos);
    expect(eventos.map((evento) => evento.kind)).toEqual([
      "message",
      "route",
      "message",
      "tool.call",
      "approval.request",
      "approval.decision",
      "tool.result",
      "message",
      "done",
    ]);
  });

  it("o callId costura chamada, pedido, decisão e resultado", () => {
    const [chamada, pedido, decisao, resultado] = eventos.slice(3, 7) as [
      Envelope,
      Envelope,
      Envelope,
      Envelope,
    ];
    const callId = chamada.payload?.callId;
    expect(typeof callId).toBe("string");
    for (const evento of [pedido, decisao, resultado]) {
      expect(evento.payload?.callId).toBe(callId);
    }
    // O digest do "aprovar sempre" é o MESMO nos dois lados do portão.
    expect(chamada.payload?.digest).toBeTruthy();
    expect(pedido.payload?.digest).toBe(chamada.payload?.digest);
  });

  it("a decisão humana é durável e vem ANTES do efeito", () => {
    const decisao = eventos[5]!;
    const resultado = eventos[6]!;
    expect(decisao.from.kind).toBe("user");
    expect(decisao.payload?.allow).toBe(true);
    expect(decisao.payload?.scope).toBe("once");
    // A ordem no log é a prova: sem ela não dá para distinguir "a pessoa
    // autorizou" de "a política deixava passar".
    expect(decisao.seq).toBeLessThan(resultado.seq);
    expect(resultado.payload?.ok).toBe(true);
    expect(resultado.payload?.tool).toBe("memory.write");
  });

  it("a rota veio do degrau modelo (o léxico não soube)", () => {
    expect(eventos[1]!.payload?.reason).toBe("model");
    expect(eventos[1]!.payload?.specialist).toBe("chat");
  });
});

describe("ws/handshake.jsonl", () => {
  const frames = transcricao("ws/handshake.jsonl");
  const logA = log("sessions/chat-simples/log.jsonl");
  const logB = log("sessions/ferramenta-aprovada/log.jsonl");

  it("é hello → ready → replay → re-hello → ready → replay", () => {
    const resumo = frames.map((frame) => `${frame._dir}${frame.kind}`);
    expect(resumo).toEqual([
      "->hello",
      "<-ready",
      ...logA.map((evento) => `<-${evento.kind}`),
      "->hello",
      "<-ready",
      ...logB.map((evento) => `<-${evento.kind}`),
    ]);
  });

  it("cada replay entrega exatamente o log durável, por valor", () => {
    const replayA = frames.slice(2, 2 + logA.length);
    const replayB = frames.slice(4 + logA.length);
    for (const [replay, duravel] of [
      [replayA, logA],
      [replayB, logB],
    ] as const) {
      expect(replay.length).toBe(duravel.length);
      replay.forEach((frame, indice) => {
        const { _dir, ...envelope } = frame;
        expect(_dir).toBe("<-");
        expect(envelope).toEqual(duravel[indice]);
      });
    }
  });

  it("o ready anuncia o lastSeq que o replay alcança, e a troca reapresenta o token", () => {
    const readyA = frames[1]!;
    const readyB = frames[3 + logA.length]!;
    expect(readyA.payload?.seq).toBe(logA.length);
    expect(readyA.payload?.session).toBe(logA[0]!.session);
    expect(readyB.payload?.seq).toBe(logB.length);
    expect(readyB.payload?.session).toBe(logB[0]!.session);
    // Frame forjado numa conexão autenticada não escolhe sessão de ninguém: o
    // hello de troca carrega token de novo, e a fixture registra isso.
    for (const hello of [frames[0]!, frames[2 + logA.length]!]) {
      expect(hello._dir).toBe("->");
      expect(hello.payload?.token).toBeTruthy();
      expect(hello.payload?.resumeFrom).toBe(0);
    }
  });
});

describe("ws/live-only.jsonl", () => {
  const frames = transcricao("ws/live-only.jsonl");
  const logA = log("sessions/chat-simples/log.jsonl");

  it("hello com liveOnly recebe SÓ o ready — o histórico não trafega", () => {
    expect(frames.length).toBe(2);
    const [hello, ready] = frames as [Frame, Frame];
    expect(hello._dir).toBe("->");
    expect(hello.kind).toBe("hello");
    expect(hello.payload?.liveOnly).toBe(true);
    expect(ready._dir).toBe("<-");
    expect(ready.kind).toBe("ready");
    // O cursor nasce no lastSeq da sessão apontada: a sessão TEM histórico
    // (4 envelopes) e mesmo assim nada dele veio — essa é a prova.
    expect(ready.payload?.session).toBe(logA[0]!.session);
    expect(ready.payload?.seq).toBe(logA.length);
  });
});
