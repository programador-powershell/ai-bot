/**
 * @aibot2/agent-computer — o computador do agente (m1-plano §5 E8, a parte
 * browser task-scoped): Playwright real atrás de node:http, sessão por
 * runtimeId, snapshot ARIA por ref, Take the Wheel e egress anti-SSRF.
 * Porte adaptado do openbot (MIT) — atribuições em THIRD_PARTY_NOTICES.md.
 */
export {
  SNAPSHOT_ELEMENT_LIMIT,
  parseAriaSnapshot,
  parseDescriptor,
  type SnapshotElement,
} from './aria-snapshot.js'
export {
  ControlError,
  ControlRequestError,
  HUMAN_HAS_CONTROL,
  createControl,
  type Control,
  type ControlState,
} from './control.js'
export {
  checkNavigationTarget,
  isPrivateIpv4,
  isPrivateIpv6,
  type EgressOptions,
  type EgressVerdict,
  type Resolver,
} from './egress.js'
export { SessionManager, type RuntimeSession, type SessionManagerOptions } from './sessions.js'
export { createAgentComputer, type AgentComputer, type AgentComputerConfig } from './server.js'
