/**
 * [Onda 2 — o aceite central] COMPATIBILIDADE COM O ORÁCULO, servida pelo
 * CHASSIS: as transcrições WS reais do gateway Go (test-fixtures/ws/*.jsonl)
 * reproduzidas por valor contra o transporte novo (Bun.serve + WS nativo) —
 * os mesmos testes nomeados do bridge, apontados para cá.
 *
 * A comparação é por VALOR, nunca por byte — o README das fixtures explica: os
 * ws/*.jsonl passaram por JSON.parse→stringify no cliente gravador, e id/ts
 * dos frames gerados pelo servidor (ready) são de cada execução. O que TEM de
 * bater: a SEQUÊNCIA de frames (kinds, seqs, sessões), o ready campo essencial
 * a campo essencial, e cada envelope de replay INTEIRO por valor.
 *
 * COMPAT DUPLA: o desktop Tauri atual (ai-bot/apps/desktop — referência, não
 * tocado) fala EXATAMENTE o protocolo destas fixtures (elas foram gravadas do
 * tráfego dele com o gateway Go); o app forkado fala o mesmo protocolo pelo
 * cliente novo (app/src/lib/chat). O teste "duas janelas" abaixo liga as duas
 * pontas NO MESMO server e exige a MESMA sessão nas duas.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Envelope, Model } from "@aibot2/domain-events";
import { ClienteWsDeTeste } from "@aibot2/harness-openbot-bridge/teste-cliente-ws";
import {
  lerTranscricao,
  semearSessaoDeFixture,
  type LinhaDeTranscricao,
} from "@aibot2/harness-openbot-bridge/teste-fixtures";
import type { EstadoDeAmbientes } from "@aibot2/harness-openbot-bridge";

import {
  montarTransporteDoChassi,
  type TransporteDeTeste,
} from "./support/transporte-chassi";

const TOKEN_DAS_FIXTURES = "token-de-mentira-das-fixtures";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

interface ReadyDaFixtura {
  specialists: string[];
  models: Model[];
  environment?: EstadoDeAmbientes["environment"];
  environments?: EstadoDeAmbientes["environments"];
}

/** Sobe o CHASSIS com o catálogo do ready da fixture e as duas sessões semeadas. */
async function montarComOraculo(
  transcricao: LinhaDeTranscricao[],
): Promise<TransporteDeTeste> {
  const ready = transcricao.find((linha) => linha._dir === "<-" && linha.kind === "ready");
  expect(ready).toBeDefined();
  const catalogo = ready?.payload as ReadyDaFixtura;

  const transporte = await montarTransporteDoChassi({
    transporte: {
      token: TOKEN_DAS_FIXTURES,
      specialists: catalogo.specialists,
      models: catalogo.models,
      environments: () => ({
        ...(catalogo.environment !== undefined ? { environment: catalogo.environment } : {}),
        ...(catalogo.environments !== undefined
          ? { environments: catalogo.environments }
          : {}),
      }),
    },
  });
  cleanups.push(() => transporte.dispose());

  // A ordem de semeadura reproduz a recência do oráculo: a lista do ready vem
  // por updatedAt decrescente, e o nosso updatedAt é o relógio do import — a
  // pausa garante que a segunda sessão fique mais recente mesmo em disco
  // rápido (empate de milissegundo inverteria a lista).
  await semearSessaoDeFixture(transporte.store, "chat-simples");
  await new Promise((resolve) => setTimeout(resolve, 15));
  await semearSessaoDeFixture(transporte.store, "ferramenta-aprovada");
  return transporte;
}

/** Campos essenciais de um resumo de sessão — updatedAt é do relógio de cada lado. */
function resumoEssencial(lista: unknown): Array<Record<string, unknown>> {
  return (lista as Array<Record<string, unknown>>).map((resumo) => ({
    id: resumo.id,
    title: resumo.title,
    specialist: resumo.specialist,
    model: resumo.model,
    turns: resumo.turns,
  }));
}

function compararFrame(esperado: LinhaDeTranscricao, recebido: Envelope): void {
  // A espinha do envelope bate sempre: verbo, número e sessão.
  expect(recebido.kind).toBe(esperado.kind);
  expect(recebido.seq).toBe(esperado.seq);
  expect(recebido.session).toBe(esperado.session);
  expect(recebido.v).toBe(esperado.v);

  if (esperado.kind === "ready") {
    // O ready é GERADO por cada servidor: id vazio e ts próprio (como no Go);
    // o payload é comparado campo essencial a campo essencial.
    expect(recebido.id).toBe("");
    const payloadEsperado = esperado.payload as Record<string, unknown>;
    const payloadRecebido = recebido.payload as Record<string, unknown>;
    for (const campo of [
      "session",
      "seq",
      "specialists",
      "models",
      "activeSpecialist",
      "activeModel",
      "environment",
      "environments",
    ]) {
      expect(payloadRecebido[campo], `ready.${campo}`).toEqual(payloadEsperado[campo]);
    }
    expect(resumoEssencial(payloadRecebido.sessions)).toEqual(
      resumoEssencial(payloadEsperado.sessions),
    );
    // updatedAt existe e é timestamp — o VALOR é do relógio de cada lado.
    for (const resumo of payloadRecebido.sessions as Array<Record<string, unknown>>) {
      expect(typeof resumo.updatedAt).toBe("string");
      expect(Number.isNaN(Date.parse(resumo.updatedAt as string))).toBe(false);
    }
    return;
  }

  // Envelope de replay: veio do log durável importado da fixture — o valor
  // INTEIRO tem de bater, campo a campo (id, ts, turn, from, payload).
  const { _dir, ...limpo } = esperado;
  expect(recebido).toEqual(limpo);
}

describe("compat: transcrição ws/handshake.jsonl (hello → ready → replay → re-hello)", () => {
  it("o servidor TS reproduz a MESMA sequência de frames que o gateway Go gravou", async () => {
    const transcricao = lerTranscricao("ws/handshake.jsonl");
    const transporte = await montarComOraculo(transcricao);

    const cliente = await ClienteWsDeTeste.conectar(transporte.porta);
    cleanups.push(() => cliente.destruir());

    for (const linha of transcricao) {
      if (linha._dir === "->") {
        const { _dir, ...frame } = linha;
        cliente.enviarTexto(frame);
        continue;
      }
      const recebido = (await cliente.proximoJson()) as Envelope;
      compararFrame(linha, recebido);
    }

    // Fim da transcrição = fim do que o oráculo mandou: nada além disso.
    expect((await cliente.proxima(200)).tipo).toBe("prazo");
  }, 20_000);
});

describe("compat: transcrição ws/live-only.jsonl (o hello sem histórico)", () => {
  it("liveOnly devolve SÓ o ready (seq do fim do log) e mais nada", async () => {
    const transcricao = lerTranscricao("ws/live-only.jsonl");
    const transporte = await montarComOraculo(transcricao);

    const cliente = await ClienteWsDeTeste.conectar(transporte.porta);
    cleanups.push(() => cliente.destruir());

    for (const linha of transcricao) {
      if (linha._dir === "->") {
        const { _dir, ...frame } = linha;
        cliente.enviarTexto(frame);
        continue;
      }
      const recebido = (await cliente.proximoJson()) as Envelope;
      compararFrame(linha, recebido);
      // A fixture prova o seq do fim do log (4) — a asserção fica explícita
      // porque é o contrato da ponte de ferramentas.
      expect((recebido.payload as { seq: number }).seq).toBe(4);
    }

    // "e mais nada": os 4 envelopes de histórico NÃO trafegam.
    expect((await cliente.proxima(250)).tipo).toBe("prazo");
  }, 20_000);
});

describe("compat dupla: duas janelas no MESMO server, a MESMA sessão do oráculo", () => {
  it("o hello do desktop e o hello do app forkado recebem replays idênticos por valor", async () => {
    const transcricao = lerTranscricao("ws/handshake.jsonl");
    const transporte = await montarComOraculo(transcricao);

    // O hello REAL que o desktop mandou (gravado na fixture), reapresentado.
    const helloDoDesktop = transcricao.find((linha) => linha._dir === "->");
    expect(helloDoDesktop).toBeDefined();
    const { _dir, ...frameDoDesktop } = helloDoDesktop as LinhaDeTranscricao;
    const sessao = (frameDoDesktop.payload as { sessionHint: string }).sessionHint;

    // O hello que o cliente do app forkado monta (app/src/lib/chat/transporte.ts):
    // client próprio, mesmo token no primeiro frame, mesma sessão.
    const frameDoApp = {
      v: 1,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      seq: 0,
      session: "",
      kind: "hello",
      from: { kind: "user" },
      payload: {
        client: "aibot2-app",
        version: "0.1.0",
        token: TOKEN_DAS_FIXTURES,
        sessionHint: sessao,
        resumeFrom: 0,
      },
    };

    const desktop = await ClienteWsDeTeste.conectar(transporte.porta);
    cleanups.push(() => desktop.destruir());
    const app = await ClienteWsDeTeste.conectar(transporte.porta);
    cleanups.push(() => app.destruir());

    desktop.enviarTexto(frameDoDesktop);
    app.enviarTexto(frameDoApp);

    const lerAte = async (cliente: ClienteWsDeTeste, quantos: number): Promise<Envelope[]> => {
      const frames: Envelope[] = [];
      while (frames.length < quantos) {
        frames.push((await cliente.proximoJson()) as Envelope);
      }
      return frames;
    };

    // ready + os 4 envelopes do log da sessão, nas DUAS conexões.
    const doDesktop = await lerAte(desktop, 5);
    const doApp = await lerAte(app, 5);

    expect(doDesktop[0]?.kind).toBe("ready");
    expect(doApp[0]?.kind).toBe("ready");
    expect(doDesktop[0]?.session).toBe(sessao);
    expect(doApp[0]?.session).toBe(sessao);
    // O REPLAY é a conversa — e tem de ser idêntico por valor entre as duas
    // janelas: mesma sessão gravada do oráculo, byte de payload por byte.
    expect(doApp.slice(1)).toEqual(doDesktop.slice(1));

    // Um evento novo nasce no log e as DUAS janelas o veem, com o mesmo seq.
    await transporte.bus.publish(sessao, {
      id: "e-compat-dupla",
      kind: "message",
      from: { kind: "specialist", id: "chat", specialist: "chat" },
      payload: { role: "assistant", text: "as duas janelas veem a mesma linha" },
    });
    const vivoDesktop = (await desktop.proximoJson()) as Envelope;
    const vivoApp = (await app.proximoJson()) as Envelope;
    expect(vivoDesktop).toEqual(vivoApp);
    expect(vivoDesktop.seq).toBe(5);
  }, 20_000);
});
