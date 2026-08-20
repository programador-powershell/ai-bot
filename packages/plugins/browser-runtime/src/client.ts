/**
 * O cliente HTTP do agent-computer — a metade "fio" do seam ctx.browser.
 *
 * Deliberadamente burro: nenhuma política mora aqui (a regra task-scoped é do
 * service). O fetch é injetável porque os testes de RECUSA precisam afirmar
 * que NENHUM HTTP aconteceu — recusa de política acontece antes do fio.
 *
 * Os erros do computador voltam TIPADOS com as flags do contrato (stale /
 * humanHasControl / refused): o agent loop trata cada um diferente — stale se
 * conserta com snapshot novo, humano no controle se espera, egress recusado
 * não se insiste.
 */

/** O elemento como o agent-computer o publica (espelho do SnapshotElement). */
export interface BrowserElement {
  ref: string
  role: string
  name: string
  value?: string
  disabled?: boolean
  checked?: boolean
}

export interface BrowserSnapshot {
  snapshotId: number
  url: string
  title: string
  elements: BrowserElement[]
  truncated: boolean
}

export interface BrowserAction {
  kind: 'click' | 'type' | 'press'
  ref?: string
  snapshotId?: number
  text?: string
  submit?: boolean
  key?: string
}

/** Falha vinda do computador, com as flags que mudam a reação do chamador. */
export class BrowserComputerError extends Error {
  override name = 'BrowserComputerError'
  readonly status: number
  readonly stale: boolean
  readonly humanHasControl: boolean
  readonly refused: boolean

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message)
    this.status = status
    this.stale = body['stale'] === true
    this.humanHasControl = body['humanHasControl'] === true
    this.refused = body['refused'] === true
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface AgentComputerClientConfig {
  baseUrl: string
  token: string
  /** Injetável para teste; ausente = fetch global do Node. */
  fetchFn?: FetchLike
}

export class AgentComputerClient {
  readonly #baseUrl: string
  readonly #token: string
  readonly #fetch: FetchLike

  constructor(config: AgentComputerClientConfig) {
    // Sem barra final: as rotas abaixo já começam com /.
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.#token = config.token
    this.#fetch = config.fetchFn ?? ((url, init) => fetch(url, init))
  }

  async #post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const answer = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      throw new BrowserComputerError(
        typeof answer['error'] === 'string' ? answer['error'] : `agent-computer respondeu ${response.status}`,
        response.status,
        answer,
      )
    }
    return answer
  }

  async open(runtimeId: string): Promise<{ alreadyOpen: boolean }> {
    const answer = await this.#post(`/session/${encodeURIComponent(runtimeId)}/open`, {})
    return { alreadyOpen: answer['alreadyOpen'] === true }
  }

  async close(runtimeId: string): Promise<boolean> {
    const answer = await this.#post(`/session/${encodeURIComponent(runtimeId)}/close`, {})
    return answer['closed'] === true
  }

  async navigate(runtimeId: string, url: string): Promise<{ url: string; title: string }> {
    const answer = await this.#post(`/session/${encodeURIComponent(runtimeId)}/navigate`, { url })
    return { url: String(answer['url'] ?? ''), title: String(answer['title'] ?? '') }
  }

  async snapshot(runtimeId: string): Promise<BrowserSnapshot> {
    const answer = await this.#post(`/session/${encodeURIComponent(runtimeId)}/snapshot`, {})
    return {
      snapshotId: Number(answer['snapshotId'] ?? 0),
      url: String(answer['url'] ?? ''),
      title: String(answer['title'] ?? ''),
      elements: Array.isArray(answer['elements']) ? (answer['elements'] as BrowserElement[]) : [],
      truncated: answer['truncated'] === true,
    }
  }

  async act(runtimeId: string, action: BrowserAction): Promise<Record<string, unknown>> {
    return this.#post(`/session/${encodeURIComponent(runtimeId)}/act`, { ...action })
  }
}
