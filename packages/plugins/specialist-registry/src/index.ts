/**
 * @aibot2/specialist-registry — QUEM o AI-BOT pode ser, como dado.
 *
 * Porte de forma do internal/specialist do oráculo Go: catálogo compilado,
 * overlay corporativo aplicável a quente (tudo-ou-nada) e o registro como
 * Service do kernel, com onChange para os caches do roteador.
 */

export {
  SURFACES,
  RAILS,
  AVATAR_SHAPES,
  AVATAR_EYES,
  AVATAR_MOUTHS,
  AVATAR_ACCESSORIES,
  AVATAR_MOTIONS,
  MASTER_ID,
  DEFAULT_ID,
  MASTER,
  COMPILED_CATALOG,
  UNIVERSAL_TOOLS,
  allowsTool,
  coerceDefinition,
  type Surface,
  type RailKind,
  type Action,
  type Avatar,
  type Relation,
  type Companion,
  type Definition,
} from './definition.js'

export {
  OVERLAY_SCHEMA_VERSION,
  OverlayError,
  parseOverlay,
  validateOverlay,
  validID,
  type Overlay,
} from './overlay.js'

export {
  SpecialistRegistry,
  type RegistryConfig,
  type RegistrySnapshot,
} from './registry.js'
