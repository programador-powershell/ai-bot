/**
 * @aibot2/domain-tasks — Goal→Task→TaskRun: DAG, estados duráveis, readiness
 * dinâmica, recusa-como-falha e orçamento por Goal.
 */

export {
  TASK_RUN_STATES,
  canTransition,
  isTaskRunState,
  makeTaskRunId,
  type TaskRunState,
  type TaskSpec,
} from './task.js'

export {
  CONCURRENCY_CEIL,
  CONCURRENCY_FLOOR,
  MAX_DEPENDENCIES,
  MAX_TASKS,
  WRITE_TOOL,
  planTasks,
  waveOf,
  type PlanOptions,
  type TaskPlan,
} from './dag.js'

export { ReadinessTracker } from './readiness.js'

export { REFUSAL_MAX_LEN, escalation, gateReason, refusal } from './refusal.js'

export {
  TaskJournal,
  type JournalSnapshot,
  type TaskRunSnapshot,
  type TaskTransition,
} from './journal.js'

export { GoalBudget } from './budget.js'
