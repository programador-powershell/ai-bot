/**
 * Aceite E1 — Service (m1-plano §5): `super(ctx, name)` registra `ctx.<name>`,
 * o unload do dono desregistra, e a chave tipada entra por declaration merging.
 */

import { describe, expect, it } from 'vitest'
import { Context } from './context.js'
import { Service } from './service.js'

// Exportada porque a augmentation abaixo a referencia — com declaration emit
// ligado, tipo local em augmentation exportada é erro de compilação.
export class Placar extends Service {
  pontos = 0

  constructor(ctx: Context) {
    super(ctx, 'placar')
  }

  marcar(): void {
    this.pontos++
  }
}

declare module './context.js' {
  interface Context {
    placar: Placar
  }
}

describe('Service', () => {
  it('super(ctx, name) registra ctx.<name> com a instância', () => {
    const ctx = new Context()
    ctx.plugin(Placar)
    ctx.placar.marcar()
    expect(ctx.placar).toBeInstanceOf(Placar)
    expect(ctx.placar.pontos).toBe(1)
  })

  it('outro plugin da mesma raiz enxerga a service registrada', () => {
    const ctx = new Context()
    ctx.plugin(Placar)
    let vistos = -1
    ctx.plugin((c: Context) => {
      c.placar.marcar()
      vistos = c.placar.pontos
    })
    expect(vistos).toBe(1)
  })

  it('unload do plugin da service desregistra ctx.<name>', async () => {
    const ctx = new Context()
    const handle = ctx.plugin(Placar)
    expect(ctx.get('placar')).toBeDefined()
    await handle.dispose()
    expect(ctx.get('placar')).toBeUndefined()
  })

  it('duas services com o mesmo nome é colisão na montagem', () => {
    const ctx = new Context()
    ctx.plugin(Placar)
    expect(() => ctx.plugin(Placar)).toThrow('colisão')
  })
})
