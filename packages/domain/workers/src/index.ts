/**
 * @aibot2/domain-workers — Worker = PC físico; lease com época e prazo.
 */

export {
  HEARTBEAT_DEADLINE_MS,
  workerAlive,
  workerIdFromHostname,
  type WorkerCapabilities,
  type WorkerRecord,
} from './worker.js'

export {
  Fleet,
  LEASE_TTL_MS,
  LeaseHeldError,
  MemoryFleetState,
  type FleetOptions,
  type FleetState,
  type Lease,
  type LeaseRecord,
} from './fleet.js'

export { JsonFileFleetState } from './state-file.js'
