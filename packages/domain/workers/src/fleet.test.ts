/**
 * Bateria da frota — porte dos testes de internal/fleet do oráculo, mais os
 * aceites E7: renovar mantém a época; vago/vencido bumpa (nunca volta);
 * alheio válido recusa; a época SOBREVIVE ao reinício; heartbeat com prazo
 * decide quem está vivo; e a persistência em arquivo é integração REAL no
 * Windows (temp+fsync+rename), não mock.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Fleet,
  JsonFileFleetState,
  LEASE_TTL_MS,
  LeaseHeldError,
  MemoryFleetState,
  workerAlive,
  workerIdFromHostname,
  type WorkerRecord,
} from './index.js'

function pc(id: string, over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: { cpus: 8, ramBytes: 16_000_000_000, arch: 'x64', runtimes: ['node'] },
    lastSeen: new Date().toISOString(),
    ...over,
  }
}

describe('Fleet.acquire — as três saídas do desenho', () => {
  it('dono renova: MESMA época, validade estendida', async () => {
    let clock = 1_000_000
    const fleet = new Fleet({ now: () => clock })
    const primeiro = await fleet.acquire('t1', 'pc-02')
    expect(primeiro).toEqual({ workerId: 'pc-02', epoch: 1 })

    clock += 60_000
    const renovado = await fleet.acquire('t1', 'pc-02')
    expect(renovado.epoch).toBe(1)
    // A validade andou: mesmo depois do TTL original, o dono continua dono.
    clock += LEASE_TTL_MS - 30_000
    expect(await fleet.leaseExpired('t1')).toBe(false)
  })

  it('vago ou vencido: a época ANDA (nunca volta) e o novo dono assume', async () => {
    let clock = 1_000_000
    const fleet = new Fleet({ now: () => clock })
    await fleet.acquire('t1', 'pc-02')

    // PC-02 some da rede; o lease vence.
    clock += LEASE_TTL_MS + 1
    const novo = await fleet.acquire('t1', 'pc-03')
    expect(novo).toEqual({ workerId: 'pc-03', epoch: 2 })
  })

  it('alheio com lease VÁLIDO recusa — lease não se rouba, espera vencer', async () => {
    const fleet = new Fleet({ now: () => 1_000_000 })
    await fleet.acquire('t1', 'pc-02')
    await expect(fleet.acquire('t1', 'pc-03')).rejects.toThrow(LeaseHeldError)
  })

  it('lease sem tarefa é erro', async () => {
    const fleet = new Fleet()
    await expect(fleet.acquire('  ', 'pc-02')).rejects.toThrow(/sem tarefa/)
  })

  it('acquires concorrentes na mesma tarefa nunca dão duas épocas iguais a donos diferentes', async () => {
    let clock = 1_000_000
    const fleet = new Fleet({ now: () => clock, ttlMs: 0 })
    // ttl 0: todo lease nasce vencido — cada acquire disputa o bump.
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => fleet.acquire('t1', `pc-${index}`)),
    )
    const epochs = results.map((lease) => lease.epoch)
    expect(new Set(epochs).size).toBe(50)
    expect(Math.max(...epochs)).toBe(50)
  })
})

describe('Fleet — época persistida', () => {
  it('a época SOBREVIVE ao reinício do processo (aceite E7)', async () => {
    let clock = 1_000_000
    const state = new MemoryFleetState()
    const antes = new Fleet({ state, now: () => clock })
    await antes.acquire('t1', 'pc-02')
    clock += LEASE_TTL_MS + 1
    await antes.acquire('t1', 'pc-03') // época 2

    // "Reinício": outra instância sobre o MESMO estado.
    clock += LEASE_TTL_MS + 1
    const depois = new Fleet({ state, now: () => clock })
    const lease = await depois.acquire('t1', 'pc-02')
    expect(lease.epoch).toBe(3) // andou a partir do 2 persistido — nunca voltou a 1
  })

  it('JsonFileFleetState grava e relê de verdade no disco (integração Windows, sem mock)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibot2-fleet-'))
    try {
      let clock = 1_000_000
      const antes = new Fleet({ state: new JsonFileFleetState(dir), now: () => clock })
      await antes.register(pc('pc-02'))
      await antes.acquire('t1', 'pc-02')
      clock += LEASE_TTL_MS + 1
      await antes.acquire('t1', 'pc-03')

      const depois = new Fleet({ state: new JsonFileFleetState(dir), now: () => clock })
      expect(depois.workers().map((worker) => worker.id)).toContain('pc-02')
      expect(await depois.currentLease('t1')).toEqual({ workerId: 'pc-03', epoch: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Fleet.currentLease — o que a cerca consulta', () => {
  it('tarefa sem lease responde época 0 — que nunca casa com plano congelado', async () => {
    const fleet = new Fleet()
    expect(await fleet.currentLease('t-orfa')).toEqual({ workerId: '', epoch: 0 })
  })

  it('lease vencido responde sem dono e SEM bump — quem bumpa é o próximo acquire', async () => {
    let clock = 1_000_000
    const fleet = new Fleet({ now: () => clock })
    await fleet.acquire('t1', 'pc-02')
    clock += LEASE_TTL_MS + 1
    expect(await fleet.currentLease('t1')).toEqual({ workerId: '', epoch: 1 })
    expect(await fleet.leaseExpired('t1')).toBe(true)
  })
})

describe('heartbeat com prazo', () => {
  it('worker que parou de bater o coração sai dos vivos (worker morto do §41)', async () => {
    let clock = Date.parse('2026-08-20T10:00:00Z')
    const fleet = new Fleet({ now: () => clock })
    await fleet.register(pc('pc-02', { lastSeen: new Date(clock).toISOString() }))
    await fleet.register(pc('pc-03', { lastSeen: new Date(clock).toISOString() }))

    expect(fleet.aliveWorkers()).toHaveLength(2)

    // Só o pc-03 continua batendo.
    clock += 60_000
    await fleet.heartbeat('pc-03')
    clock += 60_000

    const vivos = fleet.aliveWorkers().map((worker) => worker.id)
    expect(vivos).toEqual(['pc-03'])
    expect(fleet.isAlive('pc-02')).toBe(false)
  })

  it('heartbeat de worker não registrado é erro, não registro implícito', async () => {
    const fleet = new Fleet()
    await expect(fleet.heartbeat('pc-fantasma')).rejects.toThrow(/não registrado/)
  })

  it('workerAlive recusa lastSeen ilegível em vez de tratá-lo como vivo', () => {
    expect(workerAlive({ lastSeen: 'não-é-data' }, Date.now())).toBe(false)
  })
})

describe('workerIdFromHostname', () => {
  it('deriva o id, nunca aceita pronto: minúsculas e caracteres seguros', () => {
    expect(workerIdFromHostname('DESKTOP Paim.local')).toBe('pc-desktop_paim_local')
    expect(workerIdFromHostname('')).toBe('pc-local')
  })
})
