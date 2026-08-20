/**
 * Bateria do domain/runtime — o fingerprint é a metade "cache" do aceite E7:
 * determinístico, chave com a base, só LOCKS entram, nada de segredo, nunca
 * fonte de verdade. E o parseRequirements é a metade "autoridade": o modelo
 * declara requisito; máquina nomeada pelo modelo NÃO atravessa a leitura.
 */

import { describe, expect, it } from 'vitest'
import { parseRequirements, pickLockFiles, snapshotFingerprint } from './index.js'

describe('snapshotFingerprint', () => {
  const locks = [
    { name: 'pnpm-lock.yaml', content: 'lockfileVersion: 9\npackages:\n  a@1.0.0: {}\n' },
    { name: 'package-lock.json', content: '{"lockfileVersion":3}' },
  ]

  it('é determinístico: mesmos locks, mesma base → mesma chave, em qualquer ordem', () => {
    const direto = snapshotFingerprint('node-24', locks)
    const invertido = snapshotFingerprint('node-24', [...locks].reverse())
    expect(direto.key).toBe(invertido.key)
    expect(direto.key).toBe(`node-24/${direto.digest}`)
    expect(direto.digest).toMatch(/^[0-9a-f]{6}$/)
  })

  it('a chave inclui a base: o mesmo lock sob bases diferentes NÃO colide', () => {
    const node24 = snapshotFingerprint('node-24', locks)
    const node22 = snapshotFingerprint('node-22', locks)
    expect(node24.key).not.toBe(node22.key)
    // A base entra no HASH também — não só no prefixo da chave.
    expect(node24.digest).not.toBe(node22.digest)
  })

  it('lock diferente → digest diferente (a impressão é do conteúdo instalável)', () => {
    const antes = snapshotFingerprint('node-24', locks)
    const depois = snapshotFingerprint('node-24', [
      { name: 'pnpm-lock.yaml', content: 'lockfileVersion: 9\npackages:\n  a@1.0.1: {}\n' },
      locks[1]!,
    ])
    expect(antes.digest).not.toBe(depois.digest)
  })

  it('arquivo que não é lock é IGNORADO — manifesto solto e segredo não entram no hash', () => {
    const soLocks = snapshotFingerprint('python-3.12', [
      { name: 'requirements.lock', content: 'flask==3.0.0' },
    ])
    const comLixo = snapshotFingerprint('python-3.12', [
      { name: 'requirements.lock', content: 'flask==3.0.0' },
      // Manifesto solto (>= não determina versão) e um segredo passado por engano:
      { name: 'requirements.txt', content: 'flask>=3' },
      { name: '.env', content: 'API_KEY=nunca-fingerprintar' },
    ])
    expect(comLixo.key).toBe(soLocks.key)
    expect(pickLockFiles([{ name: '.env', content: 'x' }])).toHaveLength(0)
  })

  it('sem lockfile é ERRO nomeado, não digest de lista vazia', () => {
    expect(() => snapshotFingerprint('node-24', [{ name: 'package.json', content: '{}' }])).toThrow(
      /lockfile/,
    )
  })

  it('sem base é erro: a chave é o PAR base/digest', () => {
    expect(() => snapshotFingerprint('  ', locks)).toThrow(/base/)
  })
})

describe('parseRequirements', () => {
  it('lê somente o vocabulário de requisitos, com normalização', () => {
    const parsed = parseRequirements({
      profile: ' node-24 ',
      runtimes: ['node', ' ', 'python'],
      arch: 'x64',
      minRamBytes: 8_000_000_000,
      gpu: false,
      browser: true,
      capabilities: ['webcam'],
    })
    expect(parsed).toEqual({
      profile: 'node-24',
      runtimes: ['node', 'python'],
      arch: 'x64',
      minRamBytes: 8_000_000_000,
      gpu: false,
      browser: true,
      capabilities: ['webcam'],
    })
  })

  it('máquina nomeada pelo modelo NÃO atravessa: workerId/machine são descartados', () => {
    // A Needle declara REQUISITOS; quem escolhe máquina é o scheduler (§28).
    const parsed = parseRequirements({
      runtimes: ['node'],
      workerId: 'pc-02',
      worker: 'pc-02',
      machine: 'pc-02',
      pc: 'pc-02',
    } as Record<string, unknown>)
    expect(parsed).toEqual({ runtimes: ['node'] })
    expect(JSON.stringify(parsed)).not.toContain('pc-02')
  })

  it('undefined e tipos errados viram "não exige", nunca exceção', () => {
    expect(parseRequirements(undefined)).toEqual({})
    expect(
      parseRequirements({ minRamBytes: -1, runtimes: 'node', gpu: 'sim' } as Record<
        string,
        unknown
      >),
    ).toEqual({})
  })
})
