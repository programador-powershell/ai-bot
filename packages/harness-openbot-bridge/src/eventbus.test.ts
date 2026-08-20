/**
 * Aceite do barramento por sessão: gravar ANTES de distribuir, o envelope
 * distribuído é RELIDO do log (byte-idêntico ao replay de amanhã), e assinante
 * lento é desconectado com o sinal de atraso — nunca esperado.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteEventStore, type EnvelopeInput } from '@aibot2/domain-events'

import { SessionBus, type ItemDaAssinatura } from './eventbus.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function novoBus(folga?: number): { bus: SessionBus; store: SqliteEventStore } {
  const store = SqliteEventStore.open(':memory:')
  cleanups.push(() => store.close())
  const bus = folga !== undefined ? new SessionBus(store, folga) : new SessionBus(store)
  return { bus, store }
}

function evento(id: string, texto = 'oi'): EnvelopeInput {
  return { id, kind: 'message', from: { kind: 'user' }, payload: { role: 'user', text: texto } }
}

describe('publish', () => {
  it('grava no log ANTES de distribuir — o assinante recebe o envelope RELIDO, com seq e ts do store', async () => {
    const { bus, store } = novoBus()
    await store.createSession({ id: 's1' })
    const assinatura = bus.subscribe('s1')

    const seq = await bus.publish('s1', evento('e1'))
    expect(seq).toBe(1)

    const item = await assinatura.proximo()
    expect(item.tipo).toBe('evento')
    if (item.tipo === 'evento') {
      // O que chegou ao vivo é EXATAMENTE o que o replay entregaria amanhã.
      const [gravado] = await store.since('s1', 0, 1)
      expect(item.envelope).toEqual(gravado)
      expect(item.envelope.seq).toBe(1)
      expect(item.envelope.ts).not.toBe('')
    }
    assinatura.close()
  })

  it('publicações concorrentes na mesma sessão chegam ao assinante em ordem de seq', async () => {
    const { bus, store } = novoBus()
    await store.createSession({ id: 's1' })
    const assinatura = bus.subscribe('s1')

    await Promise.all(
      Array.from({ length: 20 }, (_, indice) => bus.publish('s1', evento(`e${indice}`))),
    )

    const vistos: number[] = []
    for (let i = 0; i < 20; i++) {
      const item = await assinatura.proximo()
      if (item.tipo === 'evento') vistos.push(item.envelope.seq)
    }
    expect(vistos).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    assinatura.close()
  })

  it('publishEphemeral distribui SEM gravar — o lastSeq não anda e o replay não reencena', async () => {
    const { bus, store } = novoBus()
    await store.createSession({ id: 's1' })
    const assinatura = bus.subscribe('s1')

    bus.publishEphemeral('s1', {
      v: 1,
      id: '',
      ts: new Date().toISOString(),
      seq: 0,
      session: 's1',
      kind: 'state',
      from: { kind: 'system' },
      payload: { busy: true },
    })

    const item = await assinatura.proximo()
    expect(item.tipo).toBe('evento')
    if (item.tipo === 'evento') expect(item.envelope.seq).toBe(0)
    expect(await store.lastSeq('s1')).toBe(0)
    assinatura.close()
  })
})

describe('assinante lento (o Lagged do oráculo)', () => {
  it('fila além da folga vira sinal `atrasado` TERMINAL — e o assinante sai do tópico', async () => {
    const { bus, store } = novoBus(4)
    await store.createSession({ id: 's1' })
    const lerdo = bus.subscribe('s1')

    // Ninguém consome: a 5ª publicação estoura a folga de 4.
    for (let i = 0; i < 6; i++) {
      await bus.publish('s1', evento(`e${i}`))
    }

    const item = await lerdo.proximo()
    expect(item.tipo).toBe('atrasado')
    // Terminal: depois do atraso não vem mais nada (nem os que estavam na fila
    // — buraco no meio do stream é pior que reconectar).
    expect(bus.listeners('s1')).toBe(0)
    const depois: ItemDaAssinatura = await lerdo.proximo()
    expect(depois.tipo).toBe('atrasado')
  })

  it('um assinante lento NÃO derruba o rápido — cada fila é de um', async () => {
    const { bus, store } = novoBus(2)
    await store.createSession({ id: 's1' })
    const lerdo = bus.subscribe('s1')
    const rapido = bus.subscribe('s1')

    const recebidos: number[] = []
    const consumo = (async () => {
      for (;;) {
        const item = await rapido.proximo()
        if (item.tipo !== 'evento') return
        recebidos.push(item.envelope.seq)
        if (recebidos.length === 6) return
      }
    })()

    for (let i = 0; i < 6; i++) {
      await bus.publish('s1', evento(`e${i}`))
      // Dá vez ao consumidor rápido drenar a fila dele.
      await new Promise((resolve) => setImmediate(resolve))
    }
    await consumo
    expect(recebidos).toEqual([1, 2, 3, 4, 5, 6])
    expect((await lerdo.proximo()).tipo).toBe('atrasado')
    rapido.close()
  })
})

describe('assinaturas', () => {
  it('close é idempotente e libera quem espera com o sinal `fechada`', async () => {
    const { bus, store } = novoBus()
    await store.createSession({ id: 's1' })
    const assinatura = bus.subscribe('s1')
    const pendente = assinatura.proximo()
    assinatura.close()
    assinatura.close()
    expect((await pendente).tipo).toBe('fechada')
    expect(bus.listeners('s1')).toBe(0)
  })

  it('listeners conta por sessão — o supervisor decide se vale continuar um turno que ninguém vê', async () => {
    const { bus, store } = novoBus()
    await store.createSession({ id: 's1' })
    expect(bus.listeners('s1')).toBe(0)
    const a = bus.subscribe('s1')
    const b = bus.subscribe('s1')
    expect(bus.listeners('s1')).toBe(2)
    a.close()
    expect(bus.listeners('s1')).toBe(1)
    b.close()
    expect(bus.listeners('s1')).toBe(0)
  })
})
