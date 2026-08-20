/**
 * @aibot2/plugin-context-runtime — o Context Runtime + Agent Loop do AI-BOT 2
 * (m1-plano §5 E6), plugin do harness-kernel.
 *
 * Montagem no molde do gabarito (plugin-todo): exports nomeados name/inject/
 * apply — `ctx.plugin(import * as contextRuntime, config)` registra
 * `ctx.contextRuntime` E `ctx.agentLoop`, e o unload do dono desregistra os
 * dois. As classes também são montáveis diretas (forma classe do kernel).
 *
 * DECISÃO DE PACOTE: o agent loop mora AQUI, não num packages/plugins/
 * agent-loop separado. O loop é o único consumidor do assembler/budget/
 * cápsula, e o checkpoint é estado COMPARTILHADO entre os dois (a cápsula que
 * o loop dobra é a que o checkpoint serializa) — um segundo pacote dobraria a
 * superfície pública de seams sem um segundo consumidor para pagá-la, e
 * criaria dependência circular assim que o runtime quisesse anunciar o que o
 * loop fez. Se um dia outro consumidor do assembler nascer (o cluster do E7 é
 * o candidato), a separação vira mecânica: os módulos já são disjuntos.
 *
 * Zero dependências de runtime além dos pacotes do workspace — a regra do
 * repositório (homologação é por dependência).
 */

import type { Context } from '@aibot2/harness-kernel'
import { ContextRuntimeService, type ContextRuntimeConfig } from './service.js'
import { AgentLoopService, type AgentLoopConfig } from './loop.js'

export * from './budget.js'
export * from './capsule.js'
export * from './history.js'
export * from './assembler.js'
export * from './checkpoint.js'
export * from './service.js'
export * from './loop.js'

export const name = 'context-runtime'

/**
 * O funil de efeitos é pré-requisito DECLARADO: as tool calls do loop passam
 * pelo ctx.actionGateway (NUNCA por fora), então montá-lo sem o gateway é
 * engano de montagem — e engano falha na montagem, não no primeiro turno.
 */
export const inject = ['actionGateway'] as const

/** A config do plugin inteiro: o runtime e o loop compartilham store e janela. */
export interface Config extends ContextRuntimeConfig {
  model: AgentLoopConfig['model']
  maxSteps?: number
}

export function apply(ctx: Context, config: Config): void {
  // As Services registram a si mesmas no construtor; o registro pertence ao
  // escopo deste plugin — desmontar desfaz tudo. A ordem importa: o loop
  // consome ctx.contextRuntime.
  new ContextRuntimeService(ctx, {
    store: config.store,
    checkpoints: config.checkpoints,
    ...(config.contextTokens !== undefined ? { contextTokens: config.contextTokens } : {}),
  })
  new AgentLoopService(ctx, {
    store: config.store,
    model: config.model,
    ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
  })
}
