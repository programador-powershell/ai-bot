/**
 * @aibot2/cluster-scheduler — a ordem de decisão §28 + o motor de ondas do
 * crew portado, com tetos duráveis por Goal e a cerca de promoção no caminho.
 */

export { chooseWorker, type Choice, type ChooseOptions, type SchedulerPolicy } from './choose.js'

export {
  CrewEngine,
  MAX_WAVE_ATTEMPTS,
  type CrewEngineOptions,
  type CrewReport,
  type CrewRequest,
  type GateDecision,
  type GatePrompt,
  type TaskAssignment,
  type TaskExecutor,
  type TaskOutcome,
} from './engine.js'

export { ClusterScheduler, type ClusterSchedulerConfig } from './service.js'
