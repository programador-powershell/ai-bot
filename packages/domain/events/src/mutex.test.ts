/**
 * O mutex existe por causa de UMA verdade desconfortável (RS5): o event loop
 * não protege nada entre awaits. O primeiro teste DEMONSTRA a corrida que o
 * resto do pacote está proibido de reintroduzir — sem essa demonstração, o
 * mutex pareceria cerimônia e alguém o removeria num refactor.
 */

import { describe, expect, it } from 'vitest'

import { KeyedMutex } from './mutex.js'

describe('KeyedMutex', () => {
  it('a corrida é real: ler-await-gravar SEM mutex perde atualizações', async () => {
    let counter = 0
    const tasks = Array.from({ length: 50 }, () => async () => {
      const seen = counter
      await Promise.resolve() // o await no meio — a janela da corrida
      counter = seen + 1
    })
    await Promise.all(tasks.map((task) => task()))
    // Todos leram 0 antes de qualquer um gravar: sobra 1, não 50. É a mesma
    // anatomia do "dois eventos com o mesmo seq" que o Append do oráculo evita.
    expect(counter).toBe(1)
  })

  it('a MESMA seção crítica sob o mutex não perde nada', async () => {
    const mutex = new KeyedMutex()
    let counter = 0
    await Promise.all(
      Array.from({ length: 50 }, () =>
        mutex.runExclusive('s1', async () => {
          const seen = counter
          await Promise.resolve()
          counter = seen + 1
        }),
      ),
    )
    expect(counter).toBe(50)
  })

  it('é FIFO: quem chegou primeiro executa primeiro', async () => {
    const mutex = new KeyedMutex()
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        mutex.runExclusive('s1', async () => {
          await Promise.resolve()
          order.push(index)
        }),
      ),
    )
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('chaves diferentes não disputam: uma sessão travada não segura a outra', async () => {
    const mutex = new KeyedMutex()
    let releaseA!: () => void
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const slots: string[] = []
    const taskA = mutex.runExclusive('a', async () => {
      await holdA
      slots.push('a')
    })
    const taskB = mutex.runExclusive('b', async () => {
      slots.push('b')
    })

    await taskB // termina com 'a' ainda segurando a chave dela
    expect(slots).toEqual(['b'])

    releaseA()
    await taskA
    expect(slots).toEqual(['b', 'a'])
  })

  it('erro no crítico propaga ao dono e NÃO envenena a fila', async () => {
    const mutex = new KeyedMutex()
    const failing = mutex.runExclusive('s1', async () => {
      throw new Error('estourou de propósito')
    })
    const following = mutex.runExclusive('s1', async () => 'passou')

    await expect(failing).rejects.toThrow('estourou de propósito')
    await expect(following).resolves.toBe('passou')
  })

  it('aceita crítico síncrono (o driver de hoje é todo síncrono por dentro)', async () => {
    const mutex = new KeyedMutex()
    const result = await mutex.runExclusive('s1', () => 42)
    expect(result).toBe(42)
  })
})
