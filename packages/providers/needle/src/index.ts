/**
 * @aibot2/provider-needle — o OrchestratorModel concreto sobre HTTP loopback
 * (Needle Pro residente) e o roteirizado de teste. Consumidores dependem do
 * seam em @aibot2/needle-orchestrator; este pacote só o implementa.
 */

export {
  NeedleHttpModel,
  NeedleUnavailableError,
  NeedleProtocolError,
  type NeedleHttpConfig,
} from './http.js'

export { scriptedNeedle, type ScriptedNeedle, type ScriptedNeedleOptions } from './scripted.js'
