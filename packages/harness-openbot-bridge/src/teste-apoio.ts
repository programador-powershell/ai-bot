/**
 * APOIO DE TESTE — a montagem do transporte para a suíte.
 *
 * Sobe o kernel de verdade com os TRÊS plugins (event-log em :memory:,
 * session-bus, transporte em porta efêmera): os testes do protocolo exercitam
 * o mesmo caminho de montagem que o server/ usa em produção — testar o
 * StreamServer solto deixaria o plugin (o pedaço que o server realmente monta)
 * sem cobertura.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Context } from '@aibot2/harness-kernel'
import {
  SqliteEventStore,
  importLogJsonl,
  type StorageDriver,
  type Envelope,
  type EnvelopeInput,
  type SessionMeta,
  type SessionSeed,
} from '@aibot2/domain-events'

import { SessionBus } from './eventbus.js'
import { sessionBusPlugin, transportePlugin, type TransporteConfig } from './plugin.js'
import type { EnvelopeDeEntrada } from './stream.js'

export const TOKEN_DE_TESTE = 'token-de-teste-do-transporte'

/** Caminho das fixtures do oráculo (test-fixtures/ na raiz do repo). */
const FIXTURES = new URL('../../../test-fixtures/', import.meta.url)

export function lerFixture(relativo: string): string {
  return readFileSync(fileURLToPath(new URL(relativo, FIXTURES)), 'utf8')
}

/** Uma linha de transcrição WS: o frame gravado com a direção anotada. */
export interface LinhaDeTranscricao extends Record<string, unknown> {
  _dir: '->' | '<-'
  kind: string
  seq: number
  session: string
  payload?: unknown
}

export function lerTranscricao(relativo: string): LinhaDeTranscricao[] {
  return lerFixture(relativo)
    .split(/\r?\n/)
    .filter((linha) => linha.trim() !== '')
    .map((linha) => JSON.parse(linha) as LinhaDeTranscricao)
}

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

/**
 * Semeia uma sessão do oráculo no store: o cabeçalho vem do meta.json e cada
 * envelope do log.jsonl entra pelo append (que preserva ts e renumera 1..N —
 * os seq das fixtures já são 1..N, então os números batem).
 */
export async function semearSessaoDeFixture(
  store: StorageDriver,
  pasta: 'chat-simples' | 'ferramenta-aprovada',
): Promise<SessionMeta> {
  const meta = JSON.parse(lerFixture(`sessions/${pasta}/meta.json`)) as SessionMeta
  const seed: SessionSeed = {
    id: meta.id,
    title: meta.title,
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    createdAt: meta.createdAt,
  }
  await store.createSession(seed)
  const envelopes: Envelope[] = importLogJsonl(lerFixture(`sessions/${pasta}/log.jsonl`))
  for (const envelope of envelopes) {
    await store.append(meta.id, envelope as EnvelopeInput)
  }
  return store.getSession(meta.id)
}
