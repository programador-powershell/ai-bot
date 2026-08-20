/**
 * O inventário como Service do kernel: `ctx.snapshots`.
 *
 * A service é fina de propósito — a decisão mora em inventory.ts, puro e
 * testável sem kernel (o mesmo padrão do cluster-scheduler: montagem aqui,
 * regra lá). O que ela acrescenta é o ponto de integração: `announceAll`
 * devolve a frota REANUNCIADA com a localidade do inventário, pronta para o
 * chooseWorker — que já pontua snapshots sem saber que este plugin existe.
 */

import { Service, type Context } from '@aibot2/harness-kernel'
import type { ManifestFile, SnapshotKey } from '@aibot2/domain-runtime'
import type { WorkerRecord } from '@aibot2/domain-workers'
import {
  SnapshotInventory,
  type SnapshotDecision,
  type SnapshotRecord,
} from './inventory.js'

declare module '@aibot2/harness-kernel' {
  interface Context {
    snapshots: RuntimeSnapshots
  }
}

export interface RuntimeSnapshotsConfig {
  /** Injete um inventário pré-povoado (testes/replay); ausente nasce vazio —
   * que é estado VÁLIDO: cache descartável se reaquece com o uso. */
  inventory?: SnapshotInventory
}

export class RuntimeSnapshots extends Service {
  static readonly inject: readonly string[] = []

  readonly #inventory: SnapshotInventory

  constructor(ctx: Context, config: RuntimeSnapshotsConfig = {}) {
    super(ctx, 'snapshots')
    this.#inventory = config.inventory ?? new SnapshotInventory()
  }

  /** Hit/miss para uma base+manifests num worker (manifest novo = miss). */
  decide(workerId: string, base: string, manifests: readonly ManifestFile[]): SnapshotDecision {
    return this.#inventory.decide(workerId, base, manifests)
  }

  /** Marca a chave como em construção no worker. */
  building(workerId: string, key: SnapshotKey): void {
    this.#inventory.building(workerId, key)
  }

  /** Registra o snapshot pronto no worker. */
  record(workerId: string, key: SnapshotKey, meta: { image?: string } = {}): void {
    this.#inventory.record(workerId, key, meta)
  }

  /** Descarta um snapshot — sempre seguro, nunca fonte de verdade. */
  evict(workerId: string, key: string): boolean {
    return this.#inventory.evict(workerId, key)
  }

  /** Zera o inventário de um worker reprovisionado. */
  forget(workerId: string): void {
    this.#inventory.forget(workerId)
  }

  /** O retrato de um worker (cópias). */
  records(workerId: string): SnapshotRecord[] {
    return this.#inventory.records(workerId)
  }

  /** As chaves quentes de um worker, no formato de capabilities.snapshots. */
  warmKeys(workerId: string): string[] {
    return this.#inventory.warmKeys(workerId)
  }

  /** Um worker reanunciado com a localidade atual. */
  announce(worker: WorkerRecord): WorkerRecord {
    return this.#inventory.announce(worker)
  }

  /** A frota inteira reanunciada — a entrada que o chooseWorker pontua. */
  announceAll(workers: readonly WorkerRecord[]): WorkerRecord[] {
    return workers.map((worker) => this.#inventory.announce(worker))
  }
}
