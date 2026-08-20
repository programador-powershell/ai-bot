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

/**
 * Quem está com o volante da sessão — espelho do ControlState do agent-computer
 * (control.ts). Chega do computador; este cliente não inventa nem guarda: só
 * transporta. O `secretRef`/`secretSnapshotId` diz em QUAL campo um segredo
 * pendente entra — o valor NUNCA trafega por aqui (a cirurgia §3 é de dono da
 * sessão, não de caminho de segredo).
 */
export interface BrowserControlState {
  holder: 'bot' | 'human'
  since: string
  reason?: string
  requested: boolean
  secretWanted?: string
  secretRef?: string
  secretSnapshotId?: number
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
    return this.#unwrap(response)
  }

  /**
   * O GET do agent-computer (só /control hoje). Separado do #post porque um GET
   * com corpo é anomalia de contrato — o volante se LÊ, não se muta com payload.
   */
  async #get(path: string): Promise<Record<string, unknown>> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.#token}` },
    })
    return this.#unwrap(response)
  }

  async #unwrap(response: Response): Promise<Record<string, unknown>> {
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

  /** Lê o ControlState cru do computador (holder/reason/requested/secret). */
  #asControl(answer: Record<string, unknown>): BrowserControlState {
    return {
      holder: answer['holder'] === 'human' ? 'human' : 'bot',
      since: typeof answer['since'] === 'string' ? answer['since'] : '',
      requested: answer['requested'] === true,
      ...(typeof answer['reason'] === 'string' ? { reason: answer['reason'] } : {}),
      ...(typeof answer['secretWanted'] === 'string' ? { secretWanted: answer['secretWanted'] } : {}),
      ...(typeof answer['secretRef'] === 'string' ? { secretRef: answer['secretRef'] } : {}),
      ...(typeof answer['secretSnapshotId'] === 'number'
        ? { secretSnapshotId: answer['secretSnapshotId'] }
        : {}),
    }
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

  /**
   * O VOLANTE da sessão (Take the Wheel). A cirurgia §3 é o que muda aqui: no
   * openbot o controle era por botId (computador permanente); a chave agora é o
   * runtimeId da execução — criado no open, morto no close. O agent-computer
   * (server.ts/control.ts) já é a autoridade do estado; este cliente só o
   * atravessa para a UI forkada. Enquanto o humano segura, a ação do bot é
   * RECUSADA lá (409 humanHasControl) — nunca enfileirada.
   */
  async control(runtimeId: string): Promise<BrowserControlState> {
    return this.#asControl(await this.#get(`/session/${encodeURIComponent(runtimeId)}/control`))
  }

  /** O bot pedindo ajuda: NÃO toma o controle, diz que travou e por quê. */
  async requestControl(runtimeId: string, reason: string): Promise<BrowserControlState> {
    return this.#asControl(
      await this.#post(`/session/${encodeURIComponent(runtimeId)}/control/request`, { reason }),
    )
  }

  /** Uma pessoa assumindo o volante — a partir daqui a ação do bot é recusada. */
  async takeControl(runtimeId: string): Promise<BrowserControlState> {
    return this.#asControl(
      await this.#post(`/session/${encodeURIComponent(runtimeId)}/control/take`, {}),
    )
  }

  /** A pessoa devolvendo o volante ao bot. */
  async releaseControl(runtimeId: string): Promise<BrowserControlState> {
    return this.#asControl(
      await this.#post(`/session/${encodeURIComponent(runtimeId)}/control/release`, {}),
    )
  }
}
