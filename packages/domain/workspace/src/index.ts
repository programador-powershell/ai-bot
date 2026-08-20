/**
 * @aibot2/domain-workspace — Plan congelado, materialização e Promote com
 * cerca worker+época.
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

export {
  NoExecutionError,
  requireMaterialized,
  type WorkspaceExecution,
} from './execution.js'

export {
  StaleWorkspaceError,
  WorkspaceManager,
  type CurrentLease,
  type Leases,
  type PlanRequest,
  type Publication,
  type WorkspaceManagerOptions,
} from './manager.js'
