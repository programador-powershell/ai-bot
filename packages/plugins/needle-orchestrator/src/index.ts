/**
 * @aibot2/needle-orchestrator — a cascata de roteamento e o contrato da
 * orquestradora, portados do oráculo Go (internal/supervisor + a spec do
 * Needle Pro). Constantes CALIBRADAS, golden tests contra o oráculo, e o
 * princípio da spec §6: cérebro, não autoridade — daqui saem decisões
 * validadas, nunca efeitos.
 */

export {
  MIN_CONFIDENCE,
  MIN_MARGIN,
  SATURATION,
  NEEDLE_MIN_CONFIDENCE,
  NEEDLE_TOOL_BUDGET,
  ATTACHMENT_WEIGHT,
  DELIVERABLE_BONUS,
  DELIVERABLE_WINDOW,
  FALLBACK_CONFIDENCE,
  CAST_LEXICAL_MIN,
  MAX_STANDBY,
  EXTENSION_OWNER,
  ORCHESTRATE_MAX_ATTEMPTS,
} from './constants.js'

export { normalize, goTrimSpace } from './text.js'
export { intentOf, hasActionVerb, INTENT_QUESTION, INTENT_REQUEST, type Intent } from './intent.js'
export { score, soleDeliverable, type Scored, type TriggerLookup } from './score.js'
export { combineAttachments, extensionOf, type CombinedScores } from './attachments.js'
export { cast, type Standby } from './cast.js'

export {
  type ModelHealth,
  type RouteQuery,
  type RouteVerdict,
  type OrchestratorQuery,
  type OrchestratorModel,
  type Classifier,
} from './seams.js'

export {
  DECISION_MODES,
  validateDecision,
  type DecisionMode,
  type DecisionTask,
  type DecisionCall,
  type OwnerChoice,
  type OwnerRequest,
  type OrchestratorDecision,
  type DecisionVerdict,
} from './decision.js'

export {
  RouterService,
  shortlistFor,
  type Route,
  type RouteInput,
  type RouteReason,
  type RouterConfig,
  type ParsedModeCommand,
} from './router.js'
