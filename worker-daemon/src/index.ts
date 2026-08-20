/**
 * @aibot2/worker-daemon — o daemon do PC físico: executa e RELATA; nunca
 * grava seq, nunca promove, nunca expõe Docker passthrough.
 */

export {
  LocalProcessRuntime,
  type ContainerRuntime,
  type ExecutionHandle,
  type ExecutionResult,
  type ExecutionSpec,
} from './runtime.js'

export {
  createWorkerDaemon,
  type AssignedLease,
  type ReportedEvent,
  type WorkerDaemon,
  type WorkerDaemonConfig,
} from './daemon.js'
