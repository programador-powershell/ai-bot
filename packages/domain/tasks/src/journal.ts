/**
 * O TaskJournal: os estados de Task/TaskRun como REGISTRO durável — a evolução
 * do fleet.RunLog do oráculo (que só auditava) para o degrau retomável.
 *
 * ONDE persiste: na sessão de CONTROLE do Goal (goalControlSessionId), via
 * StorageDriver do @aibot2/domain-events. É a decisão D6 encarnada: o débito
 * do orçamento e o estado das tarefas moram no STORE por Goal, não em
 * contexto de processo — sub-equipe que herda o goalId herda a MESMA sessão,
 * logo o mesmo débito; reinício do servidor relê o log e o débito continua lá.
 *
 * COMO persiste: o vocabulário de verbos do protocolo é FECHADO (23 kinds, o
 * porte do protocol.go — mudar a lista quebraria as fixtures do oráculo).
 * Então cada transição viaja num verbo EXISTENTE, escolhido pela semântica de
 * durabilidade que o storage já dá:
 *
 *   - task.dispatched                → kind 'task.dispatch'  (durável: é decisão)
 *   - task.done/failed/conflict      → kind 'worker.done'    (durável: é desfecho)
 *   - created/ready/started/progress/retried → kind 'task.progress' (efêmero:
 *     re-derivável do plano e do despacho seguinte; perder num corte de energia
 *     não perde decisão de ninguém)
 *
 * O ESTADO em si (o nome fechado do aceite E7) vai no payload, campo `state` —
 * o replay lê o payload, não o verbo.
 */

import {
  type Actor,
  type Envelope,
  type Kind,
  type StorageDriver,
  SessionExistsError,
} from '@aibot2/domain-events'
import { goalControlSessionId } from '@aibot2/domain-goals'
import { canTransition, isTaskRunState, type TaskRunState } from './task.js'

/** Uma transição a registrar. */
export interface TaskTransition {
  state: TaskRunState
  taskId: string
  /** O TaskRunID lógico (com tentativa). Ausente nos estados de Task pura (created/ready/retried). */
  taskRunId?: string
  attempt?: number
  wave?: number
  /** O PC físico — SEMPRE ao lado do taskRunId, nunca dentro dele (D2). */
  workerId?: string
  leaseEpoch?: number
  workspacePlanId?: string
  /** Erro, motivo de conflito, nota de progresso. */
  detail?: string
}

/** O payload como vai ao log. */
interface TransitionPayload extends TaskTransition {
  goalId: string
}

/** O estado reconstituído de uma TaskRun. */
export interface TaskRunSnapshot {
  taskRunId: string
  taskId: string
  attempt: number
  state: TaskRunState
  workerId?: string
  leaseEpoch?: number
  wave?: number
  detail?: string
}

/** A visão do Goal reconstruída do log — o que o reinício reencontra. */
export interface JournalSnapshot {
  /** Último estado conhecido de cada Task. */
  taskStates: Map<string, TaskRunState>
  /** Última fotografia de cada TaskRun. */
  runs: Map<string, TaskRunSnapshot>
  /**
   * Quantas execuções foram DESPACHADAS neste Goal (o débito do orçamento):
   * conta envelopes de despacho, então sobrevive a reinício por construção.
   */
  dispatched: number
}

const JOURNAL_ACTOR: Actor = { kind: 'supervisor', id: 'control-plane' }

function kindFor(state: TaskRunState): Kind {
  switch (state) {
    case 'task.dispatched':
      return 'task.dispatch'
    case 'task.done':
    case 'task.failed':
    case 'task.conflict':
      return 'worker.done'
    default:
      return 'task.progress'
  }
}

export class TaskJournal {
  readonly #store: StorageDriver
  readonly #goalId: string
  readonly #sessionId: string
  #sessionReady = false
  #counter = 0
  /** Cache do último estado por tarefa para validar transições sem reler o log. */
  readonly #taskStates = new Map<string, TaskRunState>()
  #hydrated = false

  constructor(store: StorageDriver, goalId: string) {
    this.#store = store
    this.#goalId = goalId.trim()
    this.#sessionId = goalControlSessionId(goalId)
  }

  get goalId(): string {
    return this.#goalId
  }

  get sessionId(): string {
    return this.#sessionId
  }

  /**
   * Garante a sessão de controle e reidrata o cache de estados do que já está
   * no log — é ISTO que faz o reinício continuar de onde parou em vez de
   * recomeçar a máquina de estados do zero.
   */
  async open(): Promise<void> {
    if (!this.#sessionReady) {
      try {
        await this.#store.createSession({
          id: this.#sessionId,
          title: `control plane do goal ${this.#goalId}`,
        })
      } catch (error) {
        // Já existir é o caso NORMAL do reinício e da sub-equipe — não é erro.
        if (!(error instanceof SessionExistsError)) throw error
      }
      this.#sessionReady = true
    }
    if (!this.#hydrated) {
      const snapshot = await this.replay()
      for (const [taskId, state] of snapshot.taskStates) {
        this.#taskStates.set(taskId, state)
      }
      this.#hydrated = true
    }
  }

  /**
   * Registra uma transição, validando-a contra a máquina de estados. Estado
   * ilegal morre AQUI, barulhento — não vira registro plausível no log.
   * Devolve o seq atribuído pelo sequenciador (que é do server, nunca do worker).
   */
  async record(transition: TaskTransition): Promise<number> {
    await this.open()
    const current = this.#taskStates.get(transition.taskId)
    if (!canTransition(current, transition.state)) {
      throw new Error(
        `transição ilegal da tarefa ${transition.taskId}: ${current ?? '(inexistente)'} → ${transition.state}`,
      )
    }
    const payload: TransitionPayload = { ...transition, goalId: this.#goalId }
    const seq = await this.#store.append(this.#sessionId, {
      id: this.#nextId(),
      kind: kindFor(transition.state),
      from: JOURNAL_ACTOR,
      payload,
    })
    this.#taskStates.set(transition.taskId, transition.state)
    return seq
  }

  /** O último estado conhecido de uma tarefa (cache já reidratado). */
  stateOf(taskId: string): TaskRunState | undefined {
    return this.#taskStates.get(taskId)
  }

  /**
   * Reconstrói a visão do Goal lendo o log INTEIRO da sessão de controle,
   * paginado pelo teto do driver. O débito (dispatched) é contado dos
   * registros de despacho — restart não zera porque o log não zera.
   */
  async replay(): Promise<JournalSnapshot> {
    const taskStates = new Map<string, TaskRunState>()
    const runs = new Map<string, TaskRunSnapshot>()
    let dispatched = 0

    let from = 0
    for (;;) {
      let batch: Envelope[]
      try {
        batch = await this.#store.since(this.#sessionId, from)
      } catch {
        // Sessão ainda não existe: Goal novo, snapshot vazio.
        break
      }
      if (batch.length === 0) break
      for (const envelope of batch) {
        from = envelope.seq
        const payload = envelope.payload as Partial<TransitionPayload> | undefined
        if (
          payload === undefined ||
          typeof payload.state !== 'string' ||
          !isTaskRunState(payload.state) ||
          typeof payload.taskId !== 'string'
        ) {
          // Envelope de outro produtor na mesma sessão: não é do journal.
          continue
        }
        taskStates.set(payload.taskId, payload.state)
        if (payload.state === 'task.dispatched') {
          dispatched++
        }
        if (typeof payload.taskRunId === 'string' && payload.taskRunId !== '') {
          // MERGE com o que a run já contava: o despacho é quem sabe worker,
          // época e onda — o done/failed que vem depois não carrega (nem deve
          // recarregar) esses campos, e sobrescrever com ausência apagaria a
          // atribuição da execução.
          const previous = runs.get(payload.taskRunId)
          const snapshot: TaskRunSnapshot = {
            ...(previous ?? {}),
            taskRunId: payload.taskRunId,
            taskId: payload.taskId,
            attempt:
              typeof payload.attempt === 'number' ? payload.attempt : (previous?.attempt ?? 1),
            state: payload.state,
          }
          if (typeof payload.workerId === 'string') snapshot.workerId = payload.workerId
          if (typeof payload.leaseEpoch === 'number') snapshot.leaseEpoch = payload.leaseEpoch
          if (typeof payload.wave === 'number') snapshot.wave = payload.wave
          if (typeof payload.detail === 'string') snapshot.detail = payload.detail
          runs.set(payload.taskRunId, snapshot)
        }
      }
    }
    return { taskStates, runs, dispatched }
  }

  /** Ids legíveis no log, na forma do oráculo (prefixo-epoch-contador). */
  #nextId(): string {
    this.#counter++
    return `tj-${Date.now()}-${this.#counter}`
  }
}
