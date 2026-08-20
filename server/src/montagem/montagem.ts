/**
 * A MONTAGEM do servidor: sobe o kernel e lista os plugins com a configuração.
 *
 * Nada de lógica aqui, de propósito (m1-plano §1): o que traduz HTTP/WS para o
 * mundo do kernel mora no @aibot2/harness-openbot-bridge, e o domínio mora no
 * @aibot2/domain-events. Se este arquivo crescer além de "lista de plugins +
 * config", a lógica nova está na camada errada.
 *
 * As listas de especialistas e modelos entram por parâmetro e hoje têm padrão
 * vazio: o catálogo de verdade é da E5 (specialist-registry) — quando ela
 * chegar, este arquivo só ganha um plugin a mais na lista, que é o teste de
 * que a montagem está desenhada certa.
 */

import { join } from 'node:path'

import { Context } from '@aibot2/harness-kernel'
import type { Model } from '@aibot2/domain-events'
import {
  Transporte,
  eventLogPlugin,
  sessionBusPlugin,
  transportePlugin,
  type LogDoTransporte,
  type ProvedorDeAmbientes,
} from '@aibot2/harness-openbot-bridge'

import type { ConfigDoServidor } from './config.js'

export interface OpcoesDeMontagem {
  /** Catálogo provisório até a E5 plugar o specialist-registry. */
  specialists?: readonly string[]
  models?: readonly Model[]
  environments?: ProvedorDeAmbientes
  log?: LogDoTransporte
}

export interface ServidorMontado {
  ctx: Context
  transporte: Transporte
  /** Desmonta TUDO em ordem reversa (transporte → bus → store) — o unload do kernel. */
  dispose(): Promise<void>
}

export async function montarServidor(
  config: ConfigDoServidor,
  opcoes?: OpcoesDeMontagem,
): Promise<ServidorMontado> {
  const ctx = new Context()
  const log: LogDoTransporte =
    opcoes?.log ??
    ((mensagem, campos) => {
      // Sem biblioteca de log por decisão (stdlib até o parecer TI/SI); campos
      // sensíveis nunca chegam aqui — o transporte loga TAMANHOS de token,
      // nunca o valor.
      console.warn(`[aibot2] ${mensagem}`, campos ?? '')
    })
  // Erros de listener do kernel não podem sumir em silêncio (contrato do
  // ctx.effect assíncrono): a raiz é quem registra o ouvinte.
  ctx.on('internal/error', (erro) => {
    log('erro interno do kernel', { erro: erro instanceof Error ? erro.message : String(erro) })
  })

  try {
    await ctx.plugin(eventLogPlugin, { caminho: join(config.dataDir, 'events.db') })
    await ctx.plugin(sessionBusPlugin, {})
    await ctx.plugin(transportePlugin, {
      token: config.token,
      host: config.host,
      port: config.port,
      allowOrigins: config.allowOrigins,
      specialists: opcoes?.specialists ?? [],
      models: opcoes?.models ?? [],
      ...(opcoes?.environments !== undefined ? { environments: opcoes.environments } : {}),
      log,
    })
  } catch (erro) {
    // Montagem é atômica para quem observa: se um plugin do meio falha, os já
    // montados são desfeitos — sem isto, o event-log ficaria aberto (e o
    // arquivo preso no Windows) por uma subida que nunca aconteceu.
    await ctx.scope.dispose()
    throw erro
  }

  return {
    ctx,
    transporte: ctx.transporte,
    dispose: async () => {
      await ctx.scope.dispose()
    },
  }
}
