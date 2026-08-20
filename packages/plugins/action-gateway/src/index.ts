/**
 * @aibot2/plugin-action-gateway — o funil ÚNICO de efeitos, plugin do
 * harness-kernel (m1-plano §5 E4, decisão D3).
 *
 * Montagem no molde do gabarito (plugin-todo): exports nomeados name/apply, o
 * namespace do módulo é o plugin — `ctx.plugin(import * as actionGateway, config)`
 * registra `ctx.actionGateway` e o unload do dono desregistra. A classe
 * `ActionGatewayService` também é montável direto (forma classe do kernel).
 *
 * Nenhuma dependência de runtime além dos pacotes do workspace — a regra do
 * repositório (homologação é por dependência).
 */

import type { Context } from '@aibot2/harness-kernel'
import { ActionGatewayService, type ActionGatewayConfig } from './service.js'

export * from './gate.js'
export * from './rules.js'
export * from './intents.js'
export * from './artifacts.js'
export * from './tool-output.js'
export * from './service.js'

export const name = 'action-gateway'

export function apply(ctx: Context, config: ActionGatewayConfig): void {
  // A Service registra a si mesma no construtor (ctx.actionGateway); o
  // registro pertence ao escopo deste plugin — desmontar desfaz tudo.
  new ActionGatewayService(ctx, config)
}
