/**
 * A ordem de decisão §28 caso a caso — e a invariante de autoridade: um
 * workerId vindo da decisão do modelo é IGNORADO; sem worker compatível a
 * resposta é FILA com motivo, nunca escolha errada calada.
 */

import { describe, expect, it } from 'vitest'
import type { WorkerRecord } from '@aibot2/domain-workers'
import { chooseWorker } from './index.js'

const NOW = Date.parse('2026-08-20T10:00:00Z')

function pc(id: string, over: Partial<WorkerRecord['capabilities']> = {}, running = 0, lastSeen = NOW): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: {
      cpus: 8,
      ramBytes: 16_000_000_000,
      arch: 'x64',
      runtimes: ['node'],
      slots: 2,
      ...over,
    },
    lastSeen: new Date(lastSeen).toISOString(),
    running,
  }
}

const clock = { now: () => NOW }

describe('chooseWorker — admissão (passos 1–5)', () => {
  it('runtime é requisito de ADMISSÃO: PC sem python não atende, mesmo ocioso', () => {
    const choice = chooseWorker({ runtimes: ['python'] }, [pc('pc-01'), pc('pc-02', { runtimes: ['node', 'python'] }, 1)], clock)
    expect(choice).toMatchObject({ chosen: { id: 'pc-02' } })
  })

  it('cpu/ram/gpu eliminam quem não cabe', () => {
    const workers = [
      pc('pc-01', { ramBytes: 4_000_000_000 }),
      pc('pc-02', { gpu: true, ramBytes: 32_000_000_000 }),
    ]
    const choice = chooseWorker({ minRamBytes: 8_000_000_000, gpu: true }, workers, clock)
    expect(choice).toMatchObject({ chosen: { id: 'pc-02' } })
  })

  it('capacidade livre: worker com todos os slots ocupados não é destino', () => {
    const workers = [pc('pc-01', { slots: 1 }, 1), pc('pc-02', { slots: 1 }, 0)]
    const choice = chooseWorker({}, workers, clock)
    expect(choice).toMatchObject({ chosen: { id: 'pc-02' } })
  })

  it('browser/devices: o bot de Design só cai em máquina com navegador', () => {
    const workers = [pc('pc-01'), pc('pc-02', { browser: true }, 1)]
    const choice = chooseWorker({ browser: true }, workers, clock)
    expect(choice).toMatchObject({ chosen: { id: 'pc-02' } })
  })

  it('worker com heartbeat vencido está morto para o scheduler', () => {
    const morto = pc('pc-01', {}, 0, NOW - 10 * 60_000)
    const vivo = pc('pc-02', {}, 1)
    const choice = chooseWorker({}, [morto, vivo], clock)
    expect(choice).toMatchObject({ chosen: { id: 'pc-02' } })
  })
})

describe('chooseWorker — ordenação (passos 6–8)', () => {
  it('localidade de snapshot vence a carga: quem tem a imagem começa em segundos', () => {
    const workers = [
      pc('pc-01', {}, 0),
      pc('pc-02', { snapshots: ['node-24/19f810'] }, 1),
    ]
    const choice = chooseWorker({}, workers, { ...clock, snapshotKey: 'node-24/19f810' })
    expect(choice).toMatchObject({ chosen: { id: 'pc-02' } })
    expect('reason' in choice ? choice.reason : '').toContain('snapshot')
  })

  it('entre iguais, o menos carregado; empate final é estável por id', () => {
    const choice = chooseWorker({}, [pc('pc-03', {}, 1), pc('pc-01', {}, 0), pc('pc-02', {}, 0)], clock)
    expect(choice).toMatchObject({ chosen: { id: 'pc-01' } })
  })

  it('política é o último árbitro: negado sai da admissão, preferido vence o empate', () => {
    const workers = [pc('pc-01'), pc('pc-02'), pc('pc-03')]
    const negado = chooseWorker({}, workers, { ...clock, policy: { denied: ['pc-01'] } })
    expect(negado).toMatchObject({ chosen: { id: 'pc-02' } })
    const preferido = chooseWorker({}, workers, { ...clock, policy: { preferred: ['pc-03'] } })
    expect(preferido).toMatchObject({ chosen: { id: 'pc-03' } })
  })
})

describe('chooseWorker — autoridade e fila', () => {
  it('a Needle DECLARA requirements e o scheduler ESCOLHE: workerId do modelo é IGNORADO', () => {
    const workers = [
      pc('pc-01', {}, 0),
      pc('pc-99', {}, 1), // a máquina que o modelo tentou nomear — compatível, porém mais carregada
    ]
    // O modelo embutiu workerId/machine nos requirements da decisão.
    const choice = chooseWorker(
      { runtimes: ['node'], workerId: 'pc-99', machine: 'pc-99' },
      workers,
      clock,
    )
    // A escolha segue a ordem §28 (carga), não a vontade do modelo.
    expect(choice).toMatchObject({ chosen: { id: 'pc-01' } })
  })

  it('workerId do modelo não vira nem admissão: a máquina nomeada incompatível continua fora', () => {
    const workers = [pc('pc-99', { runtimes: [] }, 0)]
    const choice = chooseWorker({ runtimes: ['node'], workerId: 'pc-99' }, workers, clock)
    expect(choice).toMatchObject({ queued: true })
  })

  it('sem worker compatível → FILA com motivo por máquina (aceite §41)', () => {
    const workers = [pc('pc-01'), pc('pc-02', { runtimes: ['python'] })]
    const choice = chooseWorker({ runtimes: ['jvm'] }, workers, clock)
    expect(choice).toMatchObject({ queued: true })
    const reason = 'reason' in choice ? choice.reason : ''
    expect(reason).toContain('sem worker compatível')
    expect(reason).toContain('pc-01 (runtime jvm)')
    expect(reason).toContain('pc-02 (runtime jvm)')
  })

  it('frota vazia também é fila com motivo, não exceção', () => {
    const choice = chooseWorker({}, [], clock)
    expect(choice).toMatchObject({ queued: true, reason: expect.stringContaining('nenhum worker') })
  })
})
