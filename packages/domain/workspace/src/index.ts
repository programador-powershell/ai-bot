/**
 * @aibot2/domain-workspace — Plan congelado, materialização e Promote com
 * cerca worker+época, com o ONDE/COMO dos bytes atrás do seam WorkspaceBackend
 * (local por padrão; Puter entra em providers/puter sem tocar a cerca).
 */

export {
  HOST_SNAPSHOT,
  INPLACE_STAGING,
  LIVE_REVISION,
  LOCAL_PROVIDER,
  LOCAL_WORKER,
  localPath,
  localUri,
  planToString,
  stagingUri,
  validatePlan,
  type WorkspaceBaseline,
  type WorkspacePlan,
  type WorkspaceRuntime,
  type WorkspaceSource,
  type WorkspaceStaging,
} from './plan.js'

export { SNAPSHOT_EXCLUDES, isDisposable } from './snapshot.js'

export {
  NoExecutionError,
  requireMaterialized,
  type WorkspaceExecution,
} from './execution.js'

export {
  LocalWorkspaceBackend,
  type PlanContext,
  type Publication,
  type WorkspaceBackend,
} from './backend.js'

export {
  StaleWorkspaceError,
  WorkspaceManager,
  type CurrentLease,
  type Leases,
  type PlanRequest,
  type WorkspaceManagerOptions,
} from './manager.js'
