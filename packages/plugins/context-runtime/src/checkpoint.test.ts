/**
 * Checkpoint/recovery: checkpoint = cápsula + cursor + artefatos + pendências
 * de aprovação; resume = checkpoint + EVENT STORE — NUNCA a RAM do processo
 * anterior. O teste "mata" o runtime no meio (fecha o store, descarta o
 * Context e as Services) e retoma num processo lógico NOVO sobre o mesmo
 * arquivo sqlite + o mesmo diretório de checkpoint.
 *
 * O store é o driver sqlite REAL em ARQUIVO: retomar de um :memory: provaria
 * retomada de nada — a morte do processo levaria o log junto.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { SqliteEventStore, type StorageDriver } from '@aibot2/domain-events'
import {
  FsCheckpointStore,
  MemoryCheckpointStore,
  collectPendingApprovals,
  resumeFromCheckpoint,
  CHECKPOINT_VERSION,
} from './checkpoint.js'
import { ContextRuntimeService } from './service.js'
import { Capsule } from './capsule.js'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctxrt-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

let counter = 0
async function append(store: StorageDriver, sessionId: string, kind: string, payload: unknown): Promise<number> {
  return store.append(sessionId, {
    id: `e-${++counter}`,
    kind: kind as never,
    from: { kind: 'supervisor' },
    payload,
  })
}

describe('mata o runtime no meio e retoma do checkpoint + event store', () => {
  it('a cápsula retomada cobre o checkpoint E o que o log ganhou depois dele', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'log.sqlite')
    const checkpoints = new FsCheckpointStore(dir)

    /* -------- processo A: trabalha, tira checkpoint, morre no meio -------- */
    const storeA = SqliteEventStore.open(dbPath)
    const ctxA = new Context()
    const runtimeA = new ContextRuntimeService(ctxA, { store: storeA, checkpoints })
    await storeA.createSession({ id: 's1', title: 'migrar billing' })

    await append(storeA, 's1', 'message', { role: 'user', text: 'migre o billing' })
    await append(storeA, 's1', 'tool.result', {
      callId: 'c1', tool: 'fs.read', ok: true, artifactRef: 'artifact://fs.read/abc123',
    })
    await runtimeA.foldSession('s1')
    const saved = await runtimeA.checkpoint('s1')
    expect(saved.eventCursor).toBe(2)
    expect(saved.artifacts.map((a) => a.ref)).toContain('artifact://fs.read/abc123')

    // Depois do checkpoint, o trabalho CONTINUA — e a dobra dele só existiu
    // na RAM do processo A (foldSession abaixo) ou nem existiu (o erro).
    await append(storeA, 's1', 'ask', { askId: 'a1', question: 'derrubo a tabela?', blocking: true })
    await runtimeA.foldSession('s1')
    await append(storeA, 's1', 'tool.result', { callId: 'c2', tool: 'proc.run', ok: false, error: 'exit 1' })

    // A morte: o store fecha, o Context e a Service viram lixo. NADA do que
    // era só RAM sobrevive daqui para baixo.
    await storeA.close()

    /* --------- processo B: nasce do zero sobre o MESMO disco -------------- */
    const storeB = SqliteEventStore.open(dbPath)
    cleanups.push(() => storeB.close())
    const ctxB = new Context()
    const runtimeB = new ContextRuntimeService(ctxB, { store: storeB, checkpoints })

    const resumed = await runtimeB.resume('s1')
    expect(resumed.fromCheckpoint).toBe(true)
    // O cursor cobre TUDO — inclusive os envelopes de depois do checkpoint,
    // recuperados do event store (nunca da RAM de A). São 5: as duas falas
    // pré-checkpoint, a MARCA do próprio checkpoint (state) e os dois eventos
    // do "meio" (ask + tool.result).
    expect(resumed.capsule.cursor).toBe(5)
    // O goal foi SEMEADO pelo título da sessão na dobra do processo A (a
    // mesma regra do oráculo: cápsula sem objetivo não presta) — e o
    // checkpoint o preservou; a fala do usuário virou currentWork.
    expect(resumed.capsule.goal).toBe('migrar billing')
    expect(resumed.capsule.currentWork).toBe('migre o billing')
    expect(resumed.capsule.pending).toContain('derrubo a tabela?')
    // O erro pós-checkpoint (que A nunca dobrou) está aberto na retomada.
    expect(resumed.capsule.errors.some((e) => e.status === 'open' && e.symptom.includes('exit 1'))).toBe(true)
    // O artefato do checkpoint continua referenciado.
    expect(resumed.capsule.artifacts.map((a) => a.ref)).toContain('artifact://fs.read/abc123')
  })

  it('pendência de aprovação REAPARECE na retomada; decisão posterior a fecha', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'log.sqlite')
    const checkpoints = new FsCheckpointStore(dir)

    const storeA = SqliteEventStore.open(dbPath)
    const ctxA = new Context()
    const runtimeA = new ContextRuntimeService(ctxA, { store: storeA, checkpoints })
    await storeA.createSession({ id: 's1', title: '' })
    await append(storeA, 's1', 'tool.call', { callId: 'c1', tool: 'fs.write', digest: 'd1' })
    await append(storeA, 's1', 'approval.request', {
      callId: 'c1', tool: 'fs.write', risk: 'write', summary: 'fs.write — a.txt',
    })
    await runtimeA.foldSession('s1')
    const saved = await runtimeA.checkpoint('s1')
    expect(saved.pendingApprovals.map((p) => p.callId)).toEqual(['c1'])
    await storeA.close()

    // Reinício: o pedido reaparece — a aprovação é durável, não um canal em RAM.
    const storeB = SqliteEventStore.open(dbPath)
    const resumed = await resumeFromCheckpoint(storeB, checkpoints, 's1')
    expect(resumed.pendingApprovals.map((p) => p.callId)).toEqual(['c1'])

    // A decisão chega DEPOIS do checkpoint: o resume lê a verdade viva do log
    // — o checkpoint velho não ressuscita o pedido.
    await append(storeB, 's1', 'approval.decision', { callId: 'c1', allow: false })
    const decided = await resumeFromCheckpoint(storeB, checkpoints, 's1')
    expect(decided.pendingApprovals).toEqual([])
    await storeB.close()
  })

  it('checkpoint corrompido não derruba: a sessão se refaz SÓ pelo log', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'log.sqlite')
    const store = SqliteEventStore.open(dbPath)
    cleanups.push(() => store.close())
    await store.createSession({ id: 's1', title: '' })
    await append(store, 's1', 'message', { role: 'user', text: 'objetivo' })

    const checkpoints = new FsCheckpointStore(dir)
    mkdirSync(join(dir, 'checkpoints'), { recursive: true })
    writeFileSync(join(dir, 'checkpoints', 's1.json'), '{quebrado')

    const resumed = await resumeFromCheckpoint(store, checkpoints, 's1')
    expect(resumed.fromCheckpoint).toBe(false)
    expect(resumed.capsule.goal).toBe('objetivo')
    expect(resumed.capsule.cursor).toBe(1)
  })

  it('FsCheckpointStore: roundtrip fiel; versão desconhecida é tratada como ausente', async () => {
    const dir = tempDir()
    const checkpoints = new FsCheckpointStore(dir)
    const capsule = new Capsule()
    capsule.goal = 'g'
    capsule.cursor = 7
    await checkpoints.save({
      version: CHECKPOINT_VERSION,
      sessionId: 's/1?perigoso', // o safeId decide o nome do arquivo, não o id cru
      savedAt: new Date().toISOString(),
      eventCursor: 7,
      capsule: capsule.toData(),
      artifacts: [],
      pendingApprovals: [],
    })
    const loaded = await checkpoints.load('s/1?perigoso')
    expect(loaded?.eventCursor).toBe(7)
    expect(Capsule.fromData(loaded!.capsule).goal).toBe('g')

    await checkpoints.save({
      version: 99,
      sessionId: 'v99',
      savedAt: new Date().toISOString(),
      eventCursor: 1,
      capsule: new Capsule().toData(),
      artifacts: [],
      pendingApprovals: [],
    })
    expect(await checkpoints.load('v99')).toBeUndefined()
  })

  it('collectPendingApprovals: tool.result também fecha o pedido (timeout recusa por lá)', async () => {
    const store = SqliteEventStore.open(':memory:')
    cleanups.push(() => store.close())
    await store.createSession({ id: 's1', title: '' })
    await append(store, 's1', 'approval.request', { callId: 'c1', tool: 'fs.write', risk: 'write', summary: 'x' })
    await append(store, 's1', 'tool.result', { callId: 'c1', tool: 'fs.write', ok: false, error: 'prazo' })
    expect(await collectPendingApprovals(store, 's1')).toEqual([])
  })

  it('MemoryCheckpointStore serializa de verdade — sem referência viva ao processo anterior', async () => {
    const checkpoints = new MemoryCheckpointStore()
    const capsule = new Capsule()
    capsule.goal = 'g'
    const data = capsule.toData()
    await checkpoints.save({
      version: CHECKPOINT_VERSION, sessionId: 's1', savedAt: '', eventCursor: 0,
      capsule: data, artifacts: [], pendingApprovals: [],
    })
    // Mutação posterior no objeto vivo NÃO vaza para o checkpoint salvo.
    data.goal = 'mutado'
    const loaded = await checkpoints.load('s1')
    expect(loaded!.capsule.goal).toBe('g')
  })
})
