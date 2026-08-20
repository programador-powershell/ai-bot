/**
 * As três formas de plugin e a normalização para a forma interna única.
 * O kernel só raciocina sobre a forma normalizada; as três formas existem por
 * DX — módulo-gabarito (objeto via namespace), função rápida e classe (a forma
 * natural das Services).
 */

import type { Context } from './context.js'

/** Metadados aceitos em qualquer forma (propriedades/estáticos). */
export interface PluginMeta {
  /**
   * Serviços que o plugin exige. Resolvidos na MONTAGEM: faltar um deles é
   * erro em `ctx.plugin()`, com a lista completa — no uso seria tarde demais.
   * Não é isolamento: garante presença, não restringe visibilidade.
   */
  inject?: readonly string[]
  /**
   * Chaves que o plugin registra. Metadado para o compositor (M2+); hoje só
   * viaja até o handle (`scope.provides`), sem efeito.
   */
  provide?: readonly string[]
}

/** Forma função: o próprio corpo é o apply; metadados viram propriedades. */
export type PluginFunction<T = void> = ((ctx: Context, config: T) => unknown) & PluginMeta

/**
 * Forma objeto — a dos módulos-gabarito: `export const name/inject` +
 * `export function apply`, e o namespace inteiro do módulo é o plugin.
 */
export interface PluginObject<T = void> extends PluginMeta {
  name?: string
  apply(ctx: Context, config: T): unknown
}

/** Forma classe: montar constrói; uma Service registra a si mesma no construtor. */
export type PluginClass<T = void> = (new (ctx: Context, config: T) => unknown) & PluginMeta

export type Plugin<T = void> = PluginFunction<T> | PluginObject<T> | PluginClass<T>

/** @internal forma única sobre a qual o kernel opera. */
export interface NormalizedPlugin<T = void> {
  name: string
  inject: readonly string[]
  provide: readonly string[]
  apply(ctx: Context, config: T): unknown
}

/**
 * Classe ES tem `prototype` não-gravável; função comum tem gravável; arrow nem
 * tem a propriedade. É o discriminador de runtime mais estável que existe —
 * `typeof` não separa os dois casos e inspecionar o texto do fonte quebraria
 * sob transformação de código.
 */
function isConstructor(value: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'prototype')
  return descriptor !== undefined && descriptor.writable === false
}

/** @internal */
export function normalizePlugin<T>(plugin: Plugin<T>): NormalizedPlugin<T> {
  if (typeof plugin === 'function') {
    const apply: NormalizedPlugin<T>['apply'] = isConstructor(plugin)
      ? (ctx, config) => {
          // A instância não é guardada pelo kernel: uma Service se registra
          // sozinha no construtor, e é o registro que dá acesso a ela.
          new (plugin as PluginClass<T>)(ctx, config)
        }
      : (plugin as PluginFunction<T>)
    return {
      name: plugin.name || '(anônimo)',
      inject: plugin.inject ?? [],
      provide: plugin.provide ?? [],
      apply,
    }
  }
  if (typeof plugin === 'object' && plugin !== null && typeof plugin.apply === 'function') {
    return {
      name: plugin.name || '(anônimo)',
      inject: plugin.inject ?? [],
      provide: plugin.provide ?? [],
      // A arrow preserva o `this` do objeto: um apply que lê this.name (ou
      // outro campo do módulo) não pode quebrar por ter sido normalizado.
      apply: (ctx, config) => plugin.apply(ctx, config),
    }
  }
  throw new TypeError(
    '[harness-kernel] forma de plugin não reconhecida — aceitas: função (ctx, config), objeto { apply } ou classe',
  )
}
