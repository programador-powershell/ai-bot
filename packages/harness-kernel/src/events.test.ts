/**
 * Aceite E1 — os 5 modos de dispatch (m1-plano §5): emit fire-and-forget,
 * parallel, serial, bail no primeiro não-undefined e waterfall que veta ao não
 * chamar next(). Os eventos de teste entram por declaration merging — o mesmo
 * caminho que os plugins reais usam.
 */

import { describe, expect, it } from 'vitest'
import { Context } from './context.js'

declare module './events.js' {
  interface Events {
    'teste-eventos/ping'(valor: number): unknown
    'teste-eventos/paralelo'(): unknown
    'teste-eventos/serie'(): unknown
    'teste-eventos/decide'(entrada: number): string | undefined | Promise<string | undefined>
    'teste-eventos/soma'(valor: number, next: (valor?: number) => number): number
    'teste-eventos/portao'(next: () => string): string
    'teste-eventos/fluxo'(texto: string, next: (texto?: string) => Promise<string>): Promise<string>
  }
}

describe('modos de dispatch', () => {
  it('emit é fire-and-forget: todos os listeners rodam e o retorno é ignorado', () => {
    const ctx = new Context()
    const chamados: number[] = []
    ctx.on('teste-eventos/ping', (valor) => {
      chamados.push(valor)
      return 'ignorado'
    })
    ctx.on('teste-eventos/ping', (valor) => {
      chamados.push(valor * 2)
      return 42
    })
    const resultado = ctx.emit('teste-eventos/ping', 7)
    expect(resultado).toBeUndefined()
    expect(chamados).toEqual([7, 14])
  })

  it('emit: listener quebrado não cala os demais e o erro desagua em internal/error', () => {
    const ctx = new Context()
    const chamados: number[] = []
    const erros: unknown[] = []
    ctx.on('internal/error', (erro) => {
      erros.push(erro)
    })
    ctx.on('teste-eventos/ping', () => {
      throw new Error('quebrou no meio')
    })
    ctx.on('teste-eventos/ping', (valor) => {
      chamados.push(valor)
    })
    ctx.emit('teste-eventos/ping', 1)
    expect(chamados).toEqual([1])
    expect(erros).toHaveLength(1)
    expect((erros[0] as Error).message).toBe('quebrou no meio')
  })

  it('emit: sem ouvinte de internal/error o erro estoura no emissor — sumir é pior', () => {
    const ctx = new Context()
    ctx.on('teste-eventos/ping', () => {
      throw new Error('sem canal')
    })
    expect(() => ctx.emit('teste-eventos/ping', 1)).toThrow('sem canal')
  })

  it('parallel dispara todos concorrentes e só resolve quando todos assentam', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    let liberar!: () => void
    const portao = new Promise<void>((resolve) => {
      liberar = resolve
    })
    ctx.on('teste-eventos/paralelo', async () => {
      trilha.push('a-início')
      await portao
      trilha.push('a-fim')
    })
    ctx.on('teste-eventos/paralelo', async () => {
      trilha.push('b-início')
      liberar()
      trilha.push('b-fim')
    })
    await ctx.parallel('teste-eventos/paralelo')
    // b começou antes de a terminar (concorrência) e o parallel esperou a-fim.
    expect(trilha).toEqual(['a-início', 'b-início', 'b-fim', 'a-fim'])
  })

  it('serial roda em ordem de registro, aguardando um antes do próximo', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    ctx.on('teste-eventos/serie', async () => {
      trilha.push('a-início')
      await Promise.resolve()
      trilha.push('a-fim')
    })
    ctx.on('teste-eventos/serie', () => {
      trilha.push('b')
    })
    await ctx.serial('teste-eventos/serie')
    expect(trilha).toEqual(['a-início', 'a-fim', 'b'])
  })

  it('bail para no primeiro retorno não-undefined e não chama os seguintes', async () => {
    const ctx = new Context()
    const chamados: string[] = []
    ctx.on('teste-eventos/decide', () => {
      chamados.push('passa-a-vez')
      return undefined
    })
    ctx.on('teste-eventos/decide', async (entrada) => {
      chamados.push('responde')
      return `resposta:${entrada}`
    })
    ctx.on('teste-eventos/decide', () => {
      chamados.push('nunca-roda')
      return 'tarde-demais'
    })
    const resposta = await ctx.bail('teste-eventos/decide', 9)
    expect(resposta).toBe('resposta:9')
    expect(chamados).toEqual(['passa-a-vez', 'responde'])
  })

  it('bail sem nenhuma resposta devolve undefined', async () => {
    const ctx = new Context()
    ctx.on('teste-eventos/decide', () => undefined)
    await expect(ctx.bail('teste-eventos/decide', 1)).resolves.toBeUndefined()
  })

  it('waterfall compõe em cadeia (primeiro registrado é o mais externo) e next() alcança o miolo', () => {
    const ctx = new Context()
    ctx.on('teste-eventos/soma', (valor, next) => next(valor + 1))
    ctx.on('teste-eventos/soma', (valor, next) => next(valor * 10))
    const resultado = ctx.waterfall('teste-eventos/soma', 2, (valor) => valor ?? 0)
    expect(resultado).toBe(30)
  })

  it('waterfall: não chamar next() VETA a cadeia — internos e miolo não rodam', () => {
    const ctx = new Context()
    const chamados: string[] = []
    ctx.on('teste-eventos/portao', () => {
      chamados.push('veto')
      return 'vetado'
    })
    ctx.on('teste-eventos/portao', (next) => {
      chamados.push('interno')
      return next()
    })
    const resultado = ctx.waterfall('teste-eventos/portao', () => {
      chamados.push('miolo')
      return 'aberto'
    })
    expect(resultado).toBe('vetado')
    expect(chamados).toEqual(['veto'])
  })

  it('waterfall: next() sem argumentos repassa os argumentos atuais', () => {
    const ctx = new Context()
    ctx.on('teste-eventos/soma', (_valor, next) => next())
    const resultado = ctx.waterfall('teste-eventos/soma', 5, (valor) => (valor ?? 0) + 100)
    expect(resultado).toBe(105)
  })

  it('waterfall assíncrono: o listener embrulha o await do next e devolve a promise da cadeia', async () => {
    const ctx = new Context()
    ctx.on('teste-eventos/fluxo', async (texto, next) => `[${await next(`${texto}+`)}]`)
    const resultado = await ctx.waterfall(
      'teste-eventos/fluxo',
      'x',
      async (texto) => `${texto ?? ''}!`,
    )
    expect(resultado).toBe('[x+!]')
  })

  it('waterfall: chamar next() duas vezes é erro nomeado (efeito duplicado rio abaixo)', () => {
    const ctx = new Context()
    ctx.on('teste-eventos/soma', (valor, next) => {
      next(valor)
      return next(valor)
    })
    expect(() => ctx.waterfall('teste-eventos/soma', 1, (valor) => valor ?? 0)).toThrow(
      'duas vezes',
    )
  })

  it('o disposer do on remove o listener e informa se ainda estava registrado', () => {
    const ctx = new Context()
    const chamados: number[] = []
    const off = ctx.on('teste-eventos/ping', (valor) => {
      chamados.push(valor)
    })
    ctx.emit('teste-eventos/ping', 1)
    expect(off()).toBe(true)
    expect(off()).toBe(false)
    ctx.emit('teste-eventos/ping', 2)
    expect(chamados).toEqual([1])
  })
})
