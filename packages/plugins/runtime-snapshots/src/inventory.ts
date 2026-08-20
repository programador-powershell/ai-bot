/**
 * O inventário de snapshots por worker — a metade que faltava do M10 (o
 * fingerprint já morava em domain/runtime).
 *
 * O que ele é: um registro digest→estado do que está AQUECIDO em cada PC, para
 * o scheduler pontuar localidade (§28 passo 6) e o worker decidir se reinstala
 * ou reaproveita. O que ele NUNCA é: fonte de verdade (spec §29). Três
 * consequências de desenho saem disso:
 *
 * - **Hit/miss é content-addressed.** A chave é `base/digest` do fingerprint
 *   dos LOCKS: mudou o manifest, mudou o digest, e a chave nova simplesmente
 *   NÃO ESTÁ no inventário — a invalidação por mudança de manifest é por
 *   construção, não por varredura. Não existe "atualizar" um snapshot: existe
 *   a chave velha (que vira lixo podável) e a chave nova (que é miss até
 *   alguém materializar e registrar).
 * - **Descartar é sempre seguro.** evict/prune nunca perguntam "tem certeza?":
 *   o pior caso de perder um snapshot é a próxima tarefa reinstalar — por isso
 *   a poda LRU é burra de propósito, e um inventário zerado no boot é estado
 *   VÁLIDO (o cache se reaquece com o uso).
 * - **Nenhum segredo entra.** O registro guarda base, digest, imagem e
 *   relógio — nunca o conteúdo dos manifests (o fingerprint os consome e
 *   descarta; um .env passado por engano nem chega a influenciar a chave,
 *   porque a lista fechada de locks do domain/runtime o ignora).
 *
 * `hit` exige estado `ready`: um snapshot em `building` anunciado como quente
 * faria o scheduler mandar a tarefa para uma imagem que ainda não existe — o
 * custo alto na hora errada, de novo.
 */

import { snapshotFingerprint, type ManifestFile, type SnapshotKey } from '@aibot2/domain-runtime'
import type { WorkerRecord } from '@aibot2/domain-workers'

/** O estado de um snapshot num worker. `ready` é o único que conta como hit. */
export type SnapshotState = 'ready' | 'building'

/** Um snapshot registrado num PC. Só metadado — NUNCA conteúdo de manifest. */
export interface SnapshotRecord {
  key: string
  base: string
  digest: string
  state: SnapshotState
  /** A imagem local materializada (docker), quando houver. */
  image?: string
  /** Último toque (registro ou hit), ISO-8601 — a régua da poda LRU. */
  lastUsedAt: string
}

/** A decisão do inventário para uma tarefa num worker. */
export interface SnapshotDecision {
  /** A chave resolvida — o que o scheduler usa como snapshotKey de localidade. */
  key: SnapshotKey
  /** `true` só quando o worker tem o snapshot PRONTO. */
  hit: boolean
  /** O estado registrado, quando há registro (building não é hit). */
  state?: SnapshotState
}

export interface SnapshotInventoryOptions {
  /** Relógio injetável — o teste encena LRU sem esperar o mundo girar. */
  now?: () => number
  /** Teto de registros por worker; acima disso a poda LRU corta o mais frio. */
  maxPerWorker?: number
}

const DEFAULT_MAX_PER_WORKER = 32

export class SnapshotInventory {
  readonly #now: () => number
  readonly #maxPerWorker: number
  /** workerId → (key → registro). Memória de propósito: cache descartável
   * não ganha persistência — um boot zerado é estado válido. */
  readonly #byWorker = new Map<string, Map<string, SnapshotRecord>>()

  constructor(options: SnapshotInventoryOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#maxPerWorker = options.maxPerWorker ?? DEFAULT_MAX_PER_WORKER
  }

  #of(workerId: string): Map<string, SnapshotRecord> {
    let records = this.#byWorker.get(workerId)
    if (records === undefined) {
      records = new Map()
      this.#byWorker.set(workerId, records)
    }
    return records
  }

  #stamp(): string {
    return new Date(this.#now()).toISOString()
  }

  /**
   * Decide hit/miss para uma base+manifests num worker. Manifests passam pelo
   * fingerprint (só locks contam): manifest mudado = chave nova = miss — é a
   * invalidação por mudança de manifest, sem varredura. Hit toca o LRU.
   */
  decide(workerId: string, base: string, manifests: readonly ManifestFile[]): SnapshotDecision {
    const key = snapshotFingerprint(base, manifests)
    const record = this.#of(workerId).get(key.key)
    if (record === undefined) {
      return { key, hit: false }
    }
    if (record.state !== 'ready') {
      return { key, hit: false, state: record.state }
    }
    record.lastUsedAt = this.#stamp()
    return { key, hit: true, state: 'ready' }
  }

  /**
   * Marca a chave como EM CONSTRUÇÃO neste worker — visível para quem
   * pergunta (evita duas materializações concorrentes), invisível para o
   * anúncio (building não é quente).
   */
  building(workerId: string, key: SnapshotKey): void {
    this.#of(workerId).set(key.key, {
      key: key.key,
      base: key.base,
      digest: key.digest,
      state: 'building',
      lastUsedAt: this.#stamp(),
    })
  }

  /** Registra o snapshot PRONTO no worker (após materializar). */
  record(workerId: string, key: SnapshotKey, meta: { image?: string } = {}): void {
    this.#of(workerId).set(key.key, {
      key: key.key,
      base: key.base,
      digest: key.digest,
      state: 'ready',
      ...(meta.image !== undefined ? { image: meta.image } : {}),
      lastUsedAt: this.#stamp(),
    })
    this.#prune(workerId)
  }

  /**
   * Descarta um snapshot do inventário de um worker. Sem cerimônia: snapshot
   * é descartável por contrato (spec §29) — quem evicta nunca perde verdade.
   * Devolve se havia algo a descartar.
   */
  evict(workerId: string, key: string): boolean {
    return this.#of(workerId).delete(key)
  }

  /** Zera o inventário de um worker (a máquina foi limpa/reprovisionada). */
  forget(workerId: string): void {
    this.#byWorker.delete(workerId)
  }

  /** A poda LRU: acima do teto, o registro mais frio sai primeiro. */
  #prune(workerId: string): void {
    const records = this.#of(workerId)
    while (records.size > this.#maxPerWorker) {
      let coldest: SnapshotRecord | undefined
      for (const record of records.values()) {
        if (coldest === undefined || record.lastUsedAt < coldest.lastUsedAt) {
          coldest = record
        }
      }
      if (coldest === undefined) return
      records.delete(coldest.key)
    }
  }

  /** Os registros de um worker (cópias — o inventário não vaza referência). */
  records(workerId: string): SnapshotRecord[] {
    return [...this.#of(workerId).values()].map((record) => ({ ...record }))
  }

  /**
   * As chaves QUENTES (ready) de um worker, ordenadas — exatamente o formato
   * que WorkerCapabilities.snapshots carrega e o scheduler pontua (§28.6).
   */
  warmKeys(workerId: string): string[] {
    return [...this.#of(workerId).values()]
      .filter((record) => record.state === 'ready')
      .map((record) => record.key)
      .sort()
  }

  /**
   * Reanuncia as capabilities de um worker com o retrato ATUAL do inventário.
   * Substitui, nunca mescla: o anúncio é espelho do inventário — mesclar
   * deixaria chave evictada anunciada para sempre, e o scheduler mandaria
   * tarefa atrás de uma imagem que já morreu. Sem nada quente, o campo some
   * (anunciar [] ainda seria anunciar).
   */
  announce(worker: WorkerRecord): WorkerRecord {
    const warm = this.warmKeys(worker.id)
    const capabilities = { ...worker.capabilities }
    if (warm.length > 0) {
      capabilities.snapshots = warm
    } else {
      delete capabilities.snapshots
    }
    return { ...worker, capabilities }
  }
}
