/**
 * @aibot2/domain-events — o event log como domínio puro + o driver sqlite.
 *
 * Consumidores dependem do seam (StorageDriver) e dos tipos do protocolo;
 * o SqliteEventStore é exportado para quem MONTA o processo (server), não
 * para quem consome o log.
 */

export {
  VERSION,
  KINDS,
  isValidKind,
  validateEnvelope,
  InvalidEnvelopeError,
  type Kind,
  type ActorKind,
  type Actor,
  type Envelope,
} from './protocol.js'

export * from './payloads.js'

export {
  MAX_EVENT_BATCH,
  durableKind,
  SessionNotFoundError,
  SessionExistsError,
  StoreInUseError,
  type SessionMeta,
  type SessionSeed,
  type EnvelopeInput,
  type StorageDriver,
} from './storage.js'

export { KeyedMutex, type ExclusiveTask } from './mutex.js'

export { SqliteEventStore, type StoreInspection } from './sqlite.js'

export { importLogJsonl, FixtureImportError } from './fixture.js'
