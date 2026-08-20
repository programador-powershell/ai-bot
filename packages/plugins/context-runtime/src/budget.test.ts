/**
 * O Budget Manager: os gatilhos da spec E6 (targetAfterCompact/soft/hard com
 * clamps, prefire a ~85% do hard) e o medidor herdado do oráculo
 * (CHARS_PER_TOKEN=4, truncamento no MEIO com marca).
 */

import { describe, expect, it } from 'vitest'
import {
  BudgetManager,
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_TOKENS,
  PROMPT_SHARE,
  approxTokens,
  truncateForContext,
} from './budget.js'

describe('gatilhos da spec: clamp(janela*x, piso, teto)', () => {
  it('janela de 1M: os tetos dos clamps mandam', () => {
    const budget = new BudgetManager(1_000_000)
    expect(budget.targetAfterCompact).toBe(64_000) // clamp(100k, 24k, 64k)
    expect(budget.soft).toBe(96_000) // clamp(180k, 48k, 96k)
    expect(budget.hard).toBe(128_000) // clamp(250k, 64k, 128k)
    expect(budget.prefireAt).toBe(Math.floor(128_000 * 0.85))
  })

  it('janela de 400k: os fatores mandam', () => {
    const budget = new BudgetManager(400_000)
    expect(budget.targetAfterCompact).toBe(40_000) // 400k*0.10 dentro de [24k,64k]
    expect(budget.soft).toBe(72_000) // 400k*0.18 dentro de [48k,96k]
    expect(budget.hard).toBe(100_000) // 400k*0.25 dentro de [64k,128k]
  })

  it('janela de 200k: os pisos dos clamps mandam', () => {
    const budget = new BudgetManager(200_000)
    expect(budget.targetAfterCompact).toBe(24_000) // 20k < piso 24k
    expect(budget.soft).toBe(48_000) // 36k < piso 48k
    expect(budget.hard).toBe(64_000) // 50k < piso 64k
  })

  it('janela pequena: o teto físico (janela*promptShare) capa os três', () => {
    const budget = new BudgetManager(8_192)
    const physical = Math.floor(8_192 * PROMPT_SHARE)
    expect(budget.fitBudget).toBe(physical)
    // Sem o teto físico, os pisos (24k/48k/64k) passariam da própria janela e
    // os gatilhos jamais disparariam — o estouro do defeito original voltaria.
    expect(budget.targetAfterCompact).toBe(physical)
    expect(budget.soft).toBe(physical)
    expect(budget.hard).toBe(physical)
  })

  it('janela ausente ou inválida cai no default conservador', () => {
    expect(new BudgetManager().windowTokens).toBe(DEFAULT_CONTEXT_TOKENS)
    expect(new BudgetManager(0).windowTokens).toBe(DEFAULT_CONTEXT_TOKENS)
    expect(new BudgetManager(-5).windowTokens).toBe(DEFAULT_CONTEXT_TOKENS)
  })

  it('a pressão sobe na ordem ok → soft → prefire → hard', () => {
    const budget = new BudgetManager(1_000_000)
    expect(budget.pressure(0)).toBe('ok')
    expect(budget.pressure(budget.soft - 1)).toBe('ok')
    expect(budget.pressure(budget.soft)).toBe('soft')
    expect(budget.pressure(budget.prefireAt)).toBe('prefire') // a preventiva de ~85%
    expect(budget.pressure(budget.hard)).toBe('hard')
    // O prefire dispara ANTES do hard — nunca no hard.
    expect(budget.prefireAt).toBeLessThan(budget.hard)
  })
})

describe('o medidor do oráculo', () => {
  it('CHARS_PER_TOKEN=4 nos dois lados', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(approxTokens('')).toBe(0)
    expect(approxTokens('abcd')).toBe(2) // len/4 + 1, como no Go
    expect(approxTokens('x'.repeat(400))).toBe(101)
  })

  it('truncamento no MEIO com marca — começo e fim sobrevivem', () => {
    const texto = 'CABECALHO ' + 'miolo '.repeat(2000) + ' STACKTRACE-FINAL'
    const cortado = truncateForContext(texto, 100)
    expect(cortado.length).toBeLessThan(texto.length)
    expect(cortado.startsWith('CABECALHO')).toBe(true)
    expect(cortado.endsWith('STACKTRACE-FINAL')).toBe(true)
    // A marca não é cosmética: sem ela o modelo lê o corte como fim do arquivo.
    expect(cortado).toContain('colagem cortada para caber na janela do modelo')
  })

  it('texto que cabe passa intacto', () => {
    expect(truncateForContext('pequeno', 100)).toBe('pequeno')
  })
})
