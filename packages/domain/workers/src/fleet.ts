/**
 * A frota: registro de WORKERS e o dono dos LEASES de tarefa — porte de
 * internal/fleet/fleet.go do oráculo Go.
 *
 * A ÉPOCA é o coração, e ela SOBREVIVE ao reinício do processo: sem isso, um
 * orquestrador que cai e volta recomeçaria toda tarefa na época 1 — e o
 * resultado de um worker antigo, congelado numa época "1" anterior, passaria
 * pela cerca do workspace como se fosse atual.
 *
 * As três saídas do Acquire são exatamente as do desenho do cluster:
 *   - o próprio dono renova: MESMA época, validade estendida;
 *   - lease vago ou vencido: época ANDA (nunca volta), novo dono;
 *   - outro dono com lease válido: recusa — lease não se rouba, espera vencer.
 *
 * A persistência fica atrás do seam FleetState: memória nos testes, arquivo
 * JSON com temp+fsync+rename na máquina (a disciplina manual do m0 §3.3 —
 * mais barata que homologar write-file-atomic). O lease distribuído de
 * verdade (banco compartilhado) troca o seam, não a regra.
 */

import { KeyedMutex } from '@aibot2/domain-events'
import { HEARTBEAT_DEADLINE_MS, workerAlive, type WorkerRecord } from './worker.js'

/** TTL do lease sem renovação — o mesmo 3min do oráculo: curto o bastante
 * para uma tarefa órfã ser reatribuível em minutos, longo o bastante para uma
 * rodada lenta de modelo não perder o próprio lease. */
export const LEASE_TTL_MS = 3 * 60 * 1000

/** Quem detém a tarefa agora, e desde qual época. */
export interface Lease {
  workerId: string
  epoch: number
}

/** O registro completo, com o prazo — o que persiste. */
export interface LeaseRecord extends Lease {
  /** Vencimento em epoch-ms. */
  expiresAtMs: number
}

/** OUTRO worker detém a tarefa e o lease ainda vale (porte de ErrLeaseHeld). */
export class LeaseHeldError extends Error {
  override name = 'LeaseHeldError'
  constructor(
    readonly holder: string,
    readonly epoch: number,
  ) {
    super(`a tarefa está com outro worker e o lease ainda vale (dono: ${holder}, época ${epoch})`)
  }
}

/** O seam de persistência da frota. */
export interface FleetState {
  loadWorkers(): Record<string, WorkerRecord>
  saveWorkers(workers: Record<string, WorkerRecord>): void
  loadLeases(): Record<string, LeaseRecord>
  saveLeases(leases: Record<string, LeaseRecord>): void
}

/** Estado em memória — o padrão dos testes e do modo efêmero. */
export class MemoryFleetState implements FleetState {
  #workers: Record<string, WorkerRecord> = {}
  #leases: Record<string, LeaseRecord> = {}
  loadWorkers(): Record<string, WorkerRecord> {
    return { ...this.#workers }
  }
  saveWorkers(workers: Record<string, WorkerRecord>): void {
    this.#workers = { ...workers }
  }
  loadLeases(): Record<string, LeaseRecord> {
    return { ...this.#leases }
  }
  saveLeases(leases: Record<string, LeaseRecord>): void {
    this.#leases = { ...leases }
  }
}

export interface FleetOptions {
  state?: FleetState
  /** Relógio injetável — o teste encena vencimento sem esperar 3 minutos. */
  now?: () => number
  ttlMs?: number
  heartbeatDeadlineMs?: number
}

/**
 * A frota em si. Os métodos são assíncronos e serializados por um mutex único:
 * o event loop não protege nada entre awaits (RS5), e Acquire lê-decide-grava —
 * dois Acquire entrelaçados dariam duas épocas iguais a donos diferentes.
 */
export class Fleet {
  readonly #state: FleetState
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #deadlineMs: number
  readonly #mutex = new KeyedMutex()

  #workers: Record<string, WorkerRecord>
  #leases: Record<string, LeaseRecord>

  constructor(options: FleetOptions = {}) {
    this.#state = options.state ?? new MemoryFleetState()
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? LEASE_TTL_MS
    this.#deadlineMs = options.heartbeatDeadlineMs ?? HEARTBEAT_DEADLINE_MS
    // Carrega o que sobreviveu ao último processo — é AQUI que a época volta.
    this.#workers = this.#state.loadWorkers()
    this.#leases = this.#state.loadLeases()
  }

  /* ------------------------------ workers ------------------------------- */

  /** Registra (ou re-registra) um PC. Registro carimba o batimento. */
  async register(worker: WorkerRecord): Promise<void> {
    await this.#mutex.runExclusive('fleet', () => {
      this.#workers[worker.id] = {
        ...worker,
        lastSeen: new Date(this.#now()).toISOString(),
      }
      this.#state.saveWorkers(this.#workers)
    })
  }

  /** Renova o "estou vivo" de um worker registrado. Desconhecido é erro. */
  async heartbeat(workerId: string): Promise<void> {
    await this.#mutex.runExclusive('fleet', () => {
      const worker = this.#workers[workerId]
      if (worker === undefined) {
        throw new Error(`heartbeat de worker não registrado: ${workerId}`)
      }
      worker.lastSeen = new Date(this.#now()).toISOString()
      this.#state.saveWorkers(this.#workers)
    })
  }

  /** Atualiza a carga (tarefas em execução) — o desempate final do scheduler. */
  async setRunning(workerId: string, running: number): Promise<void> {
    await this.#mutex.runExclusive('fleet', () => {
      const worker = this.#workers[workerId]
      if (worker === undefined) return
      worker.running = Math.max(0, running)
      this.#state.saveWorkers(this.#workers)
    })
  }

  /** Todos os registrados (vivos ou não — quem filtra decide o prazo). */
  workers(): WorkerRecord[] {
    return Object.values(this.#workers).map((worker) => ({ ...worker }))
  }

  /** Só os que bateram o coração dentro do prazo. */
  aliveWorkers(): WorkerRecord[] {
    const now = this.#now()
    return this.workers().filter((worker) => workerAlive(worker, now, this.#deadlineMs))
  }

  /** O worker ainda vale como destino? (heartbeat dentro do prazo) */
  isAlive(workerId: string): boolean {
    const worker = this.#workers[workerId]
    if (worker === undefined) return false
    return workerAlive(worker, this.#now(), this.#deadlineMs)
  }

  /* ------------------------------- leases -------------------------------- */

  /**
   * Toma (ou renova) o lease de uma tarefa para um worker — as três saídas do
   * desenho (ver cabeçalho). O bump no caminho vago/vencido é o PC-03
   * assumindo a tarefa que o PC-02 largou: é o que faz o resultado atrasado do
   * PC-02 bater na cerca em vez de sobrescrever o trabalho novo.
   */
  async acquire(taskId: string, workerId: string): Promise<Lease> {
    const task = taskId.trim()
    if (task === '') {
      throw new Error('lease sem tarefa')
    }
    return this.#mutex.runExclusive('fleet', () => {
      const now = this.#now()
      const current = this.#leases[task]
      let next: LeaseRecord
      if (current !== undefined && current.workerId === workerId) {
        // Dono renova: MESMA época, validade estendida.
        next = { ...current, expiresAtMs: now + this.#ttlMs }
      } else if (current !== undefined && now < current.expiresAtMs) {
        throw new LeaseHeldError(current.workerId, current.epoch)
      } else {
        // Vago ou vencido: a época ANDA (nunca volta).
        next = {
          workerId,
          epoch: (current?.epoch ?? 0) + 1,
          expiresAtMs: now + this.#ttlMs,
        }
      }
      this.#leases[task] = next
      this.#state.saveLeases(this.#leases)
      return { workerId: next.workerId, epoch: next.epoch }
    })
  }

  /**
   * Quem detém a tarefa AGORA — a interface que a cerca do workspace consulta
   * (estruturalmente compatível com o seam Leases do domain/workspace).
   *
   * Diferente do CurrentLease do oráculo v1 (que adquiria implicitamente para
   * o worker local), aqui NÃO há aquisição implícita: o control plane
   * multi-worker sempre adquire explicitamente no despacho. Lease ausente ou
   * vencido responde época 0 — que nunca casa com um plano congelado (todo
   * plano nasce de um acquire, logo época ≥ 1), então o Promote de um plano
   * órfão falha na cerca, que é o comportamento seguro.
   */
  async currentLease(taskId: string): Promise<Lease> {
    return this.#mutex.runExclusive('fleet', () => {
      const current = this.#leases[taskId]
      if (current === undefined) {
        return { workerId: '', epoch: 0 }
      }
      if (this.#now() >= current.expiresAtMs) {
        // Vencido: informa o estado SEM bump — quem bumpa é o próximo acquire.
        // A cerca compara worker+época; um vencido reportado como está já
        // recusa qualquer promoção de quem não readquiriu.
        return { workerId: '', epoch: current.epoch }
      }
      return { workerId: current.workerId, epoch: current.epoch }
    })
  }

  /**
   * A tarefa está órfã? (sem lease válido) — é o gatilho do re-enfileiramento:
   * worker morto → lease vence → TaskRun volta à fila.
   */
  async leaseExpired(taskId: string): Promise<boolean> {
    return this.#mutex.runExclusive('fleet', () => {
      const current = this.#leases[taskId]
      return current === undefined || this.#now() >= current.expiresAtMs
    })
  }
}
