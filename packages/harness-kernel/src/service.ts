import type { Context } from './context.js'

/**
 * Classe-base de serviço: `super(ctx, name)` registra a instância como
 * `ctx.<name>` — montar o plugin expõe, unload do MESMO escopo desregistra.
 * A service não tem vida própria fora do dono: se precisar de setup/teardown
 * além do registro, o construtor usa `ctx.effect` como qualquer plugin.
 */
export abstract class Service {
  protected readonly ctx: Context

  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    ctx.provide(name, this)
  }
}
