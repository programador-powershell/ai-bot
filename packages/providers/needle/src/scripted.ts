/**
 * scriptedNeedle: o OrchestratorModel ROTEIRIZADO para teste — respostas em
 * fila, zero rede, chamadas gravadas. É o irmão do cmd/fakeneedle do oráculo:
 * quem testa a cascata precisa de um degrau local determinístico, e um mock
 * ad-hoc em cada teste reinventaria (mal) as mesmas garantias.
 */

import type {
  ModelHealth,
  OrchestratorModel,
  OrchestratorQuery,
  RouteQuery,
  RouteVerdict,
} from '@aibot2/needle-orchestrator'

export interface ScriptedNeedleOptions {
  /** Estado inicial de prontidão (mutável por setReady). */
  ready?: boolean
  /** Fila de vereditos de rota; esgotada = erro (roteiro furado é bug do teste). */
  routes?: RouteVerdict[]
  /** Fila de decisões CRUAS do orchestrate (a validação é do plugin). */
  decisions?: unknown[]
}

export interface ScriptedNeedle extends OrchestratorModel {
  setReady(ready: boolean): void
  readonly routeCalls: RouteQuery[]
  readonly orchestrateCalls: OrchestratorQuery[]
}

export function scriptedNeedle(options: ScriptedNeedleOptions = {}): ScriptedNeedle {
  let ready = options.ready ?? true
  const routes = [...(options.routes ?? [])]
  const decisions = [...(options.decisions ?? [])]
  const routeCalls: RouteQuery[] = []
  const orchestrateCalls: OrchestratorQuery[] = []

  return {
    routeCalls,
    orchestrateCalls,
    setReady(next: boolean) {
      ready = next
    },
    ready: () => ready,
    health: async (): Promise<ModelHealth> => (ready ? { ok: true } : { ok: false, detail: 'roteirizado como fora do ar' }),
    async route(query: RouteQuery): Promise<RouteVerdict> {
      routeCalls.push(query)
      const next = routes.shift()
      if (next === undefined) {
        throw new Error('scriptedNeedle: fila de rotas vazia — o roteiro do teste não previu esta chamada')
      }
      return next
    },
    async orchestrate(query: OrchestratorQuery): Promise<unknown> {
      orchestrateCalls.push(query)
      if (decisions.length === 0) {
        throw new Error('scriptedNeedle: fila de decisões vazia — o roteiro do teste não previu esta chamada')
      }
      return decisions.shift()
    },
  }
}
