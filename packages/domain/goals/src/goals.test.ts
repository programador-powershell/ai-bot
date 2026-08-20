/**
 * Bateria do domain/goals — os tetos são a metade "política" do aceite E7:
 * zero não desliga a equipe, o clamp do planejador vale e a sessão de
 * controle é determinística (é ela que faz sub-equipe herdar o MESMO débito).
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CEILINGS,
  goalControlSessionId,
  resolveCeilings,
} from './index.js'

describe('resolveCeilings (porte de crewPolicy)', () => {
  it('sem configuração devolve os valores de fábrica 3/4/24', () => {
    expect(resolveCeilings()).toEqual({ maxDepth: 3, maxChildren: 4, maxTotal: 24 })
    expect(DEFAULT_CEILINGS).toEqual({ maxDepth: 3, maxChildren: 4, maxTotal: 24 })
  })

  it('zero é "não configurado", não "proibido tudo" — política parcial não desliga a equipe', () => {
    const resolved = resolveCeilings({ maxDepth: 0, maxChildren: 0, maxTotal: 0 })
    expect(resolved).toEqual(DEFAULT_CEILINGS)
  })

  it('valores configurados positivos substituem o padrão campo a campo', () => {
    const resolved = resolveCeilings({ maxDepth: 5, maxTotal: 48 })
    expect(resolved).toEqual({ maxDepth: 5, maxChildren: 4, maxTotal: 48 })
  })

  it('maxChildren passa pelo teto do planejador — plano não pode ser recusado por validação', () => {
    const resolved = resolveCeilings({ maxChildren: 999 }, 32)
    expect(resolved.maxChildren).toBe(32)
  })
})

describe('goalControlSessionId', () => {
  it('é determinística: reinício recalcula o mesmo id e reencontra o mesmo log', () => {
    expect(goalControlSessionId('crm')).toBe('goal-cp-crm')
    expect(goalControlSessionId('crm')).toBe(goalControlSessionId(' crm '))
  })

  it('goal sem id não tem sessão de controle', () => {
    expect(() => goalControlSessionId('  ')).toThrow(/sem id/)
  })
})
