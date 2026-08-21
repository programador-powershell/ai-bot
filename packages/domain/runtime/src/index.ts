/**
 * @aibot2/domain-runtime — RuntimeRequirements + fingerprint de snapshot.
 * O runtime é da TAREFA (host|docker|wsl|vps), nunca da sessão.
 */

export { parseRequirements, type RuntimeRequirements } from './requirements.js'
export {
  LOCK_FILES,
  pickLockFiles,
  snapshotFingerprint,
  type ManifestFile,
  type SnapshotIndexEntry,
  type SnapshotKey,
} from './fingerprint.js'
export {
  RUNTIME_KINDS,
  RuntimeResolver,
  admitRuntime,
  isRuntimeKind,
  resolveRuntimeBinding,
  resolveRuntimeTarget,
  runtimeExec,
  runtimeWorkdir,
  type RuntimeAdmission,
  type RuntimeBinding,
  type RuntimeExec,
  type RuntimeHostCapabilities,
  type RuntimeKind,
  type RuntimeTarget,
} from './resolver.js'
