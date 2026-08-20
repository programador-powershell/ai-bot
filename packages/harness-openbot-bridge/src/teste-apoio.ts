/**
 * APOIO DE TESTE — a montagem do transporte para a suíte.
 *
 * Sobe o kernel de verdade com os TRÊS plugins (event-log em :memory:,
 * session-bus, transporte em porta efêmera): os testes do protocolo exercitam
 * o mesmo caminho de montagem que o server/ usa em produção — testar o
 * StreamServer solto deixaria o plugin (o pedaço que o server realmente monta)
 * sem cobertura.
 */

import { Context } from '@aibot2/harness-kernel'
import { SqliteEventStore, type StorageDriver } from '@aibot2/domain-events'

import { SessionBus } from './eventbus.js'
import { sessionBusPlugin, transportePlugin, type TransporteConfig } from './plugin.js'
import type { EnvelopeDeEntrada } from './stream.js'

// [Onda 2] As fixtures e o store instrumentado moram em teste-fixtures.ts,
// compartilhados com a suíte do CHASSIS (os mesmos testes nomeados rodam nos
// dois transportes). Re-exportados aqui para os testes existentes não mudarem.
export {
  StoreComGancho,
  lerFixture,
  lerTranscricao,
  semearSessaoDeFixture,
  type LinhaDeTranscricao,
} from './teste-fixtures.js'

export const TOKEN_DE_TESTE = 'token-de-teste-do-transporte'

export interface TransporteDeTeste {
  porta: number
  store: StorageDriver
  bus: SessionBus
  ctx: Context
  /** Tudo que o transporte entregou ao seam de entrada, na ordem. */
  inbound: Array<{ sessionId: string; envelope: EnvelopeDeEntrada }>
  dispose(): Promise<void>
}

export interface OpcoesDeMontagem {
  /** Um store já preparado (ou instrumentado). Ausente = sqlite :memory:. */
  store?: StorageDriver
  folga?: number
  transporte?: Partial<TransporteConfig>
}

/** Sobe kernel + plugins e devolve os pontos de contato dos testes. */
export async function montarTransporte(opcoes?: OpcoesDeMontagem): Promise<TransporteDeTeste> {
  const ctx = new Context()
  const inbound: Array<{ sessionId: string; envelope: EnvelopeDeEntrada }> = []
  ctx.on('openbot/inbound', (sessionId, envelope) => {
    inbound.push({ sessionId, envelope })
  })

  // O event-log dos testes aceita store injetado (para os ganchos das
  // invariantes); o plugin de produção abre o sqlite ele mesmo.
  const store = opcoes?.store ?? SqliteEventStore.open(':memory:')
  await ctx.plugin(
    {
      name: 'event-log-de-teste',
      provide: ['eventos'],
      apply(contexto: Context) {
        contexto.provide('eventos', store)
        contexto.effect(() => () => store.close(), 'event-log-de-teste:fechar')
      },
    },
    undefined,
  )
  await ctx.plugin(
    sessionBusPlugin,
    opcoes?.folga !== undefined ? { folga: opcoes.folga } : undefined,
  )
  await ctx.plugin(transportePlugin, {
    token: TOKEN_DE_TESTE,
    port: 0,
    // Linger curto e prazos curtos: os testes de fechamento não podem esperar
    // os 5s de produção.
    lingerMs: 300,
    ...opcoes?.transporte,
  } as TransporteConfig)

  return {
    porta: ctx.transporte.porta,
    store,
    bus: ctx.sessionBus,
    ctx,
    inbound,
    dispose: async () => {
      await ctx.scope.dispose()
    },
  }
}

