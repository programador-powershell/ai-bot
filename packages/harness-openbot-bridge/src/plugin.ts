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

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'

import { Service, type Context } from '@aibot2/harness-kernel'
import {
  SqliteEventStore,
  VERSION,
  type Model,
  type StorageDriver,
} from '@aibot2/domain-events'

import { MiniRoteador, respondeErro, respondeJson, type RoteadorHttp } from './router.js'
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
    // [Onda 2] O MiniRoteador aqui é coerência de papel: este transporte Node
    // inteiro virou o dublê do transporte do chassis (Bun.serve + RoteadorHono)
    // — dublê usa dublê, produção usa produção, e o seam é o mesmo.
    const roteador = new MiniRoteador({ allowOrigins: config.allowOrigins ?? [] })
    registrarRotasDoTransporte(roteador, {
      specialists: config.specialists ?? [],
      models: config.models ?? [],
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
      // O seam agora fala fetch (Request/Response, a língua do Bun.serve e do
      // Hono); este transporte Node traduz na borda DELE — o processo não pode
      // cair por uma rota quebrada, então a falha vira 500 opaco.
      void atenderComRoteador(roteador, req, res).catch(() => {})
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

/* ------------------------- rotas HTTP do transporte ------------------------ */

export interface CatalogoDoTransporte {
  specialists: readonly string[]
  models: readonly Model[]
}

/**
 * As rotas HTTP do transporte, registradas em QUALQUER implementação do seam
 * (o chassis passa o RoteadorHono; este transporte Node passa o MiniRoteador)
 * — uma função só para as duas produções serem a mesma por construção.
 *
 * A rota de saúde é a do oráculo, na mesma forma: CONTAGENS, nunca conteúdo —
 * um health não autenticado não pode listar o catálogo de ninguém.
 */
export function registrarRotasDoTransporte(
  roteador: RoteadorHttp,
  catalogo: CatalogoDoTransporte,
): void {
  roteador.rota('GET', '/health', () =>
    respondeJson(200, {
      status: 'ok',
      product: 'AI-BOT',
      protocol: VERSION,
      specialists: catalogo.specialists.length,
      models: catalogo.models.length,
    }),
  )
}

/**
 * A tradução node:http → fetch deste transporte. Só ele precisa dela (Bun.serve
 * e Hono já falam fetch), por isso mora aqui e não no seam.
 */
async function atenderComRoteador(
  roteador: RoteadorHttp,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let resposta: Response
  try {
    resposta = await roteador.despachar(await paraRequest(req))
  } catch {
    resposta = respondeErro(500, 'internal', 'erro interno')
  }
  const cabecalhos: Record<string, string> = {}
  resposta.headers.forEach((valor, nome) => {
    cabecalhos[nome] = valor
  })
  res.writeHead(resposta.status, cabecalhos)
  const corpo = Buffer.from(await resposta.arrayBuffer())
  res.end(corpo)
}

/** Monta o Request fetch a partir do node:http (método, URL, cabeçalhos, corpo). */
async function paraRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [nome, valor] of Object.entries(req.headers)) {
    if (typeof valor === 'string') headers.set(nome, valor)
    else if (Array.isArray(valor)) for (const item of valor) headers.append(nome, item)
  }
  const metodo = req.method ?? 'GET'
  if (metodo === 'GET' || metodo === 'HEAD') {
    return new Request(url, { method: metodo, headers })
  }
  // Corpo BUFFERIZADO de propósito: as rotas do transporte são pequenas
  // (health, catálogo) e o Buffer evita a dança de duplex/stream do undici —
  // se um dia entrar upload por aqui, esta é a linha que muda.
  const pedacos: Buffer[] = []
  for await (const pedaco of req) {
    pedacos.push(pedaco as Buffer)
  }
  const corpo = Buffer.concat(pedacos)
  return new Request(url, {
    method: metodo,
    headers,
    ...(corpo.length > 0 ? { body: corpo } : {}),
  })
}
