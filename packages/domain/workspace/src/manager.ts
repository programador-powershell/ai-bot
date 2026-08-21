/**
 * O gerente de workspaces: congela o plano, materializa e PROMOVE com cerca —
 * porte de internal/workspace/manager.go do oráculo Go.
 *
 * A divisão de autoridade da spec: o worker só publica em STAGING; quem
 * promove é o CONTROL PLANE, e só a época que ainda é dona. É a regra do
 * escritor único (que já valia para o log) aplicada aos arquivos.
 *
 * A partir da Onda 6 o ONDE/COMO dos bytes vive atrás de um seam
 * (WorkspaceBackend): o local é o padrão; o Puter entra como OUTRO backend sem
 * tocar UMA LINHA da cerca abaixo — que é exatamente o que o desenho prometia.
 */

import {
  LOCAL_WORKER,
  HOST_SNAPSHOT,
  LIVE_REVISION,
  validatePlan,
  type WorkspacePlan,
} from './plan.js'
import {
  LocalWorkspaceBackend,
  type PlanContext,
  type Publication,
  type WorkspaceBackend,
} from './backend.js'
import type { WorkspaceExecution } from './execution.js'

export type { Publication } from './backend.js'

/**
 * A CERCA: o plano foi congelado com um worker/época que não detém mais o
 * lease da tarefa. Um worker velho pode até terminar o trabalho; ele não
 * consegue transformá-lo em verdade.
 */
export class StaleWorkspaceError extends Error {
  override name = 'StaleWorkspaceError'
  constructor() {
    super('workspace de uma época que já passou — o lease é de outro worker')
  }
}

/** Quem detém a tarefa agora, e desde qual época. */
export interface CurrentLease {
  workerId: string
  epoch: number
}

/**
 * O seam de leases que a cerca consulta. A Fleet do domain/workers o
 * implementa estruturalmente; a v1 local responde sempre local/1. A troca de
 * implementação não toca na cerca.
 */
export interface Leases {
  currentLease(taskId: string): Promise<CurrentLease>
}

/** v1: um processo, um worker, época fixa. */
class LocalLeases implements Leases {
  async currentLease(): Promise<CurrentLease> {
    return { workerId: LOCAL_WORKER, epoch: 1 }
  }
}

/** O que o chamador sabe na hora de congelar; o resto é decisão do gerente. */
export interface PlanRequest {
  sessionId: string
  /** Vazio = turno de conversa, fora de uma Task de equipe. */
  taskId?: string
  botId?: string
  /** Zero vira 1: a primeira tentativa. */
  attempt?: number
  goalId?: string
}

export interface WorkspaceManagerOptions {
  /**
   * Resolve a pasta de projeto de uma sessão — o backend local a usa para o
   * Source (a MESMA função que alimentava o Toolbox.Root do oráculo). Backends
   * remotos (puter) ignoram: para eles o endereço é o Goal, não uma pasta.
   */
  roots?: (sessionId: string) => string
  /** O dono dos leases DE VERDADE (a frota). Ausente = local/1 fixo da v1. */
  leases?: Leases
  /**
   * O backend dos bytes. Ausente = local (esta máquina). É por AQUI que o
   * Puter entra sem que a cerca abaixo mude.
   */
  backend?: WorkspaceBackend
}

export class WorkspaceManager {
  readonly #roots: ((sessionId: string) => string) | undefined
  readonly #leases: Leases
  readonly #backend: WorkspaceBackend

  constructor(options: WorkspaceManagerOptions = {}) {
    this.#roots = options.roots
    this.#leases = options.leases ?? new LocalLeases()
    this.#backend = options.backend ?? new LocalWorkspaceBackend()
  }

  /**
   * Congela o contrato da execução. É AQUI que worker, época e workspace são
   * decididos — a ferramenta lá na ponta só lê o que foi congelado. Source e
   * staging vêm do backend (o local endereça a pasta; o puter, o Goal), mas a
   * tríade worker+época que a cerca confere é decidida AQUI, sempre.
   */
  async plan(request: PlanRequest): Promise<WorkspacePlan> {
    const sessionId = request.sessionId.trim()
    if (sessionId === '') {
      throw new Error('plano de workspace sem sessão')
    }
    let taskId = (request.taskId ?? '').trim()
    if (taskId === '') {
      // Turno de conversa: a "tarefa" é a própria sessão. As Tasks de equipe
      // mandam o id de verdade.
      taskId = `chat-${sessionId}`
    }
    let botId = (request.botId ?? '').trim()
    if (botId === '') {
      botId = 'chat'
    }
    const attempt = request.attempt !== undefined && request.attempt > 0 ? request.attempt : 1
    const goalId = (request.goalId ?? '').trim() || `goal-${sessionId}`

    const lease = await this.#leases.currentLease(taskId)

    const root = this.#roots !== undefined ? this.#roots(sessionId).trim() : ''
    const ctx: PlanContext = {
      sessionId,
      goalId,
      taskId,
      botId,
      attempt,
      workerId: lease.workerId,
      leaseEpoch: lease.epoch,
      root,
    }

    const plan: WorkspacePlan = {
      // Determinístico de propósito: mesmo pedido, mesmo id — sem relógio nem
      // aleatório, o plano sobrevive a replay e a comparação em teste.
      id: `wp-${sessionId}-${taskId}-${attempt}`,
      userId: LOCAL_WORKER, // v1: máquina de uma pessoa; multiusuário chega com o Puter
      goalId,
      sessionId,
      taskId,
      botId,
      attempt,
      workerId: lease.workerId,
      leaseEpoch: lease.epoch,
      source: this.#backend.source(ctx),
      runtime: {
        profile: HOST_SNAPSHOT,
        snapshotDigest: HOST_SNAPSHOT,
        arch: process.arch,
      },
      staging: this.#backend.staging(ctx),
      baseline: { revision: LIVE_REVISION, manifestDigest: LIVE_REVISION },
    }
    validatePlan(plan)
    return plan
  }

  /**
   * Transforma o plano em execução NESTA máquina. O QUE isso significa é do
   * backend: no local é resolver a URI de volta para a pasta; no Puter é baixar
   * o snapshot + montar o workspace + preparar o staging local.
   */
  async materialize(plan: WorkspacePlan): Promise<WorkspaceExecution> {
    validatePlan(plan)
    return this.#backend.materialize(plan)
  }

  /**
   * A CERCA em código: só o worker que detém o lease, na época em que o plano
   * foi congelado, transforma staging em verdade. É o cenário §25 da spec —
   * PC-02 que volta do limbo com época velha é RECUSADO; PC-03 na época atual
   * promove. A checagem fica AQUI, indiferente ao backend: por isso a mesma
   * suíte passa com o backend puter injetado (o aceite da Onda 6).
   */
  async promote(plan: WorkspacePlan, result: Publication): Promise<void> {
    const current = await this.#leases.currentLease(plan.taskId)
    if (current.workerId !== plan.workerId || current.epoch !== plan.leaseEpoch) {
      throw new StaleWorkspaceError()
    }
    // A cerca passou: só agora o backend efetiva a publicação de verdade.
    await this.#backend.promote(plan, result)
  }
}
