/**
 * @aibot2/runtime-snapshots — o inventário/cache de snapshots por worker
 * (M10): digest→estado, hit/miss content-addressed, anúncio de localidade nas
 * capabilities e poda LRU. Descartável por contrato (spec §29): nunca fonte
 * de verdade, nunca segredo dentro.
 */

export {
  SnapshotInventory,
  type SnapshotDecision,
  type SnapshotInventoryOptions,
  type SnapshotRecord,
  type SnapshotState,
} from './inventory.js'

export { RuntimeSnapshots, type RuntimeSnapshotsConfig } from './service.js'
