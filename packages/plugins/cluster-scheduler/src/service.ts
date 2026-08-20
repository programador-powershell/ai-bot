/**
 * O scheduler como Service do kernel: `ctx.cluster`.
 *
 * A service é fina de propósito — a decisão mora em choose.ts e o laço em
 * engine.ts, ambos puros e testáveis sem kernel. Aqui só a montagem: guardar
 * as dependências injetadas por config (store, frota, workspaces, executor) e
 * abrir motores por Goal. As dependências chegam por CONFIG e não por inject
 * de serviço porque frota/executor são objetos de domínio, não services do
 * Context — o mesmo padrão do RegistryConfig do specialist-registry.
 */

import { Service, type Context } from '@aibot2/harness-kernel'
import type { StorageDriver } from '@aibot2/domain-events'
import type { CrewCeilings } from '@aibot2/domain-goals'
import type { Fleet, WorkerRecord } from '@aibot2/domain-workers'
import type { WorkspaceManager } from '@aibot2/domain-workspace'
import { chooseWorker, type Choice, type ChooseOptions } from './choose.js'
import {
  CrewEngine,
  type CrewReport,
  type CrewRequest,
  type GateDecision,
  type GatePrompt,
  type TaskExecutor,
} from './engine.js'

declare module '@aibot2/harness-kernel' {
  interface Context {
    cluster: ClusterScheduler
  }
}

export interface ClusterSchedulerConfig {
  store: StorageDriver
  fleet: Fleet
  workspaces: WorkspaceManager
  executor: TaskExecutor
  ceilings?: Partial<CrewCeilings>
  decideGate?: (gate: GatePrompt) => Promise<GateDecision>
  chooseOptions?: ChooseOptions
}

export class ClusterScheduler extends Service {
  static readonly inject: readonly string[] = []

  readonly #config: ClusterSchedulerConfig

  constructor(ctx: Context, config: ClusterSchedulerConfig) {
    super(ctx, 'cluster')
    this.#config = config
  }

  /** A decisão de máquina (§28), exposta para quem só precisa escolher. */
  choose(
    requirements: Record<string, unknown> | undefined,
    workers: readonly WorkerRecord[],
    options?: ChooseOptions,
  ): Choice {
    return chooseWorker(requirements, workers, options ?? this.#config.chooseOptions ?? {})
  }

  /** Um motor de ondas para o Goal — cada Goal tem journal e débito próprios. */
  engineFor(goalId: string, seedInputs: string[] = []): CrewEngine {
    const options: ConstructorParameters<typeof CrewEngine>[0] = {
      store: this.#config.store,
      goalId,
      fleet: this.#config.fleet,
      workspaces: this.#config.workspaces,
      executor: this.#config.executor,
      seedInputs,
    }
    if (this.#config.ceilings !== undefined) options.ceilings = this.#config.ceilings
    if (this.#config.decideGate !== undefined) options.decideGate = this.#config.decideGate
    if (this.#config.chooseOptions !== undefined) options.chooseOptions = this.#config.chooseOptions
    return new CrewEngine(options)
  }

  /** Atalho: monta o motor e executa o pedido de equipe de um Goal. */
  async run(goalId: string, request: CrewRequest): Promise<CrewReport> {
    return this.engineFor(goalId).run(request)
  }
}
