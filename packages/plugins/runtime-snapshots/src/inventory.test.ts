/**
 * Bateria do inventário — o que os testes fixam:
 * - hit/miss content-addressed: mesmo lock = hit; um byte de lock mudado =
 *   chave nova = miss (a invalidação por mudança de manifest, por construção);
 * - building não é hit nem é anunciado (imagem que ainda não existe não é
 *   localidade);
 * - evict/prune são sempre seguros e o anúncio SUBSTITUI (chave descartada
 *   some das capabilities na hora);
 * - nenhum segredo entra: .env não muda a chave e o registro não carrega
 *   conteúdo de manifest;
 * - LRU: acima do teto, o mais frio sai primeiro.
 */

import { describe, expect, it } from 'vitest'
import { snapshotFingerprint, type ManifestFile } from '@aibot2/domain-runtime'
import type { WorkerRecord } from '@aibot2/domain-workers'
import { SnapshotInventory } from './inventory.js'

const LOCK: ManifestFile = { name: 'pnpm-lock.yaml', content: 'lockfileVersion: 9' }
const LOCK_MUDADO: ManifestFile = { name: 'pnpm-lock.yaml', content: 'lockfileVersion: 10' }

function pc(id: string, snapshots?: string[]): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: {
      cpus: 4,
      ramBytes: 8_000_000_000,
      arch: 'x64',
      runtimes: ['node'],
      ...(snapshots !== undefined ? { snapshots } : {}),
    },
    lastSeen: new Date().toISOString(),
  }
}

describe('hit/miss content-addressed', () => {
  it('miss antes de registrar; hit depois; e o hit é POR worker', () => {
    const inventory = new SnapshotInventory()
    const first = inventory.decide('pc-02', 'node-24', [LOCK])
    expect(first.hit).toBe(false)
    expect(first.key.key).toMatch(/^node-24\/[0-9a-f]{6}$/)

    inventory.record('pc-02', first.key, { image: 'aibot2/node-24:abc' })
    expect(inventory.decide('pc-02', 'node-24', [LOCK])).toMatchObject({ hit: true, state: 'ready' })
    // O MESMO snapshot noutro PC é miss: o inventário é por máquina.
    expect(inventory.decide('pc-03', 'node-24', [LOCK]).hit).toBe(false)
  })

  it('mudou o manifest, mudou a chave: o registro velho vira miss SEM varredura', () => {
    const inventory = new SnapshotInventory()
    const velho = inventory.decide('pc-02', 'node-24', [LOCK])
    inventory.record('pc-02', velho.key)

    const novo = inventory.decide('pc-02', 'node-24', [LOCK_MUDADO])
    // A invalidação é por construção: chave nova não está no inventário.
    expect(novo.hit).toBe(false)
    expect(novo.key.digest).not.toBe(velho.key.digest)
    // E o velho continua hit para quem AINDA usa o lock velho (outro repo
    // pinado atrás não perde o cache dele) — até a poda decidir o contrário.
    expect(inventory.decide('pc-02', 'node-24', [LOCK]).hit).toBe(true)
  })

  it('a mesma lista de locks sob BASES diferentes nunca colide', () => {
    const inventory = new SnapshotInventory()
    const node = inventory.decide('pc-02', 'node-24', [LOCK])
    inventory.record('pc-02', node.key)
    expect(inventory.decide('pc-02', 'python-3.12', [LOCK]).hit).toBe(false)
  })

  it('building não é hit — anunciar imagem que ainda não existe manda tarefa ao vazio', () => {
    const inventory = new SnapshotInventory()
    const decision = inventory.decide('pc-02', 'node-24', [LOCK])
    inventory.building('pc-02', decision.key)
    expect(inventory.decide('pc-02', 'node-24', [LOCK])).toMatchObject({
      hit: false,
      state: 'building',
    })
    expect(inventory.warmKeys('pc-02')).toEqual([])
    // Materializou: agora sim.
    inventory.record('pc-02', decision.key)
    expect(inventory.decide('pc-02', 'node-24', [LOCK]).hit).toBe(true)
  })
})

describe('sem segredos dentro (spec §29)', () => {
  it('um .env no meio dos manifests NÃO muda a chave — a lista fechada de locks o ignora', () => {
    const inventory = new SnapshotInventory()
    const semEnv = inventory.decide('pc-02', 'node-24', [LOCK])
    const comEnv = inventory.decide('pc-02', 'node-24', [
      LOCK,
      { name: '.env', content: 'TOKEN=segredo-que-nao-pode-vazar' },
    ])
    expect(comEnv.key.key).toBe(semEnv.key.key)
  })

  it('só segredo (nenhum lock) é recusado com erro, nunca fingerprintado', () => {
    const inventory = new SnapshotInventory()
    expect(() =>
      inventory.decide('pc-02', 'node-24', [{ name: '.env', content: 'TOKEN=x' }]),
    ).toThrow(/sem lockfile/)
  })

  it('o registro guarda só metadado: nenhum conteúdo de manifest sobrevive nele', () => {
    const inventory = new SnapshotInventory()
    const decision = inventory.decide('pc-02', 'node-24', [LOCK])
    inventory.record('pc-02', decision.key, { image: 'aibot2/node-24:abc' })
    const serialized = JSON.stringify(inventory.records('pc-02'))
    expect(serialized).not.toContain('lockfileVersion')
    expect(serialized).toContain(decision.key.digest)
  })
})

describe('descartável por contrato: evict, forget e anúncio que substitui', () => {
  it('evict tira do inventário e da PRÓXIMA capabilities — o anúncio nunca mescla', () => {
    const inventory = new SnapshotInventory()
    const decision = inventory.decide('pc-02', 'node-24', [LOCK])
    inventory.record('pc-02', decision.key)

    const quente = inventory.announce(pc('pc-02'))
    expect(quente.capabilities.snapshots).toEqual([decision.key.key])

    expect(inventory.evict('pc-02', decision.key.key)).toBe(true)
    expect(inventory.evict('pc-02', decision.key.key)).toBe(false)
    const frio = inventory.announce(pc('pc-02', [decision.key.key]))
    // Mesmo que o worker viesse com a chave velha anunciada, o inventário
    // SUBSTITUI: chave evictada some — senão o scheduler correria atrás de
    // imagem morta para sempre.
    expect('snapshots' in frio.capabilities).toBe(false)
  })

  it('forget zera o worker reprovisionado; o resto da frota não sente', () => {
    const inventory = new SnapshotInventory()
    const decision = inventory.decide('pc-02', 'node-24', [LOCK])
    inventory.record('pc-02', decision.key)
    inventory.record('pc-03', decision.key)
    inventory.forget('pc-02')
    expect(inventory.warmKeys('pc-02')).toEqual([])
    expect(inventory.warmKeys('pc-03')).toEqual([decision.key.key])
  })

  it('a poda LRU corta o mais frio quando o teto estoura — e hit reaquece', () => {
    let now = Date.parse('2026-08-20T10:00:00Z')
    const inventory = new SnapshotInventory({ now: () => now, maxPerWorker: 2 })

    const locks = ['a', 'b', 'c'].map(
      (versao): ManifestFile => ({ name: 'pnpm-lock.yaml', content: `v: ${versao}` }),
    )
    const keys = locks.map((lock) => snapshotFingerprint('node-24', [lock]))

    inventory.record('pc-02', keys[0]!)
    now += 1_000
    inventory.record('pc-02', keys[1]!)
    now += 1_000
    // Hit no MAIS VELHO o reaquece: agora o frio é keys[1].
    expect(inventory.decide('pc-02', 'node-24', [locks[0]!]).hit).toBe(true)
    now += 1_000
    inventory.record('pc-02', keys[2]!)

    const warm = inventory.warmKeys('pc-02')
    expect(warm).toHaveLength(2)
    expect(warm).toContain(keys[0]!.key)
    expect(warm).toContain(keys[2]!.key)
    expect(warm).not.toContain(keys[1]!.key)
  })
})
