import { Context } from './context.js'
import type { PluginScope } from './scope.js'
import type { Plugin } from './plugin.js'

/** Uma entrada da composição: o plugin e a config daquele deploy. */
export interface PluginEntry<T = any> {
  plugin: Plugin<T>
  config?: T
}

/**
 * Composição declarativa em TS puro — a lista É o arquivo de composição
 * (YAML/loader/HMR ficaram deliberadamente fora do escopo; m1-plano §2).
 *
 * A ordem da lista é contrato: provider antes de consumidor, porque inject
 * resolve na montagem. Cada entrada é aguardada antes da próxima — um apply
 * assíncrono não pode embaralhar o que quem vem depois enxerga.
 */
export async function compose(
  entries: readonly PluginEntry[],
  ctx: Context = new Context(),
): Promise<{ ctx: Context; handles: PluginScope[] }> {
  const handles: PluginScope[] = []
  for (const entry of entries) {
    const handle = ctx.plugin(entry.plugin, entry.config)
    await handle
    handles.push(handle)
  }
  return { ctx, handles }
}
