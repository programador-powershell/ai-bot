/**
 * [Onda 2] Contrapressão SERVIDA PELO CHASSIS (o porte do teste do bridge,
 * aceite 5 da onda): cliente que para de ler leva 1013 e, ao reconectar com
 * resumeFrom, recebe o que faltou.
 *
 * O socket lento é DE VERDADE — pause() no socket do cliente para o kernel de
 * drenar — porque a cadeia inteira é física: o send() do Bun devolve -1 sob
 * contrapressão, o writeText espera o drain, a fila do barramento enche, o
 * assinante cai por atraso e a conexão fecha com 1013. Mock de relógio
 * provaria a coreografia, não a contrapressão.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Envelope, EnvelopeInput } from "@aibot2/domain-events";
import { ClienteWsDeTeste } from "@aibot2/harness-openbot-bridge/teste-cliente-ws";

import { TOKEN_DE_TESTE, montarTransporteDoChassi } from "./support/transporte-chassi";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const TOTAL_DE_EVENTOS = 40;
/** Grande o bastante para encher socket + buffers do kernel com o cliente pausado. */
const TEXTO_GRANDE = "x".repeat(128 * 1024);

function eventoGrande(indice: number): EnvelopeInput {
  return {
    id: `e-grande-${indice}`,
    kind: "message",
    from: { kind: "specialist", id: "chat", specialist: "chat" },
    payload: { role: "assistant", text: TEXTO_GRANDE },
  };
}

function hello(campos: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    id: "h1",
    ts: new Date().toISOString(),
    seq: 0,
    session: "",
    kind: "hello",
    from: { kind: "user" },
    payload: { client: "teste", version: "0.0.1", token: TOKEN_DE_TESTE, ...campos },
  };
}

describe("cliente atrasado (o Lagged → 1013 do oráculo)", () => {
  it("quem para de ler leva 1013 e o resumeFrom da reconexão recompõe o que faltou", async () => {
    // Folga curta para o atraso ser alcançável no teste. (O linger do
    // transporte Node não existe aqui: o Bun entrega o close frame atrás dos
    // frames grandes por conta própria quando o cliente volta a drenar.)
    const transporte = await montarTransporteDoChassi({ folga: 8 });
    cleanups.push(() => transporte.dispose());

    await transporte.store.createSession({ id: "s-lenta", title: "conversa da contrapressão" });

    const lerdo = await ClienteWsDeTeste.conectar(transporte.porta);
    cleanups.push(() => lerdo.destruir());
    lerdo.enviarTexto(hello({ sessionHint: "s-lenta", resumeFrom: 0 }));
    const ready = (await lerdo.proximoJson()) as Envelope;
    expect(ready.kind).toBe("ready");

    // O cliente PARA de ler — o kernel para de drenar o socket.
    lerdo.pausarLeitura();

    // A produção não espera por ele: os 40 eventos entram no log e no fanout.
    for (let indice = 1; indice <= TOTAL_DE_EVENTOS; indice++) {
      await transporte.bus.publish("s-lenta", eventoGrande(indice));
    }
    expect(await transporte.store.lastSeq("s-lenta")).toBe(TOTAL_DE_EVENTOS);

    // Ao voltar a ler, o cliente recebe o que coube no buffer e o 1013 — a
    // fila dele no barramento estourou enquanto estava parado.
    lerdo.retomarLeitura();
    const vistos: number[] = [];
    let fimCodigo: number | undefined;
    let fimMotivo: string | undefined;
    for (;;) {
      const item = await lerdo.proxima(10_000);
      if (item.tipo === "prazo") throw new Error("a conexão lenta não foi encerrada");
      if (item.tipo === "fim") {
        fimCodigo = item.fim.codigo;
        fimMotivo = item.fim.motivo;
        break;
      }
      vistos.push((JSON.parse(item.payload.toString("utf8")) as Envelope).seq);
    }
    expect(fimCodigo).toBe(1013);
    expect(fimMotivo).toContain("atrasado");

    // O que chegou é um PREFIXO contíguo 1..k — buraco no meio seria o defeito
    // que a queda inteira existe para impedir.
    expect(vistos.length).toBeLessThan(TOTAL_DE_EVENTOS);
    expect(vistos).toEqual(Array.from({ length: vistos.length }, (_, i) => i + 1));

    // Reconexão com resumeFrom = último visto: o replay entrega EXATAMENTE o
    // que faltou, sem repetir nada.
    const ultimoVisto = vistos.length;
    const recuperado = await ClienteWsDeTeste.conectar(transporte.porta);
    cleanups.push(() => recuperado.destruir());
    recuperado.enviarTexto(hello({ sessionHint: "s-lenta", resumeFrom: ultimoVisto }));
    const readyDeVolta = (await recuperado.proximoJson()) as Envelope;
    expect((readyDeVolta.payload as { seq: number }).seq).toBe(TOTAL_DE_EVENTOS);

    const restantes: number[] = [];
    while (restantes.length < TOTAL_DE_EVENTOS - ultimoVisto) {
      const envelope = (await recuperado.proximoJson(10_000)) as Envelope;
      restantes.push(envelope.seq);
    }
    expect(restantes).toEqual(
      Array.from({ length: TOTAL_DE_EVENTOS - ultimoVisto }, (_, i) => ultimoVisto + i + 1),
    );

    // A união das duas conexões cobre 1..40 exatamente uma vez.
    const uniao = [...vistos, ...restantes];
    expect(uniao).toEqual(Array.from({ length: TOTAL_DE_EVENTOS }, (_, i) => i + 1));
  }, 30_000);
});
