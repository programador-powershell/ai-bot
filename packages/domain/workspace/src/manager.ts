/**
 * O gerente de workspaces: congela o plano, materializa e PROMOVE com cerca —
 * porte de internal/workspace/manager.go do oráculo Go.
 *
 * A divisão de autoridade da spec: o worker só publica em STAGING; quem
 * promove é o CONTROL PLANE, e só a época que ainda é dona. É a regra do
 * escritor único (que já valia para o log) aplicada aos arquivos.
 *
 * O backend v1 é local (uma pasta desta máquina, staging inplace); o Puter e
 * o worker-daemon trocam o backend DEPOIS — a cerca não muda uma linha, que é
 * exatamente o que o desenho prometia.
 */

import {
  HOST_SNAPSHOT,
  INPLACE_STAGING,
  LIVE_REVISION,
  LOCAL_PROVIDER,
  LOCAL_WORKER,
  localPath,
  localUri,
  validatePlan,
  type WorkspacePlan,
} from './plan.js'
import type { WorkspaceExecution } from './execution.js'

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

/** O que o worker publicou no staging e quer ver promovido. */
export interface Publication {
  stagingUri: string
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
   * Resolve a pasta de projeto de uma sessão — o backend v1 do Source (a
   * MESMA função que alimentava o Toolbox.Root do oráculo).
   */
  roots?: (sessionId: string) => string
  /** O dono dos leases DE VERDADE (a frota). Ausente = local/1 fixo da v1. */
  leases?: Leases
}

export class WorkspaceManager {
  readonly #roots: ((sessionId: string) => string) | undefined
  readonly #leases: Leases

  constructor(options: WorkspaceManagerOptions = {}) {
    this.#roots = options.roots
    this.#leases = options.leases ?? new LocalLeases()
  }

  /**
   * Congela o contrato da execução. É AQUI que worker, época e workspace são
   * decididos — a ferramenta lá na ponta só lê o que foi congelado.
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

    const lease = await this.#leases.currentLease(taskId)

    const root = this.#roots !== undefined ? this.#roots(sessionId).trim() : ''
    const plan: WorkspacePlan = {
      // Determinístico de propósito: mesmo pedido, mesmo id — sem relógio nem
      // aleatório, o plano sobrevive a replay e a comparação em teste.
      id: `wp-${sessionId}-${taskId}-${attempt}`,
      userId: LOCAL_WORKER, // v1: máquina de uma pessoa; multiusuário chega com o Puter
      goalId: (request.goalId ?? '').trim() || `goal-${sessionId}`,
      sessionId,
      taskId,
      botId,
      attempt,
      workerId: lease.workerId,
      leaseEpoch: lease.epoch,
      source: {
        provider: LOCAL_PROVIDER,
        uri: localUri(root),
        revision: LIVE_REVISION,
      },
      runtime: {
        profile: HOST_SNAPSHOT,
        snapshotDigest: HOST_SNAPSHOT,
        arch: process.arch,
      },
      staging: { uri: INPLACE_STAGING },
      baseline: { revision: LIVE_REVISION, manifestDigest: LIVE_REVISION },
    }
    validatePlan(plan)
    return plan
  }

  /**
   * Transforma o plano em execução NESTA máquina. No backend local é resolver
   * a URI de volta para a pasta; no Puter será baixar snapshot + montar o
   * workspace + preparar o git sombra.
   */
  async materialize(plan: WorkspacePlan): Promise<WorkspaceExecution> {
    validatePlan(plan)
    if (plan.source.provider !== LOCAL_PROVIDER) {
      throw new Error(`esta máquina não sabe materializar o provider "${plan.source.provider}"`)
    }
    return { plan, localRoot: localPath(plan.source.uri) }
  }

  /**
   * A CERCA em código: só o worker que detém o lease, na época em que o plano
   * foi congelado, transforma staging em verdade. É o cenário §25 da spec —
   * PC-02 que volta do limbo com época velha é RECUSADO; PC-03 na época atual
   * promove — e nenhum chamador precisa aprender regra nova quando o staging
   * de verdade entrar.
   */
  async promote(plan: WorkspacePlan, result: Publication): Promise<void> {
    const current = await this.#leases.currentLease(plan.taskId)
    if (current.workerId !== plan.workerId || current.epoch !== plan.leaseEpoch) {
      throw new StaleWorkspaceError()
    }
    if (result.stagingUri === INPLACE_STAGING) {
      // v1: o trabalho já está no workspace — promover é constatar.
      return
    }
    throw new Error(`esta máquina não sabe promover "${result.stagingUri}"`)
  }
}
