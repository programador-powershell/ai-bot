/**
 * A montagem no kernel e a INTEGRAÇÃO com o cluster-scheduler: o inventário
 * anuncia localidade nas capabilities e o chooseWorker (que já pontuava
 * snapshots sem conhecer este plugin) prefere quem tem a imagem quente —
 * inclusive contra um worker menos carregado. Invalidação (manifest novo ou
 * evict) derruba a preferência na decisão SEGUINTE, sem restart de nada.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { chooseWorker } from '@aibot2/cluster-scheduler'
import type { ManifestFile } from '@aibot2/domain-runtime'
import type { WorkerRecord } from '@aibot2/domain-workers'
import { RuntimeSnapshots, SnapshotInventory } from './index.js'

const NOW = Date.parse('2026-08-20T10:00:00Z')
const LOCK: ManifestFile = { name: 'pnpm-lock.yaml', content: 'lockfileVersion: 9' }
const LOCK_NOVO: ManifestFile = { name: 'pnpm-lock.yaml', content: 'lockfileVersion: 10' }

function pc(id: string, running = 0): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: { cpus: 4, ramBytes: 8_000_000_000, arch: 'x64', runtimes: ['node'], slots: 4 },
    lastSeen: new Date(NOW).toISOString(),
    running,
  }
}

describe('RuntimeSnapshots como Service', () => {
  it('montar expõe ctx.snapshots; o unload desregistra (efeito reversível)', async () => {
    const ctx = new Context()
    const scope = ctx.plugin(RuntimeSnapshots, {})
    await scope

    expect(ctx.snapshots).toBeInstanceOf(RuntimeSnapshots)
    const decision = ctx.snapshots.decide('pc-02', 'node-24', [LOCK])
    ctx.snapshots.record('pc-02', decision.key)
    expect(ctx.snapshots.warmKeys('pc-02')).toEqual([decision.key.key])

    await scope.dispose()
    expect(ctx.get('snapshots')).toBeUndefined()
  })
})

describe('integração com o cluster-scheduler (§28 passo 6 — localidade)', () => {
  it('o scheduler prefere o worker com o snapshot quente, mesmo mais carregado', async () => {
    const ctx = new Context()
    await ctx.plugin(RuntimeSnapshots, { inventory: new SnapshotInventory({ now: () => NOW }) })

    // pc-02 materializou o snapshot; pc-01 está mais livre.
    const decision = ctx.snapshots.decide('pc-02', 'node-24', [LOCK])
    ctx.snapshots.record('pc-02', decision.key, { image: 'aibot2/node-24:base' })

    const frota = ctx.snapshots.announceAll([pc('pc-01', 0), pc('pc-02', 1)])
    const escolha = chooseWorker({}, frota, { now: () => NOW, snapshotKey: decision.key.key })
    // Localidade vence a carga: quem tem a imagem começa em segundos.
    expect(escolha).toMatchObject({ chosen: { id: 'pc-02' } })
    expect('reason' in escolha ? escolha.reason : '').toContain('snapshot')
  })

  it('manifest novo invalida a localidade: a chave nova é miss e a carga volta a decidir', async () => {
    const ctx = new Context()
    await ctx.plugin(RuntimeSnapshots, { inventory: new SnapshotInventory({ now: () => NOW }) })

    const velha = ctx.snapshots.decide('pc-02', 'node-24', [LOCK])
    ctx.snapshots.record('pc-02', velha.key)

    // O lock mudou: a decisão nova nem encontra a chave velha.
    const nova = ctx.snapshots.decide('pc-02', 'node-24', [LOCK_NOVO])
    expect(nova.hit).toBe(false)

    const frota = ctx.snapshots.announceAll([pc('pc-01', 0), pc('pc-02', 1)])
    const escolha = chooseWorker({}, frota, { now: () => NOW, snapshotKey: nova.key.key })
    // Ninguém tem a chave NOVA quente → decide a carga (pc-01, mais livre).
    expect(escolha).toMatchObject({ chosen: { id: 'pc-01' } })
  })

  it('evict derruba o anúncio na decisão seguinte — sem restart de nada', async () => {
    const ctx = new Context()
    await ctx.plugin(RuntimeSnapshots, { inventory: new SnapshotInventory({ now: () => NOW }) })

    const decision = ctx.snapshots.decide('pc-02', 'node-24', [LOCK])
    ctx.snapshots.record('pc-02', decision.key)
    ctx.snapshots.evict('pc-02', decision.key.key)

    const frota = ctx.snapshots.announceAll([pc('pc-01', 0), pc('pc-02', 1)])
    expect(frota[1]!.capabilities.snapshots).toBeUndefined()
    const escolha = chooseWorker({}, frota, { now: () => NOW, snapshotKey: decision.key.key })
    expect(escolha).toMatchObject({ chosen: { id: 'pc-01' } })
  })
})
