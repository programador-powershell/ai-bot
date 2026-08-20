/**
 * @aibot2/plugin-browser-runtime — o seam ctx.browser do kernel (m1-plano §5
 * E8, a metade plugin da frente browser task-scoped).
 *
 * Montagem no molde dos demais plugins: exports nomeados name/apply —
 * `ctx.plugin(import * as browserRuntime, { baseUrl, token })` registra
 * `ctx.browser`, e o unload do dono desregistra (e fecha o que estiver
 * aberto, porque os leases penduram disposers nos escopos).
 */

import type { Context } from '@aibot2/harness-kernel'
import { BrowserRuntimeService, type BrowserRuntimeConfig } from './service.js'

export * from './target.js'
export * from './client.js'
export * from './service.js'

export const name = 'browser-runtime'

export type Config = BrowserRuntimeConfig

export function apply(ctx: Context, config: Config): void {
  // A Service se registra sozinha no construtor; o registro pertence ao
  // escopo deste plugin — desmontar desfaz.
  new BrowserRuntimeService(ctx, config)
}
