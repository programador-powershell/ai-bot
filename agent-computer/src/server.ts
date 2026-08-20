/**
 * O agent-computer: o computador do agente sobre node:http, no MESMO estilo do
 * worker-daemon — porte adaptado de agent-computer/src/index.ts do openbot
 * (MIT, pin 06a1a84; ver THIRD_PARTY_NOTICES.md), com os pontos Bun
 * (Bun.serve, websocket nativo) substituídos e a cirurgia §3/§32 aplicada:
 *
 * - **Sessão por RUNTIME, não por bot.** As rotas vivem sob
 *   /session/{runtimeId}/…; o contexto nasce no open e morre no close (ou no
 *   disposer da TaskRun via plugin browser-runtime). Não há perfil
 *   persistente nem computador permanente.
 * - **Token compartilhado.** O processo dirige um browser: sem token ele nem
 *   sobe — autenticação ausente é falha de deployment, nunca computador
 *   aberto. Valor chega por config na subida (cofre → env), jamais no código.
 *   Comparação em tempo constante.
 * - **Elemento por referência, não por pixel.** /snapshot carimba cada
 *   elemento interativo com uma ref e{N}; /act (click/type/press) recebe uma
 *   dessas refs. Preencher formulário não precisa de modelo de visão: o bot lê
 *   uma lista de campos em vez de chutar coordenadas numa imagem.
 * - **Take the Wheel.** Enquanto uma pessoa segura o volante, ação do bot é
 *   RECUSADA (409), nunca enfileirada.
 * - **Egress anti-SSRF** em /navigate: DNS resolvido e IP privado bloqueado
 *   DEPOIS de resolver (egress.ts).
 * - **Sem screencast nesta leva** (pendência declarada): o valor para os
 *   agentes é snapshot/act; o console humano (frames + input por pixel +
 *   segredo mascarado) entra com o WS na leva própria.
 * - **Nenhuma rota além do contrato**: rota desconhecida é 404 e não descreve
 *   o que protege.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import { parseAriaSnapshot, type SnapshotElement } from './aria-snapshot.js'
import { ControlError, type ControlState } from './control.js'
import { checkNavigationTarget, type Resolver } from './egress.js'
import { SessionManager, type RuntimeSession } from './sessions.js'

/** Ref de geração antiga (ou que não nomeia nada): a resposta é acionável — tire outro snapshot. */
class StaleSnapshotError extends Error {
  override name = 'StaleSnapshotError'
}

export interface AgentComputerConfig {
  /** O segredo que TODO chamador apresenta. Vazio = o processo não sobe. */
  token: string
  /** Opt-in para navegar em hosts privados (deployment local / testes). */
  allowPrivateHosts?: boolean
  /** Resolver DNS injetável — o teste de SSRF não depende da rede. */
  resolve?: Resolver
  headless?: boolean
  navigationTimeoutMs?: number
  actionTimeoutMs?: number
  now?: () => number
}

export interface AgentComputer {
  server: Server
  /** Sobe em 127.0.0.1 (mesma decisão de loopback do worker-daemon no M1). */
  listen(port?: number): Promise<number>
  close(): Promise<void>
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
/**
 * Bem mais curto que a navegação: o Playwright espera o controle ficar
 * clicável (comportamento desejado), mas uma ref que não resolve mais ficaria
 * pendurada o timeout inteiro antes de dizer isso.
 */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000

export function createAgentComputer(config: AgentComputerConfig): AgentComputer {
  if (config.token.trim() === '') {
    // Este processo dirige um browser com sessões reais: subir sem segredo
    // seria deixar a porta aberta para qualquer origem da rede.
    throw new Error('agent-computer exige token compartilhado')
  }
  const now = config.now ?? Date.now
  const startedAt = now()
  const navigationTimeout = config.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS
  const actionTimeout = config.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
  const sessions = new SessionManager({ headless: config.headless ?? true })

  const tokenBuffer = Buffer.from(config.token, 'utf8')
  function authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? ''
    const value = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    const candidate = Buffer.from(value, 'utf8')
    // timingSafeEqual exige comprimentos iguais; comprimento diferente já é
    // recusa — comparar antes não vaza mais que o próprio 401.
    return candidate.length === tokenBuffer.length && timingSafeEqual(candidate, tokenBuffer)
  }

  function json(response: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(data)
  }

  async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > 1_048_576) {
        throw new Error('corpo maior que 1MiB')
      }
      chunks.push(chunk as Buffer)
    }
    if (chunks.length === 0) return {}
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('corpo não é um objeto JSON')
    }
    return parsed as Record<string, unknown>
  }

  /**
   * Resolve uma ref para um locator, recusando geração antiga E ref que não
   * nomeia nada. O `aria-ref=` é engine de seletor de primeira parte do
   * Playwright (a mesma do MCP deles): só resolve contra o snapshot mais
   * recente e cunha ref nova se role/nome mudaram — nó reciclado não herda
   * ref velha. A checagem de geração aqui é a metade voltada ao chamador: a
   * mensagem "tire um snapshot novo" ensina o modelo; o seletor que
   * simplesmente não acha nada, não. O count() resolve na hora — ref
   * inventada é recusada em milissegundos, não no fim do timeout.
   */
  async function resolveRef(session: RuntimeSession, ref: string, expected: number | undefined) {
    if (expected !== undefined && expected !== session.snapshotId) {
      throw new StaleSnapshotError(
        `Essa lista de elementos envelheceu: veio do snapshot ${expected} e a página está no ${session.snapshotId}. Tire um snapshot novo e use as refs dele.`,
      )
    }
    const locator = session.page.locator(`aria-ref=${ref}`)
    if ((await locator.count()) === 0) {
      throw new StaleSnapshotError(
        `Nada nesta página tem a ref ${ref}. Tire um snapshot novo e use as refs que ele devolver.`,
      )
    }
    return locator
  }

  /** O snapshot com a geração desta sessão — allowlist + teto no parser. */
  async function snapshotOf(session: RuntimeSession): Promise<{
    snapshotId: number
    url: string
    title: string
    elements: SnapshotElement[]
    truncated: boolean
  }> {
    session.snapshotId += 1
    const yaml = await session.page.ariaSnapshot({ mode: 'ai' })
    return {
      snapshotId: session.snapshotId,
      url: session.page.url(),
      title: await session.page.title(),
      ...parseAriaSnapshot(yaml),
    }
  }

  /** Executa UMA ação por ref. Toda ação passa pelo volante ANTES de tocar a página. */
  async function performAction(
    session: RuntimeSession,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Recusada, nunca enfileirada: um clique guardado para depois aterrissa
    // em cima do que a pessoa estava fazendo.
    session.control.assertBotMayAct()

    const kind = typeof body['kind'] === 'string' ? body['kind'] : ''
    const ref = typeof body['ref'] === 'string' && body['ref'] !== '' ? body['ref'] : undefined
    const expected = typeof body['snapshotId'] === 'number' ? body['snapshotId'] : undefined
    const acting = { timeout: actionTimeout }

    if (kind === 'click') {
      if (ref === undefined) throw new Error('click exige a ref do elemento')
      await (await resolveRef(session, ref, expected)).click(acting)
      return { action: 'click', ref, url: session.page.url() }
    }

    if (kind === 'type') {
      if (ref === undefined) throw new Error('type exige a ref do campo')
      if (typeof body['text'] !== 'string') throw new Error('type exige o texto a digitar')
      const field = await resolveRef(session, ref, expected)
      // fill, não keystrokes: limpa o campo antes — "põe este valor nesta
      // caixa". Digitar por cima de tentativa anterior daria "AlicAlice".
      await field.fill(body['text'], acting)
      if (body['submit'] === true) {
        await field.press('Enter', acting)
      }
      // O texto NÃO volta na resposta: ela é lida pelo modelo e logada pelo
      // server, e valor digitado em formulário é exatamente onde senha mora.
      // Quem chamou já sabe o que mandou.
      return {
        action: 'type',
        ref,
        characters: body['text'].length,
        submitted: body['submit'] === true,
        url: session.page.url(),
      }
    }

    if (kind === 'press') {
      if (typeof body['key'] !== 'string' || body['key'] === '') {
        throw new Error('press exige o nome da tecla (Enter, Tab...)')
      }
      if (ref !== undefined) {
        await (await resolveRef(session, ref, expected)).press(body['key'], acting)
      } else {
        // Sem ref a tecla vai para a página — é como o bot dá Enter num form
        // inteiro ou Escape num modal.
        await session.page.keyboard.press(body['key'])
      }
      return { action: 'press', key: body['key'], ...(ref !== undefined ? { ref } : {}), url: session.page.url() }
    }

    throw new Error(`ação desconhecida: "${kind}" (aceitas: click, type, press)`)
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request)) {
      // Não descreve o que protege: recusa que explica o endpoint é listagem
      // de diretório para quem está batendo na porta.
      json(response, 401, { error: 'não autorizado' })
      return
    }

    const path = (request.url ?? '').split('?')[0] ?? ''

    if (request.method === 'GET' && path === '/health') {
      json(response, 200, { ok: true, sessions: sessions.count(), uptimeMs: now() - startedAt })
      return
    }

    // Todo o resto vive sob /session/{runtimeId}/…
    const segments = path.split('/').filter((part) => part !== '')
    if (segments[0] !== 'session' || segments.length < 3) {
      json(response, 404, { error: 'rota desconhecida' })
      return
    }
    const runtimeId = decodeURIComponent(segments[1]!)
    const verb = segments.slice(2).join('/')

    if (request.method === 'GET') {
      if (verb === 'control') {
        const session = sessions.get(runtimeId)
        if (session === undefined) {
          json(response, 404, { error: `runtime desconhecido: ${runtimeId}` })
          return
        }
        json(response, 200, session.control.get() satisfies ControlState)
        return
      }
      json(response, 404, { error: 'rota desconhecida' })
      return
    }

    if (request.method !== 'POST') {
      json(response, 404, { error: 'rota desconhecida' })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readBody(request)
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    if (verb === 'open') {
      const { alreadyOpen } = await sessions.open(runtimeId)
      json(response, 200, { opened: true, runtimeId, alreadyOpen })
      return
    }

    if (verb === 'close') {
      const closed = await sessions.close(runtimeId)
      // Idempotente de propósito: o disposer do kernel e um close explícito
      // podem ambos chegar; o segundo não é erro.
      json(response, 200, { closed })
      return
    }

    // Daqui para baixo a sessão precisa existir.
    const session = sessions.get(runtimeId)
    if (session === undefined) {
      json(response, 404, { error: `runtime desconhecido: ${runtimeId} — abra a sessão primeiro` })
      return
    }

    switch (verb) {
      case 'navigate': {
        if (typeof body['url'] !== 'string') {
          json(response, 400, { error: 'navigate exige a url' })
          return
        }
        try {
          session.control.assertBotMayAct()
        } catch (error) {
          if (error instanceof ControlError) {
            json(response, 409, { error: error.message, humanHasControl: true })
            return
          }
          throw error
        }
        const verdict = await checkNavigationTarget(body['url'], {
          ...(config.allowPrivateHosts !== undefined
            ? { allowPrivateHosts: config.allowPrivateHosts }
            : {}),
          ...(config.resolve !== undefined ? { resolve: config.resolve } : {}),
        })
        if (!verdict.allowed) {
          // 403 com o MOTIVO: a recusa de egress é política, não falha — o
          // bot precisa do texto para explicar e não insistir.
          json(response, 403, { error: verdict.reason, refused: true })
          return
        }
        try {
          await session.page.goto(verdict.url, {
            waitUntil: 'domcontentloaded',
            timeout: navigationTimeout,
          })
          // Documento novo apaga todos os carimbos: toda ref entregue até
          // agora perdeu o sentido — a geração sobe para que a ação antiga
          // falhe com "tire um snapshot novo", não com seletor mudo.
          session.snapshotId += 1
          json(response, 200, { url: session.page.url(), title: await session.page.title() })
        } catch (error) {
          // A página é a superfície de trabalho do bot: navegação que falhou
          // é RELATADA (o transcript precisa dizer o que houve) e o browser
          // continua utilizável.
          json(response, 502, {
            error: error instanceof Error ? error.message : 'navegação falhou',
          })
        }
        return
      }

      case 'snapshot': {
        try {
          json(response, 200, await snapshotOf(session))
        } catch (error) {
          json(response, 502, {
            error: error instanceof Error ? error.message : 'snapshot falhou',
          })
        }
        return
      }

      case 'act': {
        try {
          json(response, 200, await performAction(session, body))
        } catch (error) {
          // Ref velha é engano do CHAMADOR e se conserta com snapshot novo:
          // 409, não 502 — o computador está bem e repetir igual não ajuda.
          if (error instanceof StaleSnapshotError) {
            json(response, 409, { error: error.message, stale: true })
            return
          }
          // 409 também, pelo mesmo motivo: nada quebrou, é só esperar.
          if (error instanceof ControlError) {
            json(response, 409, { error: error.message, humanHasControl: true })
            return
          }
          json(response, 502, {
            error: error instanceof Error ? error.message : 'a ação falhou',
          })
        }
        return
      }

      case 'control/take': {
        json(response, 200, session.control.take())
        return
      }

      case 'control/release': {
        json(response, 200, session.control.release())
        return
      }

      case 'control/request': {
        // O bot pedindo ajuda. NÃO toma o controle: diz que travou e por quê.
        json(response, 200, session.control.requestHelp(body['reason']))
        return
      }

      default:
        json(response, 404, { error: 'rota desconhecida' })
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  return {
    server,
    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        // 127.0.0.1 de propósito: expor na rede é decisão do M2, junto com o
        // enrolamento — a mesma nota de escopo do worker-daemon.
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          resolve(typeof address === 'object' && address !== null ? address.port : port)
        })
      })
    },
    async close(): Promise<void> {
      // Primeiro as sessões (Chromium solta os contextos), depois a porta —
      // fechar a porta primeiro deixaria contextos órfãos sem quem os feche.
      await sessions.closeAll()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}
