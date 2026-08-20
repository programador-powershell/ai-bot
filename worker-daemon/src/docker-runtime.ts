/**
 * O ContainerRuntime REAL sobre Docker (dockerode) — aprovado pela TI/SI em
 * M11, entra EXATAMENTE pelo seam que o executor local já cumpria.
 *
 * Porte ADAPTADO do supervisor do openbot (MIT, commit 06a1a84 — atribuição em
 * THIRD_PARTY_NOTICES.md), com a cirurgia da spec §3/R6 aplicada: lá o
 * container era MORADA (botId → computador permanente, RestartPolicy
 * unless-stopped, volume de perfil que sobrevive); aqui o container é
 * EXECUÇÃO (spec §32) — nasce para a TaskRun que o pediu e morre com ela, e um
 * bot ocioso consome ZERO containers. O que fica do openbot é o que vale ouro:
 *
 * - **Nomes DERIVADOS, nunca aceitos.** Quem chama diz QUAL TaskRun; nunca diz
 *   qual container. O id passa por regex fechada antes de virar nome — um id
 *   com `/` ou `..` escaparia para outro segmento da API do socket.
 * - **Posse por label.** Todo container criado carrega o label do daemon e o
 *   workerId; destruir e varrer órfãos só toca o que carrega o label — um
 *   container alheio com nome parecido é tratado como inexistente.
 * - **Sem passthrough.** Não existe "rode esta chamada Docker": o socket é
 *   root irrestrito no host, e o daemon oferece verbos de TAREFA, nunca o
 *   socket por uma porta mais educada.
 *
 * O hardening da spec §37, aplicado a TODA execução (cada campo fecha uma rota
 * de fuga específica e nenhum custa à tarefa algo que ela legitimamente
 * precise):
 *
 * - `CapDrop: ALL` — nenhuma capability; cada uma é uma rota documentada de
 *   escape de container.
 * - `no-new-privileges` — nada que rode lá dentro sobe de privilégio, execute
 *   o que executar.
 * - `Memory`/`NanoCpus`/`PidsLimit` — uma tarefa desgovernada é problema DELA,
 *   não de todas as outras no mesmo host.
 * - **SEM socket Docker dentro.** O bind do workspace é o ÚNICO; montar o
 *   socket devolveria root do host à tarefa. Há uma guarda de construção que
 *   recusa qualquer bind com cara de socket — cinto e suspensório, porque o
 *   custo de errar aqui é o host inteiro.
 * - **Rede conforme requirements.** Sem `requirements.network` declarado pela
 *   tarefa, a execução nasce com `NetworkMode: none` — fail-closed, como o
 *   resto da casa.
 *
 * O dockerode fica atrás da interface fina DockerEngine: o unit testa os
 * campos EXATOS do HostConfig contra um engine falso (esta estação não tem
 * engine rodando — fato declarado, nunca fingido), e a validação com engine
 * real é pendência registrada.
 */

import Docker from 'dockerode'
import type { WorkerRecord } from '@aibot2/domain-workers'
import {
  LocalProcessRuntime,
  type ContainerRuntime,
  type ExecutionHandle,
  type ExecutionResult,
  type ExecutionSpec,
} from './runtime.js'

/* ------------------------------------------------------------------------ */
/* Labels e nomes — derivados, nunca aceitos                                  */
/* ------------------------------------------------------------------------ */

/** O label de posse: o runtime só destrói/varre o que o carrega. */
export const OWNER_LABEL = 'aibot2.worker-daemon'
/** A TaskRun dona da execução — a listagem reporta sem parsear nome. */
export const TASK_RUN_LABEL = 'aibot2.task-run'
/** O PC físico que criou o container (a varredura de órfãos filtra por ele). */
export const WORKER_LABEL = 'aibot2.worker-id'
/** A época do lease congelada no plano — parte do EXECUTION TARGET. */
export const EPOCH_LABEL = 'aibot2.lease-epoch'

/** Regex fechada: id vira nome de container; `/`, `.`, `:` e espaço NUNCA. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const MAX_ID = 64

/**
 * Deriva o nome do container a partir da TaskRun. Recusar id fora da regex é
 * fronteira de segurança, não pedantismo: o nome viaja para a API do socket.
 */
export function containerNameFor(taskRunId: string): string {
  if (taskRunId.length === 0 || taskRunId.length > MAX_ID || !SAFE_ID.test(taskRunId)) {
    throw new Error(
      `taskRunId inválido para derivar nome de container: apenas letras, dígitos, hífen e underscore (máx ${MAX_ID})`,
    )
  }
  return `aibot2-run-${taskRunId}`
}

/* ------------------------------------------------------------------------ */
/* O seam fino sobre o dockerode                                              */
/* ------------------------------------------------------------------------ */

/** O HostConfig que TODA criação carrega — os campos do hardening §37. */
export interface EngineHostConfig {
  Binds: string[]
  CapDrop: string[]
  SecurityOpt: string[]
  Memory: number
  NanoCpus: number
  PidsLimit: number
  NetworkMode: string
  RestartPolicy: { Name: string }
}

export interface EngineCreateOptions {
  name: string
  Image: string
  Labels: Record<string, string>
  Env: string[]
  Cmd: string[]
  WorkingDir: string
  HostConfig: EngineHostConfig
}

/** Um container já criado, pelo pouco que o runtime precisa dele. */
export interface EngineContainer {
  id: string
  start(): Promise<void>
  /** Bloqueia até o processo principal sair e devolve o código. */
  wait(): Promise<{ StatusCode: number }>
  /** stdout+stderr acumulados (o daemon publica o desfecho, não faz stream). */
  logs(): Promise<string>
  kill(): Promise<void>
  remove(options: { force: boolean }): Promise<void>
}

/** Um container visto pela varredura de órfãos (só id, labels e remoção). */
export interface OwnedContainerRef {
  id: string
  labels: Record<string, string>
  remove(options: { force: boolean }): Promise<void>
}

/**
 * A interface fina que o unit fecha com um fake. Deliberadamente SEM métodos
 * genéricos ("call", "request"): o que não está aqui, o runtime não faz.
 */
export interface DockerEngine {
  /** Lança quando o engine não responde — a detecção honesta parte daqui. */
  ping(): Promise<void>
  createContainer(options: EngineCreateOptions): Promise<EngineContainer>
  /** Só containers que carregam o label de posse (`OWNER_LABEL=true`). */
  listOwned(): Promise<OwnedContainerRef[]>
}

/* ------------------------------------------------------------------------ */
/* O runtime                                                                  */
/* ------------------------------------------------------------------------ */

export interface DockerRuntimeOptions {
  engine: DockerEngine
  /** O PC físico — entra no label; a varredura só toca containers DESTE worker. */
  workerId: string
  /** Imagem usada quando o spec não traz uma. Sem nenhuma das duas, start recusa. */
  defaultImage?: string
  /** Teto de RAM por execução (default 2 GiB). */
  memoryBytes?: number
  /** Teto de CPU em bilionésimos (default 2 CPUs). */
  nanoCpus?: number
  /** Teto de processos (default 512 — o mesmo do supervisor de origem). */
  pidsLimit?: number
  /** A rede usada QUANDO a tarefa declarou requirements.network. */
  networkMode?: string
  /** Prazo do ping na detecção (default 2s) — engine mudo não pendura o daemon. */
  pingTimeoutMs?: number
}

const DEFAULT_MEMORY_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_NANO_CPUS = 2_000_000_000
const DEFAULT_PIDS_LIMIT = 512
const DEFAULT_PING_TIMEOUT_MS = 2_000

/** Cara de socket Docker em qualquer plataforma — nenhum bind pode ter. */
const SOCKET_SHAPES = ['docker.sock', 'docker_engine', '/var/run/docker']

interface RunningExecution {
  container: EngineContainer
  handle: ExecutionHandle
}

export class DockerContainerRuntime implements ContainerRuntime {
  readonly #engine: DockerEngine
  readonly #workerId: string
  readonly #defaultImage: string | undefined
  readonly #memoryBytes: number
  readonly #nanoCpus: number
  readonly #pidsLimit: number
  readonly #networkMode: string
  readonly #pingTimeoutMs: number
  readonly #running = new Map<string, RunningExecution>()

  constructor(options: DockerRuntimeOptions) {
    this.#engine = options.engine
    this.#workerId = options.workerId
    this.#defaultImage = options.defaultImage
    this.#memoryBytes = options.memoryBytes ?? DEFAULT_MEMORY_BYTES
    this.#nanoCpus = options.nanoCpus ?? DEFAULT_NANO_CPUS
    this.#pidsLimit = options.pidsLimit ?? DEFAULT_PIDS_LIMIT
    this.#networkMode = options.networkMode ?? 'bridge'
    this.#pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS
  }

  id(): string {
    return 'docker'
  }

  /**
   * O engine responde AGORA? Honesto por construção: qualquer erro (socket
   * ausente, pipe morto, timeout) é `false` — nunca "provavelmente sim".
   */
  async available(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.#engine.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('ping do engine estourou o prazo')),
            this.#pingTimeoutMs,
          )
        }),
      ])
      return true
    } catch {
      return false
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async start(spec: ExecutionSpec): Promise<ExecutionHandle> {
    const name = containerNameFor(spec.taskRunId)
    const image = spec.image ?? this.#defaultImage
    if (image === undefined || image.trim() === '') {
      throw new Error('execução docker sem imagem — o spec ou o runtime precisam declarar uma')
    }
    if (spec.command.length === 0 || spec.command[0] === '') {
      throw new Error('execução docker sem comando')
    }
    if (spec.localRoot.trim() === '') {
      // O workspace materializado é o ÚNICO bind — sem ele não há onde a
      // tarefa trabalhar, e um container sem workspace não é uma execução.
      throw new Error('execução docker sem workspace materializado')
    }

    const binds = [`${spec.localRoot}:/workspace`]
    // A guarda de construção: NENHUM bind com cara de socket Docker, nunca.
    // O código acima não monta socket — mas o custo de uma regressão aqui é
    // root do host, então a recusa é explícita, não implícita.
    for (const bind of binds) {
      const lower = bind.toLowerCase()
      if (SOCKET_SHAPES.some((shape) => lower.includes(shape))) {
        throw new Error(`bind recusado: socket Docker nunca entra no container de tarefa (${bind})`)
      }
    }

    const container = await this.#engine.createContainer({
      name,
      Image: image,
      Labels: {
        [OWNER_LABEL]: 'true',
        [TASK_RUN_LABEL]: spec.taskRunId,
        [WORKER_LABEL]: this.#workerId,
        [EPOCH_LABEL]: String(spec.plan.leaseEpoch),
      },
      Env: Object.entries(spec.env ?? {}).map(([key, value]) => `${key}=${value}`),
      Cmd: spec.command,
      WorkingDir: '/workspace',
      HostConfig: {
        Binds: binds,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: this.#memoryBytes,
        NanoCpus: this.#nanoCpus,
        PidsLimit: this.#pidsLimit,
        // Fail-closed: sem requirements.network declarado, sem rede.
        NetworkMode: spec.network === true ? this.#networkMode : 'none',
        // Container é EXECUÇÃO: nunca renasce sozinho (a diferença central
        // para o unless-stopped do supervisor de origem, que criava moradas).
        RestartPolicy: { Name: 'no' },
      },
    })

    let cancelled = false
    await container.start()

    const finished: Promise<ExecutionResult> = (async () => {
      const { StatusCode } = await container.wait()
      const output = await container.logs().catch(() => '')
      if (cancelled) {
        return { ok: false, output, error: 'cancelado', cancelled: true }
      }
      if (StatusCode === 0) {
        return { ok: true, output }
      }
      return { ok: false, output, error: `container saiu com código ${StatusCode}` }
    })().catch((error: unknown) => ({
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }))

    const handle: ExecutionHandle = {
      wait: () => finished,
      cancel: async () => {
        cancelled = true
        // kill, não stop: cancelamento não espera flush de nada — o que não
        // foi publicado morre com o container, por desenho.
        await container.kill().catch(() => undefined)
      },
    }
    this.#running.set(spec.taskRunId, { container, handle })
    return handle
  }

  /**
   * O fim da tarefa SEMPRE passa por aqui: remove à força o container da
   * TaskRun. O estrago que não foi publicado morre dentro dele.
   */
  async destroy(taskRunId: string): Promise<void> {
    const running = this.#running.get(taskRunId)
    if (running === undefined) return
    await running.handle.cancel('destruída')
    await running.container.remove({ force: true }).catch(() => undefined)
    this.#running.delete(taskRunId)
  }

  /**
   * Varre execuções órfãs de um daemon anterior DESTE worker: containers com
   * o nosso label de posse que nenhuma TaskRun viva reivindica. Só o que
   * carrega o label E o workerId — container alheio é inexistente para nós.
   * Devolve os ids das TaskRuns varridas (o boot loga, nunca esconde).
   */
  async reapOrphans(): Promise<string[]> {
    const owned = await this.#engine.listOwned()
    const reaped: string[] = []
    for (const container of owned) {
      if (container.labels[OWNER_LABEL] !== 'true') continue
      if (container.labels[WORKER_LABEL] !== this.#workerId) continue
      const taskRunId = container.labels[TASK_RUN_LABEL] ?? ''
      if (taskRunId !== '' && this.#running.has(taskRunId)) continue
      await container.remove({ force: true }).catch(() => undefined)
      reaped.push(taskRunId !== '' ? taskRunId : container.id)
    }
    return reaped
  }
}

/* ------------------------------------------------------------------------ */
/* O adapter dockerode — a ÚNICA superfície que toca o socket                 */
/* ------------------------------------------------------------------------ */

/**
 * Desmultiplexa o formato de log do Docker sem TTY: quadros de cabeçalho de
 * 8 bytes [stream, 0, 0, 0, tamanho BE32] seguidos do payload. Um buffer que
 * não tem essa forma (TTY ligado) volta como texto puro — nunca lixo binário.
 */
export function demuxDockerLogs(raw: Buffer): string {
  if (raw.length === 0) return ''
  const first = raw[0]
  // Quadro válido começa com stream 0|1|2 e byte 1 zerado; texto puro não.
  if (first === undefined || first > 2 || raw.length < 8 || raw[1] !== 0) {
    return raw.toString('utf8')
  }
  let offset = 0
  const parts: string[] = []
  while (offset + 8 <= raw.length) {
    const size = raw.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = Math.min(start + size, raw.length)
    parts.push(raw.subarray(start, end).toString('utf8'))
    offset = start + size
  }
  return parts.join('')
}

/**
 * O engine de verdade. Fica numa factory (e não num singleton de módulo) para
 * que importar este arquivo nunca toque o socket — quem quer o Docker pede.
 */
export function dockerodeEngine(options: { socketPath?: string } = {}): DockerEngine {
  const docker =
    options.socketPath !== undefined ? new Docker({ socketPath: options.socketPath }) : new Docker()

  function wrap(container: Docker.Container): EngineContainer {
    return {
      id: container.id,
      async start() {
        await container.start()
      },
      async wait() {
        const result = (await container.wait()) as { StatusCode: number }
        return { StatusCode: result.StatusCode }
      },
      async logs() {
        const raw = (await container.logs({
          stdout: true,
          stderr: true,
          follow: false,
        })) as unknown as Buffer
        return demuxDockerLogs(raw)
      },
      async kill() {
        await container.kill()
      },
      async remove(removeOptions) {
        // v:true — volumes anônimos morrem junto: execução efêmera não deixa rastro.
        await container.remove({ force: removeOptions.force, v: true })
      },
    }
  }

  return {
    async ping() {
      await docker.ping()
    },
    async createContainer(create) {
      const container = await docker.createContainer({
        name: create.name,
        Image: create.Image,
        Labels: create.Labels,
        Env: create.Env,
        Cmd: create.Cmd,
        WorkingDir: create.WorkingDir,
        HostConfig: {
          Binds: create.HostConfig.Binds,
          CapDrop: create.HostConfig.CapDrop,
          SecurityOpt: create.HostConfig.SecurityOpt,
          Memory: create.HostConfig.Memory,
          NanoCpus: create.HostConfig.NanoCpus,
          PidsLimit: create.HostConfig.PidsLimit,
          NetworkMode: create.HostConfig.NetworkMode,
          RestartPolicy: create.HostConfig.RestartPolicy,
        },
      })
      return wrap(container)
    },
    async listOwned() {
      const list = await docker.listContainers({
        all: true,
        filters: { label: [`${OWNER_LABEL}=true`] },
      })
      return list.map((info) => ({
        id: info.Id,
        labels: info.Labels ?? {},
        remove: async (removeOptions: { force: boolean }) => {
          await docker.getContainer(info.Id).remove({ force: removeOptions.force, v: true })
        },
      }))
    },
  }
}

/* ------------------------------------------------------------------------ */
/* Detecção honesta                                                           */
/* ------------------------------------------------------------------------ */

export interface DetectedRuntime {
  runtime: ContainerRuntime
  /** O engine respondeu de verdade — é isto que as capabilities anunciam. */
  docker: boolean
}

export interface DetectOptions {
  workerId: string
  /** Injete um engine nos testes; ausente usa o dockerode real. */
  engine?: DockerEngine
  runtimeOptions?: Omit<DockerRuntimeOptions, 'engine' | 'workerId'>
}

/**
 * Decide qual runtime este daemon usa AGORA: engine respondendo → Docker;
 * qualquer outra coisa → executor local, como hoje. A regra é NUNCA fingir:
 * a resposta `docker` reflete um ping que aconteceu, não uma esperança.
 */
export async function detectContainerRuntime(options: DetectOptions): Promise<DetectedRuntime> {
  const engine = options.engine ?? dockerodeEngine()
  const candidate = new DockerContainerRuntime({
    engine,
    workerId: options.workerId,
    ...options.runtimeOptions,
  })
  if (await candidate.available()) {
    return { runtime: candidate, docker: true }
  }
  return { runtime: new LocalProcessRuntime(), docker: false }
}

/**
 * O anúncio de capabilities conforme a detecção: com engine, `docker: true`;
 * sem engine, o campo NEM EXISTE — anunciar `false` ainda seria anunciar um
 * Docker sobre o qual falamos; ausência é o retrato exato.
 */
export function announceDocker(worker: WorkerRecord, docker: boolean): WorkerRecord {
  const capabilities = { ...worker.capabilities }
  if (docker) {
    capabilities.docker = true
  } else {
    delete capabilities.docker
  }
  return { ...worker, capabilities }
}
