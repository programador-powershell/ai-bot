/**
 * Goal → Task → TaskRun: as entidades do control plane.
 *
 * A distinção que paga o pacote inteiro (D2 do m0-inventario): TaskRunID é
 * LÓGICO — a tarefa numa tentativa —, e NUNCA o nome da máquina. O crew.go do
 * oráculo já sofreu essa confusão (workerID sintético e PC físico dividindo o
 * nome de campo); aqui os dois têm tipo, dono e ciclo de vida separados: o
 * workerId (PC) mora no domain/workers e viaja no despacho ao LADO do
 * taskRunId, jamais dentro dele.
 */

/** Um nó do DAG — o mesmo formato do payload Task do protocolo, com os campos
 * de readiness dinâmica e requisitos declaráveis do control plane. */
export interface TaskSpec {
  id: string
  title: string
  specialist: string
  goal: string
  dependsOn?: string[]
  /** Cópia própria do repositório — duas tarefas no mesmo arquivo sem isto se sobrescrevem caladas. */
  worktree?: boolean
  model?: string
  /**
   * Os INPUTS reais obrigatórios (nomes lógicos): a Task fica READY quando
   * eles EXISTEM — não por posição numa esteira Code→Build→Security imposta
   * artificialmente. Ausente = só as arestas dependsOn mandam.
   */
  needs?: string[]
  /** Os outputs que a conclusão desta tarefa disponibiliza para as demais. */
  produces?: string[]
  /**
   * RuntimeRequirements como a Needle os declara (opaco aqui; quem interpreta
   * é o domain/runtime do lado do scheduler).
   */
  requirements?: Record<string, unknown>
}

/**
 * Os estados de Task/TaskRun — o vocabulário fechado do aceite E7, persistido
 * via StorageDriver pelo TaskJournal. `retried` é da TASK (a decisão de
 * tentar de novo); os demais do meio são da EXECUÇÃO (TaskRun); `conflict` é
 * o desfecho da cerca (publicação de época velha recusada).
 */
export const TASK_RUN_STATES = [
  'task.created',
  'task.ready',
  'task.dispatched',
  'task.started',
  'task.progress',
  'task.done',
  'task.failed',
  'task.retried',
  'task.conflict',
] as const

export type TaskRunState = (typeof TASK_RUN_STATES)[number]

const stateSet: ReadonlySet<string> = new Set(TASK_RUN_STATES)

export function isTaskRunState(value: string): value is TaskRunState {
  return stateSet.has(value)
}

/**
 * As transições legais. Máquina de estados explícita porque estado de tarefa
 * é DECISÃO auditável: um `done` que nasce de `created` sem passar por
 * dispatch é sintoma de código pulando etapa, e deve morrer barulhento aqui —
 * não virar registro plausível que alguém audita meses depois.
 */
const TRANSITIONS: Readonly<Record<TaskRunState, readonly TaskRunState[]>> = Object.freeze({
  'task.created': ['task.ready', 'task.failed'],
  'task.ready': ['task.dispatched', 'task.failed'],
  'task.dispatched': ['task.started', 'task.failed', 'task.conflict'],
  'task.started': ['task.progress', 'task.done', 'task.failed', 'task.conflict'],
  // progress → retried cobre a tarefa ESCALADA (parada em progress esperando
  // resposta) que o portão manda refazer.
  'task.progress': ['task.progress', 'task.done', 'task.failed', 'task.conflict', 'task.retried'],
  'task.done': [],
  'task.failed': ['task.retried'],
  // retried reabre o ciclo: a tentativa seguinte nasce ready (o plano já
  // existe) e é despachada com attempt+1 — e pode falhar ANTES do despacho
  // (congelamento de workspace, por exemplo), por isso failed também é saída.
  'task.retried': ['task.ready', 'task.dispatched', 'task.failed'],
  'task.conflict': ['task.retried'],
})

/** A primeira transição (nascer) só aceita `task.created`. */
export function canTransition(from: TaskRunState | undefined, to: TaskRunState): boolean {
  if (from === undefined) {
    return to === 'task.created'
  }
  return TRANSITIONS[from].includes(to)
}

/**
 * O TaskRunID lógico: tarefa + tentativa. É DERIVADO, determinístico e não
 * contém máquina por CONSTRUÇÃO — a assinatura nem recebe worker. Quem quiser
 * saber onde a tentativa rodou pergunta ao despacho (workerId ao lado), nunca
 * ao id.
 */
export function makeTaskRunId(taskId: string, attempt: number): string {
  const trimmed = taskId.trim()
  if (trimmed === '') {
    throw new Error('taskRunId sem tarefa')
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('taskRunId exige tentativa ≥ 1')
  }
  return `run-${trimmed}-a${attempt}`
}
