/**
 * A árvore §23 como dado e o Puter falso: os endereços batem com o desenho, o
 * goalId de fora não escapa a conta, o provisionamento é idempotente e o fake
 * é fiel ao contrato (lança no inexistente, não devolve vazio).
 */

import { describe, expect, it } from 'vitest'
import {
  botDir,
  ensureAccountTree,
  ensureGoal,
  goalArtifactsAttempt,
  goalHistoryEntry,
  goalStagingAttempt,
  goalWorkspace,
  puterPath,
  puterUri,
  FakePuterFs,
} from './index.js'

describe('endereços da árvore §23', () => {
  it('o bot é o ofício; o Goal tem as quatro pastas e a época no endereço da tentativa', () => {
    expect(botDir('code')).toBe('/Bots/code')
    expect(goalWorkspace('goal-crm')).toBe('/Goals/goal-crm/workspace')
    expect(goalStagingAttempt('goal-crm', 't7', 17)).toBe(
      '/Goals/goal-crm/staging/t7/epoch-17',
    )
    expect(goalArtifactsAttempt('goal-crm', 't7', 17)).toBe(
      '/Goals/goal-crm/artifacts/t7/epoch-17',
    )
    expect(goalHistoryEntry('goal-crm', 't7', 17)).toBe(
      '/Goals/goal-crm/history/t7/epoch-17.json',
    )
  })

  it('duas épocas da mesma tarefa nunca colidem — a época faz parte do caminho', () => {
    expect(goalStagingAttempt('g', 't', 4)).not.toBe(goalStagingAttempt('g', 't', 5))
  })

  it('puterUri/puterPath são inversas e batem com a barra tripla do plano', () => {
    expect(puterUri('/Goals/g/workspace')).toBe('puter:///Goals/g/workspace')
    expect(puterPath('puter:///Goals/g/workspace')).toBe('/Goals/g/workspace')
    expect(puterPath('local://x')).toBe('') // o que não é puter não vira caminho
  })

  it('id com barra ou ".." NÃO endereça — não escapa a árvore da conta', () => {
    expect(() => botDir('../etc')).toThrow(/segmento válido/)
    expect(() => goalWorkspace('a/b')).toThrow(/segmento válido/)
    expect(() => goalStagingAttempt('g', '..', 1)).toThrow(/segmento válido/)
    expect(() => goalStagingAttempt('g', 't', 0)).toThrow(/inteiro positivo/)
  })
})

describe('provisionamento da conta (1 conta = 1 pessoa)', () => {
  it('cria os galhos, os bots e as pastas do Goal — e chamar de novo é seguro', async () => {
    const fs = new FakePuterFs()
    await ensureAccountTree(fs, { bots: ['code', 'design'], goals: ['goal-crm'] })

    expect(await fs.exists('/Bots/code')).toBe(true)
    expect(await fs.exists('/Bots/design')).toBe(true)
    expect(await fs.exists('/Shared')).toBe(true)
    for (const sub of ['workspace', 'artifacts', 'staging', 'history']) {
      expect(await fs.exists(`/Goals/goal-crm/${sub}`)).toBe(true)
    }

    // Idempotente: reprovisionar não lança nem duplica (mkdir tolera existente).
    await expect(ensureAccountTree(fs, { goals: ['goal-crm'] })).resolves.toBeUndefined()
  })

  it('o Goal é UM só: reusar ensureGoal não recria o mundo, só garante as pastas', async () => {
    const fs = new FakePuterFs()
    await ensureGoal(fs, 'g')
    await fs.writeFile('/Goals/g/workspace/README.md', new TextEncoder().encode('oi'))
    await ensureGoal(fs, 'g') // de novo
    // O arquivo do workspace sobreviveu — provisionar não zera o compartilhado.
    expect(fs.text('/Goals/g/workspace/README.md')).toBe('oi')
  })
})

describe('o Puter falso é fiel ao contrato', () => {
  it('lê o que escreveu, cria os pais e lista os filhos', async () => {
    const fs = new FakePuterFs()
    await fs.writeFile('/Goals/g/artifacts/t/epoch-1/out.txt', new TextEncoder().encode('r'))

    expect(fs.text('/Goals/g/artifacts/t/epoch-1/out.txt')).toBe('r')
    // Os pais nasceram do writeFile.
    expect(await fs.exists('/Goals/g/artifacts/t/epoch-1')).toBe(true)
    const entries = await fs.readdir('/Goals/g/artifacts/t')
    expect(entries).toEqual([{ name: 'epoch-1', isDirectory: true }])
  })

  it('LANÇA no inexistente — não mascara um "não subiu" com vazio', async () => {
    const fs = new FakePuterFs()
    await expect(fs.readFile('/nada')).rejects.toThrow(/inexistente/)
    await expect(fs.readdir('/nem/isso')).rejects.toThrow(/inexistente/)
    expect(await fs.exists('/nada')).toBe(false)
  })
})
