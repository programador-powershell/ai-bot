/**
 * Aceite E1 — Context (m1-plano §5): plugin nas 3 formas, inject resolvido na
 * montagem, serviços com colisão barrada, disposers em ordem reversa (com
 * generator), ctx.on morrendo com o plugin e o teste-espelho do "efeito
 * reversível": unload desfaz TUDO que o plugin registrou.
 */

import { describe, expect, it } from 'vitest'
import { Context } from './context.js'
import type { Disposer } from './scope.js'

declare module './context.js' {
  interface Context {
    sinal: { valor: number }
  }
}

declare module './events.js' {
  interface Events {
    'teste-contexto/espelho'(): unknown
    'teste-contexto/vida'(): unknown
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('plugin nas 3 formas', () => {
  it('função (ctx, config) monta e registra', () => {
    const ctx = new Context()
    ctx.plugin(
      (c: Context, config: { valor: number }) => {
        c.provide('daFuncao', config.valor)
      },
      { valor: 1 },
    )
    expect(ctx.get('daFuncao')).toBe(1)
  })

  it('objeto { name, inject?, apply } monta e registra', () => {
    const ctx = new Context()
    ctx.provide('daFuncao', 1)
    const pluginObjeto = {
      name: 'objeto-exemplo',
      inject: ['daFuncao'],
      apply(c: Context) {
        c.provide('doObjeto', 2)
      },
    }
    ctx.plugin(pluginObjeto)
    expect(ctx.get('doObjeto')).toBe(2)
  })

  it('classe monta construindo (o construtor é o apply)', () => {
    const ctx = new Context()
    class PluginDeClasse {
      constructor(c: Context, config: { valor: number }) {
        c.provide('daClasse', config.valor)
      }
    }
    ctx.plugin(PluginDeClasse, { valor: 3 })
    expect(ctx.get('daClasse')).toBe(3)
  })
})

describe('inject resolvido na montagem', () => {
  it('inject faltante falha na montagem com a lista completa — o apply nem roda', () => {
    const ctx = new Context()
    let aplicou = false
    const consumidor = {
      name: 'consumidor',
      inject: ['inexistente-a', 'inexistente-b'],
      apply: () => {
        aplicou = true
      },
    }
    expect(() => ctx.plugin(consumidor)).toThrow(/inexistente-a, inexistente-b/)
    expect(aplicou).toBe(false)
  })

  it('com os serviços presentes a montagem passa e o apply enxerga ctx.<name>', () => {
    const ctx = new Context()
    ctx.provide('base', 5)
    let visto: unknown
    ctx.plugin({
      name: 'consumidor',
      inject: ['base'],
      apply: (c: Context) => {
        visto = c.get('base')
      },
    })
    expect(visto).toBe(5)
  })
})

describe('serviços', () => {
  it('provide expõe ctx.<name> para qualquer contexto da mesma raiz', () => {
    const ctx = new Context()
    ctx.plugin((c: Context) => {
      c.provide('sinal', { valor: 41 })
    })
    let visto = 0
    ctx.plugin((c: Context) => {
      visto = c.sinal.valor
    })
    expect(visto).toBe(41)
    expect(ctx.sinal.valor).toBe(41)
  })

  it('unload do dono remove o serviço', async () => {
    const ctx = new Context()
    const dono = ctx.plugin((c: Context) => {
      c.provide('sinal', { valor: 1 })
    })
    expect(ctx.get('sinal')).toBeDefined()
    await dono.dispose()
    expect(ctx.get('sinal')).toBeUndefined()
  })

  it('colisão de nome de serviço é erro, não sobrescrita', () => {
    const ctx = new Context()
    ctx.provide('unico', 1)
    expect(() => ctx.provide('unico', 2)).toThrow('colisão')
    expect(ctx.get('unico')).toBe(1)
  })

  it('nome que colide com a API do Context é erro', () => {
    const ctx = new Context()
    expect(() => ctx.provide('plugin', {})).toThrow('API do Context')
    expect(() => ctx.provide('effect', {})).toThrow('API do Context')
  })
})

describe('disposers', () => {
  it('unload desfaz na ordem reversa do registro', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    const handle = ctx.plugin((c: Context) => {
      c.effect(() => () => {
        trilha.push('primeiro')
      })
      c.effect(() => () => {
        trilha.push('segundo')
      })
      c.effect(() => () => {
        trilha.push('terceiro')
      })
    })
    await handle.dispose()
    expect(trilha).toEqual(['terceiro', 'segundo', 'primeiro'])
  })

  it('generator de disposers: cada yield registra um passo e o dispose desfaz em reverso', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    const handle = ctx.plugin((c: Context) => {
      c.effect(function* () {
        yield () => {
          trilha.push('desfaz-a')
        }
        yield () => {
          trilha.push('desfaz-b')
        }
        yield () => {
          trilha.push('desfaz-c')
        }
      })
    })
    await handle.dispose()
    expect(trilha).toEqual(['desfaz-c', 'desfaz-b', 'desfaz-a'])
  })

  it('generator que estoura no meio desfaz na hora o que já subiu', () => {
    const ctx = new Context()
    const trilha: string[] = []
    expect(() =>
      ctx.plugin((c: Context) => {
        c.effect(function* () {
          yield () => {
            trilha.push('desfaz-a')
          }
          yield () => {
            trilha.push('desfaz-b')
          }
          throw new Error('montagem do efeito quebrou')
        })
      }),
    ).toThrow('montagem do efeito quebrou')
    expect(trilha).toEqual(['desfaz-b', 'desfaz-a'])
  })

  it('setup assíncrono (promise de disposer) é aguardado antes de desfazer', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    const handle = ctx.plugin((c: Context) => {
      c.effect(async () => {
        await tick()
        trilha.push('montou')
        return () => {
          trilha.push('desmontou')
        }
      }, 'setup-assincrono')
    })
    await handle
    await handle.dispose()
    expect(trilha).toEqual(['montou', 'desmontou'])
  })

  it('disposer devolvido por ctx.effect é de disparo único (manual + unload = uma vez)', async () => {
    const ctx = new Context()
    let desfeitos = 0
    let off!: Disposer
    const handle = ctx.plugin((c: Context) => {
      off = c.effect(() => () => {
        desfeitos++
      })
    })
    await off()
    expect(desfeitos).toBe(1)
    await handle.dispose()
    expect(desfeitos).toBe(1)
  })
})

describe('ctx.on e o ciclo de vida', () => {
  it('listener morre com o plugin: após o unload o emit não alcança', async () => {
    const ctx = new Context()
    let contagem = 0
    const handle = ctx.plugin((c: Context) => {
      c.on('teste-contexto/vida', () => {
        contagem++
      })
    })
    ctx.emit('teste-contexto/vida')
    expect(contagem).toBe(1)
    await handle.dispose()
    ctx.emit('teste-contexto/vida')
    expect(contagem).toBe(1)
  })
})

describe('unload desfaz TUDO (teste-espelho do efeito reversível)', () => {
  it('on + provide + effect + plugin filho: nada sobrevive ao unload', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    let recebidos = 0
    const handle = ctx.plugin((c: Context) => {
      c.on('teste-contexto/espelho', () => {
        recebidos++
      })
      c.provide('espelhado', { valor: 42 })
      c.effect(() => () => {
        trilha.push('efeito-desfeito')
      })
      c.plugin((filho: Context) => {
        filho.provide('neto', true)
      })
    })
    // Tudo de pé antes do unload:
    ctx.emit('teste-contexto/espelho')
    expect(recebidos).toBe(1)
    expect(ctx.get('espelhado')).toEqual({ valor: 42 })
    expect(ctx.get('neto')).toBe(true)

    await handle.dispose()

    ctx.emit('teste-contexto/espelho')
    expect(recebidos).toBe(1)
    expect(ctx.get('espelhado')).toBeUndefined()
    expect(ctx.get('neto')).toBeUndefined()
    expect(trilha).toEqual(['efeito-desfeito'])
  })
})

describe('handle await-ável e montagem atômica', () => {
  it('ctx.plugin devolve handle await-ável: await espera o apply assíncrono', async () => {
    const ctx = new Context()
    const handle = ctx.plugin(async (c: Context) => {
      await tick()
      c.provide('tardio', 1)
    })
    expect(handle.status).toBe('pending')
    await handle
    expect(handle.status).toBe('active')
    expect(ctx.get('tardio')).toBe(1)
  })

  it('apply assíncrono que rejeita: rollback do que montou e o await do handle estoura', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    const handle = ctx.plugin(async (c: Context) => {
      c.effect(() => () => {
        trilha.push('rollback')
      })
      await tick()
      throw new Error('montagem falhou')
    })
    await expect(handle).rejects.toThrow('montagem falhou')
    expect(handle.status).toBe('failed')
    expect(trilha).toEqual(['rollback'])
  })

  it('apply síncrono que estoura sobe na hora e desfaz o que já tinha registrado', async () => {
    const ctx = new Context()
    const trilha: string[] = []
    expect(() =>
      ctx.plugin((c: Context) => {
        c.effect(() => () => {
          trilha.push('rollback')
        })
        throw new Error('montagem quebrada')
      }),
    ).toThrow('montagem quebrada')
    // O rollback do caminho síncrono é melhor esforço (disposers podem ser
    // assíncronos); um tick basta para ele assentar.
    await tick()
    expect(trilha).toEqual(['rollback'])
  })
})
