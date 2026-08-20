/**
 * A montagem do transporte como plugins do harness-kernel.
 *
 * O server é MONTAGEM, não lógica: ele lista estes plugins e a configuração de
 * cada um — tudo que traduz "mundo HTTP/WS" para "mundo kernel" mora aqui, para
 * que os plugins de produto (supervisor, roteador…) nunca importem node:http e
 * continuem testáveis sem processo de pé (a regra de dependência do harness:
 * consumidor depende do seam).
 *
 * Três plugins, em ordem de dependência:
 *   event-log   → provê `ctx.eventos`   (StorageDriver sobre node:sqlite)
 *   session-bus → provê `ctx.sessionBus` (fanout por sessão sobre o log)
 *   transporte  → provê `ctx.transporte` (HTTP + WS de pé, porta real)
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'

import { Service, type Context } from '@aibot2/harness-kernel'
import {
  SqliteEventStore,
  VERSION,
  type Model,
  type StorageDriver,
} from '@aibot2/domain-events'

import { MiniRoteador, respondeJson } from './router.js'
import { SessionBus } from './eventbus.js'
import {
  StreamServer,
  type EnvelopeDeEntrada,
  type LogDoTransporte,
  type ProvedorDeAmbientes,
} from './stream.js'
import { CLOSE_GOING_AWAY } from './ws.js'

declare module '@aibot2/harness-kernel' {
  interface Context {
    /** O event log durável (StorageDriver). Provido pelo event-log. */
    eventos: StorageDriver
    /** O fanout por sessão sobre o log. Provido pelo session-bus. */
    sessionBus: SessionBus
    /** O servidor HTTP+WS de pé. Provido pelo transporte. */
    transporte: Transporte
  }
  interface Events {
    /**
     * Um verbo do cliente entregue pelo stream (prompt, decisão, reply…).
     * O transporte NÃO interpreta — o supervisor (E6) assina aqui.
     */
    'openbot/inbound'(sessionId: string, envelope: EnvelopeDeEntrada): void
  }
}

/* -------------------------------- event-log ------------------------------- */

export interface EventLogConfig {
  /** Caminho do arquivo sqlite (ou ':memory:' em teste). O data dir é decisão do server. */
  caminho: string
}

/** Abre o event log e o registra como `ctx.eventos`. Fecha no unload. */
export const eventLogPlugin = {
  name: 'event-log',
  provide: ['eventos'] as const,
  apply(ctx: Context, config: EventLogConfig): void {
    const store = SqliteEventStore.open(config.caminho)
    ctx.provide('eventos', store)
    ctx.effect(() => () => store.close(), 'event-log:fechar')
  },
}

/* -------------------------------- session-bus ----------------------------- */

export interface SessionBusConfig {
  /** Folga da fila de cada assinante (padrão: FOLGA_PADRAO do eventbus). */
  folga?: number
}

/** Monta o barramento por sessão sobre `ctx.eventos`. */
export const sessionBusPlugin = {
  name: 'session-bus',
  inject: ['eventos'] as const,
  provide: ['sessionBus'] as const,
  apply(ctx: Context, config?: SessionBusConfig): void {
    const bus =
      config?.folga !== undefined
        ? new SessionBus(ctx.eventos, config.folga)
        : new SessionBus(ctx.eventos)
    ctx.provide('sessionBus', bus)
  },
}

/* -------------------------------- transporte ------------------------------ */

export interface TransporteConfig {
  /** O segredo do hello. Obrigatório — o StreamServer recusa vazio na subida. */
  token: string
  /** Loopback por padrão: este processo executa ferramenta na máquina da pessoa. */
  host?: string
  /** 0 = porta efêmera (teste). O valor real fica em `ctx.transporte.porta`. */
  port?: number
  allowOrigins?: readonly string[]
  specialists?: readonly string[]
  models?: readonly Model[]
  environments?: ProvedorDeAmbientes
  /** Se ausente, os verbos do cliente saem como evento `openbot/inbound` do kernel. */
  onInbound?: (sessionId: string, envelope: EnvelopeDeEntrada) => void
  helloTimeoutMs?: number
  pingIntervalMs?: number
  writeTimeoutMs?: number
  readySessionLimit?: number
  lingerMs?: number
  idFactory?: (prefixo: string) => string
  log?: LogDoTransporte
}

/**
 * O serviço `ctx.transporte`: o servidor de pé e o botão de desligar.
 * Registrado DEPOIS do listen de propósito — quem lê `ctx.transporte.porta`
 * nunca vê um zero de porta ainda não atribuída.
 */
export class Transporte extends Service {
  readonly #http: HttpServer
  readonly #stream: StreamServer
  readonly #host: string
  readonly #porta: number

  constructor(ctx: Context, http: HttpServer, stream: StreamServer, host: string, porta: number) {
    super(ctx, 'transporte')
    this.#http = http
    this.#stream = stream
    this.#host = host
    this.#porta = porta
  }

  get host(): string {
    return this.#host
  }

  /** A porta REAL (mesmo quando a config pediu 0). */
  get porta(): number {
    return this.#porta
  }

  /** Conexões WS vivas — diagnóstico e teste. */
  get conexoes(): number {
    return this.#stream.conexoes
  }

  /**
   * Encerramento educado: fecha os WS com 1001 (o cliente sabe que deve
   * reconectar depois), para de aceitar conexão nova e dá um prazo curto para
   * os frames de close saírem antes de derrubar o que sobrou — sem o prazo,
   * um cliente lento seguraria o processo no encerramento.
   */
  async fechar(): Promise<void> {
    this.#stream.fecharTodas(CLOSE_GOING_AWAY, 'servidor encerrando')
    this.#http.closeIdleConnections()
    await new Promise<void>((resolve) => {
      const prazo = setTimeout(() => this.#http.closeAllConnections(), 200)
      prazo.unref?.()
      this.#http.close(() => {
        clearTimeout(prazo)
        resolve()
      })
    })
  }
}

/** Sobe HTTP + WS e registra `ctx.transporte`. O unload desliga o servidor. */
export const transportePlugin = {
  name: 'transporte',
  inject: ['eventos', 'sessionBus'] as const,
  provide: ['transporte'] as const,
  async apply(ctx: Context, config: TransporteConfig): Promise<void> {
    const roteador = new MiniRoteador({ allowOrigins: config.allowOrigins ?? [] })

    // A rota de saúde do oráculo, na mesma forma: contagens, nunca conteúdo —
    // um health não autenticado não pode listar o catálogo de ninguém.
    roteador.rota('GET', '/health', (_req, res) => {
      respondeJson(res, 200, {
        status: 'ok',
        product: 'AI-BOT',
        protocol: VERSION,
        specialists: (config.specialists ?? []).length,
        models: (config.models ?? []).length,
      })
    })

    const stream = new StreamServer({
      store: ctx.eventos,
      bus: ctx.sessionBus,
      token: config.token,
      allowOrigins: config.allowOrigins ?? [],
      ...(config.specialists !== undefined ? { specialists: config.specialists } : {}),
      ...(config.models !== undefined ? { models: config.models } : {}),
      ...(config.environments !== undefined ? { environments: config.environments } : {}),
      onInbound:
        config.onInbound ??
        ((sessionId, envelope) => ctx.emit('openbot/inbound', sessionId, envelope)),
      ...(config.helloTimeoutMs !== undefined ? { helloTimeoutMs: config.helloTimeoutMs } : {}),
      ...(config.pingIntervalMs !== undefined ? { pingIntervalMs: config.pingIntervalMs } : {}),
      ...(config.writeTimeoutMs !== undefined ? { writeTimeoutMs: config.writeTimeoutMs } : {}),
      ...(config.readySessionLimit !== undefined
        ? { readySessionLimit: config.readySessionLimit }
        : {}),
      ...(config.lingerMs !== undefined ? { lingerMs: config.lingerMs } : {}),
      ...(config.idFactory !== undefined ? { idFactory: config.idFactory } : {}),
      ...(config.log !== undefined ? { log: config.log } : {}),
    })

    const http = createServer((req, res) => {
      void roteador.despachar(req, res).catch(() => {
        // O despachar já respondeu 500; o relançamento dele é para o log de
        // quem quiser um — aqui o processo não pode cair por uma rota quebrada.
      })
    })
    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Só o caminho do stream tem upgrade; o resto é 404 cru — responder JSON
      // bonito a quem tenta upgrade em rota errada é convite para insistir.
      const caminho = (req.url ?? '/').split('?', 1)[0]
      if (caminho !== '/v1/stream') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.end()
        return
      }
      stream.handleUpgrade(req, socket, head)
    })

    const host = config.host ?? '127.0.0.1'
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(config.port ?? 0, host, () => {
        http.off('error', reject)
        resolve()
      })
    })
    const endereco = http.address()
    const porta =
      endereco !== null && typeof endereco === 'object' ? endereco.port : (config.port ?? 0)

    const transporte = new Transporte(ctx, http, stream, host, porta)
    ctx.effect(() => () => transporte.fechar(), 'transporte:fechar')
  },
}
