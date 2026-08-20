/**
 * APOIO DE TESTE — o transporte do CHASSIS de pé, em porta efêmera.
 *
 * [Onda 2] O espelho do montarTransporte do bridge (que sobe o transporte Node,
 * hoje dublê): aqui sobe o Bun.serve REAL com os handlers do
 * src/stream/transporte.ts — os mesmos testes nomeados das invariantes E3, da
 * compat e da contrapressão apontam para cá, e o aceite da onda é que passem
 * SERVIDOS PELO CHASSIS. O contrato devolvido é o mesmo do bridge (porta,
 * store, bus, inbound, dispose) para os testes serem transplantáveis linha a
 * linha.
 */

import { serve } from "bun";

import { SqliteEventStore, type StorageDriver } from "@aibot2/domain-events";
import { SessionBus, type EnvelopeDeEntrada } from "@aibot2/harness-openbot-bridge";

import {
  CAMINHO_DO_STREAM,
  TETO_DE_CONTRAPRESSAO_BYTES,
  criarStreamDoChassi,
  type DadosDoStreamDoChassi,
  type OpcoesDoStreamDoChassi,
} from "../../src/stream/transporte";

export const TOKEN_DE_TESTE = "token-de-teste-do-transporte";

export interface TransporteDeTeste {
  porta: number;
  store: StorageDriver;
  bus: SessionBus;
  /** Tudo que o transporte entregou ao seam de entrada, na ordem. */
  inbound: Array<{ sessionId: string; envelope: EnvelopeDeEntrada }>;
  dispose(): Promise<void>;
}

export interface OpcoesDeMontagem {
  /** Um store já preparado (ou instrumentado). Ausente = sqlite :memory:. */
  store?: StorageDriver;
  folga?: number;
  transporte?: Partial<OpcoesDoStreamDoChassi>;
}

export async function montarTransporteDoChassi(
  opcoes?: OpcoesDeMontagem,
): Promise<TransporteDeTeste> {
  const store = opcoes?.store ?? SqliteEventStore.open(":memory:");
  const bus =
    opcoes?.folga !== undefined ? new SessionBus(store, opcoes.folga) : new SessionBus(store);
  const inbound: Array<{ sessionId: string; envelope: EnvelopeDeEntrada }> = [];

  const stream = criarStreamDoChassi({
    store,
    bus,
    token: TOKEN_DE_TESTE,
    onInbound: (sessionId, envelope) => {
      inbound.push({ sessionId, envelope });
    },
    ...opcoes?.transporte,
  });

  const servidor = serve<DadosDoStreamDoChassi>({
    port: 0,
    // Loopback como a produção: o teste não abre porta para a rede.
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url);
      if (
        url.pathname === CAMINHO_DO_STREAM &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        return stream.upgrade(request, server) as Response;
      }
      // Upgrade fora do caminho do stream é 404 cru — a mesma recusa do
      // transporte de referência (e do index.ts, onde o app forkado responde).
      return stream.roteador
        .despacharSeSua(request)
        .then((propria) => propria ?? new Response("Not Found", { status: 404 }));
    },
    websocket: {
      backpressureLimit: TETO_DE_CONTRAPRESSAO_BYTES,
      open(ws) {
        stream.aoAbrir(ws);
      },
      message(ws, mensagem) {
        stream.aoReceber(
          ws,
          typeof mensagem === "string" ? mensagem : Buffer.from(mensagem as Uint8Array),
        );
      },
      close(ws, codigo, motivo) {
        stream.aoFechar(ws, codigo, motivo);
      },
      drain(ws) {
        stream.aoDrenar(ws);
      },
    },
  });

  return {
    porta: servidor.port,
    store,
    bus,
    inbound,
    dispose: async () => {
      stream.fecharTodas();
      // stop(true) derruba conexões vivas — sem isso um socket de teste preso
      // seguraria o processo do vitest no fim da suíte.
      servidor.stop(true);
      await store.close();
    },
  };
}
