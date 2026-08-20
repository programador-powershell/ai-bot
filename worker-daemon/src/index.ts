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
  DockerContainerRuntime,
  EPOCH_LABEL,
  OWNER_LABEL,
  TASK_RUN_LABEL,
  WORKER_LABEL,
  announceDocker,
  containerNameFor,
  demuxDockerLogs,
  detectContainerRuntime,
  dockerodeEngine,
  type DetectOptions,
  type DetectedRuntime,
  type DockerEngine,
  type DockerRuntimeOptions,
  type EngineContainer,
  type EngineCreateOptions,
  type EngineHostConfig,
  type OwnedContainerRef,
} from './docker-runtime.js'

export {
  createWorkerDaemon,
  type AssignedLease,
  type ReportedEvent,
  type WorkerDaemon,
  type WorkerDaemonConfig,
} from './daemon.js'
