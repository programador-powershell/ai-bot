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
