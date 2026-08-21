/**
 * O TaskExecutor CONCRETO — o elo que faltava (matriz §2: "o scheduler NÃO liga
 * o worker-daemon de verdade"). Até a Onda 5 o executor era um seam só
 * implementado em teste; aqui ele é o cliente HTTP dos 9 verbos §36 do
 * worker-daemon, e é ISTO que transforma a decisão do control plane em execução
 * numa máquina de verdade.
 *
 * As invariantes do desenho que este cliente honra (e por quê):
 *
 * - **O executor NÃO decide máquina.** O scheduler (§28) já escolheu; o
 *   assignment chega com `worker` e o `plan` CONGELADO ao lado. O executor só
 *   resolve o endpoint do daemon dessa máquina e despacha. Escolher aqui seria
 *   uma segunda autoridade sobre a mesma decisão.
 * - **O LEASE e a ÉPOCA viajam no despacho**, colhidos do PLANO congelado
 *   (`plan.workerId`/`plan.leaseEpoch`), não do relógio da execução — o daemon
 *   recusa lease de outro worker/época na porta (a mesma tríade da cerca).
 * - **O worker PUBLICA e PARA; quem promove é o control plane.** Este cliente
 *   leva a execução até `/staging/publish` (área de espera DA ÉPOCA) e colhe o
 *   texto em `/task/result`; a CERCA (worker+época) e o promote são do motor
 *   (engine.ts), depois que `run` retorna. Época velha que volta bate na cerca
 *   lá, não aqui.
 * - **`/task/result` destrói a execução** (container efêmero — o "release" do
 *   aceite): o que não foi publicado morre com ela. Por isso publicamos ANTES
 *   do result terminal, e o result terminal é a última chamada.
 * - **fs/git/proc no runtime da TAREFA** (dívida 6): o RuntimeResolver admite o
 *   TIPO de runtime na máquina escolhida e resolve o alvo — a extensão §28 que
 *   o choose.ts não cobre (wsl/vps).
 *
 * Ordem dos verbos: health → acquire → (prepare) → materialize → start → renew
 * → poll publish → result. `cancel` entra no caminho de erro (execução travada
 * ou falha depois do start não fica órfã).
 */

import type { WorkerRecord } from '@aibot2/domain-workers'
import type { WorkspacePlan } from '@aibot2/domain-workspace'
import {
  RuntimeResolver,
  parseRequirements,
  type ManifestFile,
  type RuntimeTarget,
} from '@aibot2/domain-runtime'
import type { TaskAssignment, TaskExecutor } from './engine.js'

/** O endpoint do daemon de UM worker — 127.0.0.1:PORT no M1 (loopback por decisão). */
export interface DaemonEndpoint {
  baseUrl: string
  /** O token de enrolamento DESTA máquina (cofre/env do processo; nunca no código). */
  token: string
}

/**
 * Um evento RELATADO pelo daemon — a forma de fio, deliberadamente SEM `seq` e
 * sem `session` (quem numera é o sequenciador do server). Espelho estrutural do
 * ReportedEvent do worker-daemon, redeclarado aqui para o control plane NÃO
 * depender do pacote do daemon (a direção do grafo é control plane → daemon
 * pela rede, nunca por import).
 */
export interface ReportedEvent {
  id: string
  ts: string
  kind: string
  from: { kind: string; id: string }
  payload?: unknown
}

/** O comando de execução da tarefa, decidido pelo control plane, mais imagem/rede do runtime. */
export interface DaemonCommand {
  /** Vetor JÁ aprovado — nunca string de shell (o daemon roda com shell:false). */
  command: string[]
  /** A imagem do container quando o runtime é docker (o executor local ignora). */
  image?: string
  /** Rede fail-closed: sem declaração, a execução docker nasce SEM rede. */
  network?: boolean
}

/** fetch mínimo que o cliente usa — injetável para teste sem daemon de pé. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>

export interface DaemonTaskExecutorOptions {
  /**
   * Resolve o endpoint do daemon do worker ESCOLHIDO. Ausente para um worker é
   * erro NOMEADO em `run` — o scheduler não deveria escolher máquina sem daemon,
   * e fingir um baseUrl seria a mentira que os seams da casa existem para não
   * repetir.
   */
  endpointFor: (worker: WorkerRecord) => DaemonEndpoint | undefined
  /**
   * Monta o comando da tarefa (o entrypoint do agent loop no runtime). SEM
   * default que invente: o que a tarefa roda é decisão de produto do chamador —
   * o roteador de modelo (M2) e o toolbox são dívidas declaradas, e um default
   * fabricaria execução onde não há.
   */
  commandFor: (assignment: TaskAssignment, target: RuntimeTarget) => DaemonCommand
  /** O ambiente escolhido na sessão (host|docker|wsl|vps). Ausente = os requisitos decidem o runtime. */
  environmentFor?: (assignment: TaskAssignment) => string | undefined
  /**
   * Locks para o fingerprint de snapshot (`/runtime/prepare`). Ausente ou vazio
   * PULA prepare — o snapshot `host` não tem dependências a fingerprintar (e o
   * daemon recusaria uma lista sem lockfile).
   */
  manifestsFor?: (assignment: TaskAssignment) => { base: string; manifests: ManifestFile[] } | undefined
  /**
   * Sink dos eventos RELATADOS pelo daemon — o server os sequencia e grava no
   * log da sessão. Ausente = descartados (o journal do motor já tem os estados
   * de Task; estes são o relato fino do worker).
   */
  onEvents?: (assignment: TaskAssignment, events: ReportedEvent[]) => void | Promise<void>
  resolver?: RuntimeResolver
  fetch?: FetchLike
  /** Cadência do poll de conclusão (publish 409 = ainda rodando). */
  pollIntervalMs?: number
  /** Teto de polls antes de cancelar e desistir (execução travada). */
  maxPolls?: number
  /** Espera entre polls — injeção de teste (sem relógio real). */
  sleep?: (ms: number) => Promise<void>
}

interface CallResult {
  status: number
  body: Record<string, unknown>
}

const DEFAULT_POLL_INTERVAL_MS = 40
const DEFAULT_MAX_POLLS = 300

export class DaemonTaskExecutor implements TaskExecutor {
  readonly #options: DaemonTaskExecutorOptions
  readonly #resolver: RuntimeResolver
  readonly #fetch: FetchLike
  readonly #pollIntervalMs: number
  readonly #maxPolls: number
  readonly #sleep: (ms: number) => Promise<void>

  constructor(options: DaemonTaskExecutorOptions) {
    this.#options = options
    this.#resolver = options.resolver ?? new RuntimeResolver()
    // O fetch global do Node 24 / Bun; injetável para teste sem daemon.
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>)
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.#maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  }

  async run(assignment: TaskAssignment): Promise<string> {
    const { task, taskRunId, worker, plan } = assignment

    const endpoint = this.#options.endpointFor(worker)
    if (endpoint === undefined) {
      throw new Error(
        `sem daemon para o worker escolhido ${worker.id} — o scheduler escolheu uma máquina sem endpoint de execução`,
      )
    }

    // O runtime da TAREFA + admissão do TIPO na máquina escolhida (extensão §28,
    // fecha a ponta wsl/vps que o choose.ts não cobre). Recusar aqui, antes do
    // acquire, é o custo baixo na hora certa.
    const requirements = parseRequirements(task.requirements)
    const environment = this.#options.environmentFor?.(assignment)
    const target = this.#resolver.resolveTarget(requirements, environment)
    const admission = this.#resolver.admit(target, worker.capabilities)
    if (!admission.ok) {
      throw new Error(
        `runtime ${target.kind} não roda em ${worker.id}: ${admission.reason}`,
      )
    }

    // O lease e a ÉPOCA viajam do PLANO congelado — nunca do relógio da execução.
    const lease = { workerId: plan.workerId, epoch: plan.leaseEpoch }
    const collected: ReportedEvent[] = []

    // Verbo de vivacidade: um daemon que não responde vira erro nomeado, não um
    // acquire pendurado.
    const health = await this.#call(endpoint, 'GET', '/health')
    if (health.status !== 200) {
      throw new Error(`daemon de ${worker.id} não respondeu ao /health (${health.status})`)
    }

    // acquire — a tríade (worker+época) entra na porta do daemon.
    await this.#must(endpoint, '/task/acquire', { taskRunId, taskId: task.id, lease })

    // Do start em diante, uma falha não pode deixar execução órfã: cancel no catch.
    let started = false
    try {
      // prepare — só quando há lock (snapshot de dependências); host pula.
      const manifests = this.#options.manifestsFor?.(assignment)
      if (manifests !== undefined && manifests.manifests.length > 0) {
        await this.#must(endpoint, '/runtime/prepare', {
          taskRunId,
          base: manifests.base,
          manifests: manifests.manifests,
        })
      }

      // materialize — o PLANO congelado viaja; o daemon confere worker+época.
      await this.#must(endpoint, '/workspace/materialize', { taskRunId, plan })

      // start — comando decidido pelo control plane; imagem/rede do runtime.
      const cmd = this.#options.commandFor(assignment, target)
      started = true
      await this.#must(endpoint, '/task/start', {
        taskRunId,
        command: cmd.command,
        ...(cmd.image !== undefined ? { image: cmd.image } : {}),
        ...(cmd.network !== undefined ? { network: cmd.network } : {}),
      })

      // renew — segura o TTL da execução e exercita o verbo antes do poll.
      await this.#call(endpoint, 'POST', '/lease/renew', { taskRunId, lease })

      // poll até publicar: /staging/publish é o ÚNICO verbo que diz "terminou"
      // sem destruir a execução (o /task/result destrói no primeiro "done"), por
      // isso a conclusão é detectada por ele e o result vem depois.
      await this.#awaitPublished(endpoint, taskRunId, lease)
    } catch (error) {
      if (started) {
        // Best-effort: uma execução que ficou de pé não vira zumbi por causa de
        // um erro nosso — mas a falha original é o que sobe.
        await this.#call(endpoint, 'POST', '/task/cancel', {
          taskRunId,
          reason: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }
      throw error
    }

    // result — colhe a saída, os eventos e DESTRÓI a execução (o release).
    const final = await this.#must(endpoint, '/task/result', { taskRunId })
    if (Array.isArray(final['events'])) {
      collected.push(...(final['events'] as ReportedEvent[]))
    }
    await this.#flush(assignment, collected)

    if (final['ok'] !== true) {
      // Saída ≠ 0 é FALHA: o motor registra failure e a cerca nem roda para este
      // texto — resultado ruim não vira verdade por omissão.
      const detail = typeof final['error'] === 'string' ? final['error'] : 'a execução falhou no worker sem detalhe'
      throw new Error(detail)
    }
    return typeof final['output'] === 'string' ? final['output'] : ''
  }

  /* ------------------------------ internos ------------------------------- */

  async #awaitPublished(
    endpoint: DaemonEndpoint,
    taskRunId: string,
    lease: { workerId: string; epoch: number },
  ): Promise<void> {
    for (let poll = 0; poll < this.#maxPolls; poll++) {
      const publish = await this.#call(endpoint, 'POST', '/staging/publish', { taskRunId })
      if (publish.status === 200) return
      if (publish.status === 409) {
        // 409 aqui é "a execução não terminou" — renova o lease (keepalive, best
        // effort: falhar a renovação não aborta o poll) e espera a cadência.
        await this.#call(endpoint, 'POST', '/lease/renew', { taskRunId, lease }).catch(() => {})
        await this.#sleep(this.#pollIntervalMs)
        continue
      }
      throw new Error(`publish recusado (${publish.status}): ${this.#errorOf(publish.body)}`)
    }
    throw new Error(
      `execução de ${taskRunId} não terminou após ${this.#maxPolls} verificações — desistindo`,
    )
  }

  async #flush(assignment: TaskAssignment, events: ReportedEvent[]): Promise<void> {
    if (events.length === 0 || this.#options.onEvents === undefined) return
    await this.#options.onEvents(assignment, events)
  }

  /** POST que EXIGE 200 — não-200 vira exceção com a mensagem do daemon. */
  async #must(
    endpoint: DaemonEndpoint,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.#call(endpoint, 'POST', path, body)
    if (result.status !== 200) {
      throw new Error(`${path} recusado pelo daemon (${result.status}): ${this.#errorOf(result.body)}`)
    }
    return result.body
  }

  /** Chamada crua — devolve status + corpo, sem lançar (o poll precisa ler o 409). */
  async #call(
    endpoint: DaemonEndpoint,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<CallResult> {
    const response = await this.#fetch(`${endpoint.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    let parsed: unknown = {}
    try {
      parsed = await response.json()
    } catch {
      // Corpo vazio ou não-JSON: mantém {} — o status já diz o essencial.
    }
    const asObject =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    return { status: response.status, body: asObject }
  }

  #errorOf(body: Record<string, unknown>): string {
    return typeof body['error'] === 'string' ? body['error'] : 'sem detalhe'
  }
}
