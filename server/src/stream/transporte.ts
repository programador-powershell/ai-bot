/**
 * [Onda 2] O transporte do CHASSIS: hello/ready/replay/re-hello servidos pelo
 * Bun.serve — o WS nativo do Bun no lugar do RFC 6455 clean-room (que virou
 * dublê de teste, plano §3/§5).
 *
 * O que mora aqui é só a COSTURA: o protocolo inteiro continua no StreamServer
 * do bridge (as três invariantes E3, o token no primeiro frame, o 1013 do
 * atrasado), e as rotas HTTP do transporte entram pelo RoteadorHono (a
 * implementação de produção do seam RoteadorHttp). O Bun.serve do chassis tem
 * UM slot de websocket para o processo todo — este módulo entrega os handlers
 * e um marcador de dados para o index.ts multiplexá-los com os outros donos do
 * slot (o proxy do live screen e o socket de canais do Hono).
 */

import type { ServerWebSocket } from "bun";

import type { Model, StorageDriver } from "@aibot2/domain-events";
import {
  RoteadorHono,
  SessionBus,
  StreamServer,
  UpgradeRecusadoError,
  checkOrigin,
  registrarRotasDoTransporte,
  type EnvelopeDeEntrada,
  type LogDoTransporte,
  type ProvedorDeAmbientes,
} from "@aibot2/harness-openbot-bridge";

import { ConexaoBunWs } from "./conexao-bun.js";

/** O caminho do stream — o MESMO do gateway Go, porque o desktop já o disca. */
export const CAMINHO_DO_STREAM = "/v1/stream";

/**
 * Teto de bytes enfileirados por socket antes de o uWS começar a DESCARTAR.
 * Alto de propósito: descartar frame abre buraco no meio do stream (o defeito
 * que o protocolo inteiro existe para impedir) — quem decide desconectar um
 * cliente lento é a fila do barramento (folga → atrasado → 1013), nunca o
 * transporte por conta própria.
 */
const TETO_DE_CONTRAPRESSAO_BYTES = 64 * 1024 * 1024;

export interface OpcoesDoStreamDoChassi {
  store: StorageDriver;
  bus: SessionBus;
  /** O segredo do hello. Obrigatório — o StreamServer recusa vazio na subida. */
  token: string;
  allowOrigins?: readonly string[];
  specialists?: readonly string[];
  models?: readonly Model[];
  environments?: ProvedorDeAmbientes;
  /** Os verbos do cliente (prompt, decisões…). Quem interpreta é o dono do funil. */
  onInbound?: (sessionId: string, envelope: EnvelopeDeEntrada) => void;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  writeTimeoutMs?: number;
  readySessionLimit?: number;
  idFactory?: (prefixo: string) => string;
  log?: LogDoTransporte;
}

/** O que viaja no `data` de um upgrade NOSSO — o marcador do multiplex. */
export interface DadosDoStreamDoChassi {
  streamDoChassi: true;
  origem?: string | undefined;
  conexao?: ConexaoBunWs;
}

export function ehStreamDoChassi(data: unknown): data is DadosDoStreamDoChassi {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { streamDoChassi?: unknown }).streamDoChassi === true
  );
}

/**
 * A fatia do Bun.serve de que o upgrade precisa — estrutural, para o teste
 * subir o servidor dele sem depender do tipo genérico `Server<T>` do Bun.
 */
export interface ServidorComUpgrade {
  upgrade(request: Request, options: { data: DadosDoStreamDoChassi }): boolean;
}

export interface StreamDoChassi {
  /** O protocolo de pé — exposto para diagnóstico/teste (conexões vivas, fecharTodas). */
  servidor: StreamServer;
  /** As rotas HTTP do transporte (health do oráculo) na implementação Hono do seam. */
  roteador: RoteadorHono;
  /**
   * Trata um upgrade em CAMINHO_DO_STREAM. Devolve a resposta de recusa, ou
   * undefined quando o Bun assumiu o socket (a resposta é do upgrade).
   */
  upgrade(request: Request, server: ServidorComUpgrade): Response | undefined;
  /** Os handlers do slot websocket, já amarrados ao marcador de dados. */
  aoAbrir(ws: ServerWebSocket<DadosDoStreamDoChassi>): void;
  aoReceber(ws: ServerWebSocket<DadosDoStreamDoChassi>, mensagem: string | Buffer): void;
  aoFechar(ws: ServerWebSocket<DadosDoStreamDoChassi>, codigo: number, motivo: string): void;
  aoDrenar(ws: ServerWebSocket<DadosDoStreamDoChassi>): void;
  /** Encerramento educado do processo: fecha os WS vivos com 1001. */
  fecharTodas(): void;
}

/**
 * A resposta CRUA para um upgrade recusado — o MESMO corpo opaco do oráculo
 * (e do transporte clean-room): dizer qual checagem reprovou é ajuda para quem
 * está sondando; o motivo real vai só para o log do servidor.
 */
function recusarUpgrade(status: 400 | 403): Response {
  return new Response(
    JSON.stringify({ error: { code: "upgrade", message: "handshake de websocket inválido" } }),
    { status, headers: { "Content-Type": "application/json; charset=utf-8" } },
  );
}

export function criarStreamDoChassi(opcoes: OpcoesDoStreamDoChassi): StreamDoChassi {
  const log: LogDoTransporte = opcoes.log ?? (() => {});
  const allowOrigins = opcoes.allowOrigins ?? [];

  const servidor = new StreamServer({
    store: opcoes.store,
    bus: opcoes.bus,
    token: opcoes.token,
    allowOrigins,
    ...(opcoes.specialists !== undefined ? { specialists: opcoes.specialists } : {}),
    ...(opcoes.models !== undefined ? { models: opcoes.models } : {}),
    ...(opcoes.environments !== undefined ? { environments: opcoes.environments } : {}),
    ...(opcoes.onInbound !== undefined ? { onInbound: opcoes.onInbound } : {}),
    ...(opcoes.helloTimeoutMs !== undefined ? { helloTimeoutMs: opcoes.helloTimeoutMs } : {}),
    ...(opcoes.pingIntervalMs !== undefined ? { pingIntervalMs: opcoes.pingIntervalMs } : {}),
    ...(opcoes.writeTimeoutMs !== undefined ? { writeTimeoutMs: opcoes.writeTimeoutMs } : {}),
    ...(opcoes.readySessionLimit !== undefined
      ? { readySessionLimit: opcoes.readySessionLimit }
      : {}),
    ...(opcoes.idFactory !== undefined ? { idFactory: opcoes.idFactory } : {}),
    log,
  });

  // As rotas HTTP do transporte na implementação HONO do seam (plano §4.2) —
  // a MESMA função de registro que o transporte Node (dublê) usa.
  const roteador = new RoteadorHono({ allowOrigins });
  registrarRotasDoTransporte(roteador, {
    specialists: opcoes.specialists ?? [],
    models: opcoes.models ?? [],
  });

  return {
    servidor,
    roteador,

    upgrade(request, server) {
      // A régua de origem do handshake é a MESMA do transporte clean-room
      // (checkOrigin): app sem Origin passa, navegador só na lista.
      const origem = request.headers.get("origin") ?? undefined;
      try {
        checkOrigin(origem, allowOrigins);
      } catch (erro) {
        const status = erro instanceof UpgradeRecusadoError ? erro.status : 403;
        log("upgrade recusado", {
          erro: erro instanceof Error ? erro.message : String(erro),
        });
        return recusarUpgrade(status === 400 ? 400 : 403);
      }
      const data: DadosDoStreamDoChassi = { streamDoChassi: true, origem };
      if (server.upgrade(request, { data })) {
        // O Bun assumiu o socket; o 101 já saiu — não há Response a devolver.
        return undefined;
      }
      return recusarUpgrade(400);
    },

    aoAbrir(ws) {
      const conexao = new ConexaoBunWs(ws);
      ws.data.conexao = conexao;
      // O atender roda até a conexão morrer; erros já viram close + log lá dentro.
      void servidor.atender(conexao, { origem: ws.data.origem });
    },

    aoReceber(ws, mensagem) {
      ws.data.conexao?.aoReceber(mensagem);
    },

    aoFechar(ws, codigo, motivo) {
      ws.data.conexao?.aoFechar(codigo, motivo);
    },

    aoDrenar(ws) {
      ws.data.conexao?.aoDrenar();
    },

    fecharTodas() {
      servidor.fecharTodas();
    },
  };
}

export { TETO_DE_CONTRAPRESSAO_BYTES };
