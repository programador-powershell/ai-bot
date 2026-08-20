/**
 * O motor de ondas contra os aceites E7 e os cenários obrigatórios §41:
 * - profundidade barrada ANTES do plano;
 * - tetos duráveis: reinício não zera o débito; retry debita só unfinished;
 * - recusa-como-falha; escalação conta no portão e não em failures;
 * - preempção: época velha tenta promover → conflict, resultado NÃO vira verdade;
 * - worker morto → heartbeat/lease vencem → TaskRun re-enfileirada noutra máquina;
 * - sem worker compatível → fila com motivo;
 * - o despacho carrega o worker escolhido pelo SCHEDULER, nunca o do modelo.
 */

import { describe, expect, it } from 'vitest'
import { SqliteEventStore } from '@aibot2/domain-events'
import { LEASE_TTL_MS, Fleet, type WorkerRecord } from '@aibot2/domain-workers'
import { WorkspaceManager } from '@aibot2/domain-workspace'
import type { TaskSpec } from '@aibot2/domain-tasks'
import {
  CrewEngine,
  type CrewEngineOptions,
  type GateDecision,
  type GatePrompt,
  type TaskAssignment,
} from './index.js'

const T0 = Date.parse('2026-08-20T10:00:00Z')

function pc(id: string, runtimes: string[] = ['node']): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: { cpus: 8, ramBytes: 16_000_000_000, arch: 'x64', runtimes, slots: 8 },
    lastSeen: new Date(T0).toISOString(),
  }
}

function task(id: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return { id, title: `tarefa ${id}`, specialist: 'code', goal: `objetivo ${id}`, ...over }
}

interface Harness {
  engine: CrewEngine
  store: SqliteEventStore
  fleet: Fleet
  clock: { value: number }
  gates: GatePrompt[]
}

async function harness(over: {
  workers?: WorkerRecord[]
  execute: (assignment: TaskAssignment) => Promise<string> | string
  gate?: (prompt: GatePrompt) => Promise<GateDecision> | GateDecision
  ceilings?: CrewEngineOptions['ceilings']
  store?: SqliteEventStore
  goalId?: string
}): Promise<Harness> {
  const clock = { value: T0 }
  const store = over.store ?? SqliteEventStore.open(':memory:')
  const fleet = new Fleet({ now: () => clock.value })
  for (const worker of over.workers ?? [pc('pc-02'), pc('pc-03')]) {
    await fleet.register(worker)
  }
  const workspaces = new WorkspaceManager({
    roots: () => 'C:/projeto',
    leases: { currentLease: (taskId) => fleet.currentLease(taskId) },
  })
  const gates: GatePrompt[] = []
  const options: CrewEngineOptions = {
    store,
    goalId: over.goalId ?? 'crm',
    fleet,
    workspaces,
    executor: { run: async (assignment) => over.execute(assignment) },
    chooseOptions: { now: () => clock.value },
    decideGate: async (prompt) => {
      gates.push(prompt)
      return over.gate !== undefined ? over.gate(prompt) : 'proceed'
    },
  }
  if (over.ceilings !== undefined) options.ceilings = over.ceilings
  return { engine: new CrewEngine(options), store, fleet, clock, gates }
}

describe('caminho feliz', () => {
  it('executa as ondas, alimenta as dependentes e grava o ciclo de estados no journal', async () => {
    const seen: TaskAssignment[] = []
    const { engine, store } = await harness({
      execute: (assignment) => {
        seen.push(assignment)
        if (assignment.task.id === 't2') {
          // A dependente RECEBE o resultado de quem ela depende.
          expect(assignment.upstream['t1']).toBe('resultado de t1')
        }
        return `resultado de ${assignment.task.id}`
      },
    })

    const report = await engine.run({
      sessionId: 's1',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
    })

    expect(report.aborted).toBe(false)
    expect(report.results).toEqual({ t1: 'resultado de t1', t2: 'resultado de t2' })
    expect(report.report).toContain('✓ t1')
    expect(report.report).toContain('✓ t2')

    // O despacho é LÓGICO (tarefa+tentativa) com o PC ao lado — nunca dentro.
    expect(seen[0]!.taskRunId).toBe('run-t1-a1')
    expect(seen[0]!.taskRunId).not.toContain(seen[0]!.worker.id)
    expect(seen[0]!.plan.workerId).toBe(seen[0]!.worker.id)
    expect(seen[0]!.plan.leaseEpoch).toBeGreaterThanOrEqual(1)

    const snapshot = await engine.journal.replay()
    expect(snapshot.taskStates.get('t1')).toBe('task.done')
    expect(snapshot.taskStates.get('t2')).toBe('task.done')
    expect(snapshot.dispatched).toBe(2)
    expect(snapshot.runs.get('run-t1-a1')).toMatchObject({ state: 'task.done', workerId: seen[0]!.worker.id })
    await store.close()
  })
})

describe('tetos (D6): profundidade, orçamento durável e retry', () => {
  it('profundidade é barrada ANTES do plano — um grafo inválido nem é validado', async () => {
    const { engine, store } = await harness({ execute: () => 'ok', ceilings: { maxDepth: 2 } })
    await expect(
      // Ciclo proposital: se o plano fosse validado primeiro, o erro seria outro.
      engine.run({ sessionId: 's1', tasks: [task('a', { dependsOn: ['a'] })], depth: 2 }),
    ).rejects.toThrow(/nível 3 e o teto da política é 2/)
    await store.close()
  })

  it('o orçamento estoura com a frase do contrato e nada é despachado', async () => {
    const { engine, store } = await harness({ execute: () => 'ok', ceilings: { maxTotal: 2 } })
    await expect(
      engine.run({ sessionId: 's1', tasks: [task('a'), task('b'), task('c')] }),
    ).rejects.toThrow(/teto da política é 2 — junte tarefas/)
    expect((await engine.journal.replay()).dispatched).toBe(0)
    await store.close()
  })

  it('reinício do server no meio de uma onda NÃO zera o débito (mesmo goal, mesmo store)', async () => {
    const store = SqliteEventStore.open(':memory:')
    const antes = await harness({ execute: () => 'ok', ceilings: { maxTotal: 3 }, store })
    await antes.engine.run({ sessionId: 's1', tasks: [task('a'), task('b')] })

    // "Reinício": um motor NOVO sobre o MESMO store e goal.
    const depois = await harness({ execute: () => 'ok', ceilings: { maxTotal: 3 }, store })
    await expect(
      depois.engine.run({ sessionId: 's1', tasks: [task('c'), task('d')] }),
    ).rejects.toThrow(/já usou 2 trabalhador\(es\) e o teto da política é 3/)
    await store.close()
  })

  it('refazer refaz SÓ quem não produziu resultado (retry debita unfinished)', async () => {
    let t2Attempts = 0
    const { engine, store, gates } = await harness({
      execute: (assignment) => {
        if (assignment.task.id === 't2') {
          t2Attempts++
          if (t2Attempts === 1) throw new Error('estourou na primeira')
        }
        return `feito ${assignment.task.id} (tentativa ${assignment.attempt})`
      },
      gate: () => 'retry',
    })

    const report = await engine.run({
      sessionId: 's1',
      tasks: [task('t1'), task('t2'), task('t3', { dependsOn: ['t1', 't2'] })],
    })

    expect(report.report).toContain('refazendo 1 tarefa(s) da onda 1 (tentativa 2)')
    expect(t2Attempts).toBe(2)
    // 4 despachos: t1, t2 (falhou), t2 de novo, t3 — t1 NÃO reexecuta.
    expect((await engine.journal.replay()).dispatched).toBe(4)
    expect(report.results['t2']).toBe('feito t2 (tentativa 2)')
    expect(gates).toHaveLength(1)
    // A refação passa pelo estado retried no journal.
    expect((await engine.journal.replay()).runs.get('run-t2-a2')?.state).toBe('task.done')
    await store.close()
  })
})

describe('recusa e escalação', () => {
  it('RECUSA é falha: sem results, com ✗ no relatório e task.failed no journal', async () => {
    const { engine, store } = await harness({
      execute: (assignment) =>
        assignment.task.id === 't1' ? 'Não posso ajudar com isso.' : 'trabalho feito',
    })
    const report = await engine.run({
      sessionId: 's1',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
      maxConcurrency: 1,
    })
    expect(report.results['t1']).toBeUndefined()
    expect(report.report).toContain('✗ t1: o trabalhador recusou a tarefa')
    expect((await engine.journal.replay()).taskStates.get('t1')).toBe('task.failed')
    await store.close()
  })

  it('resposta vazia não é tarefa concluída', async () => {
    const { engine, store } = await harness({ execute: () => '   ' })
    const report = await engine.run({ sessionId: 's1', tasks: [task('t1')] })
    expect(report.outcomes[0]).toMatchObject({
      ok: false,
      error: 'o trabalhador terminou sem produzir resultado',
    })
    await store.close()
  })

  it('ESCALAR conta no portão e NÃO em failures — o texto separa as duas perguntas', async () => {
    const { engine, store, gates } = await harness({
      execute: (assignment) =>
        assignment.task.id === 't1' ? 'ESCALAR: qual banco de dados usar?' : 'feito',
    })
    const report = await engine.run({
      sessionId: 's1',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
    })
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({ failures: 0, escalations: 1 })
    expect(gates[0]!.reason).toContain('escalaram e esperam resposta')
    expect(report.report).toContain('↑ t1 (escalou e espera resposta)')
    // Escalação não é ✗ — e não entra em results.
    expect(report.report).not.toContain('✗ t1')
    expect(report.results['t1']).toBeUndefined()
    await store.close()
  })

  it('portão abort interrompe a execução e o relatório diz onde', async () => {
    const { engine, store } = await harness({
      execute: () => {
        throw new Error('quebrou')
      },
      gate: () => 'abort',
    })
    const report = await engine.run({
      sessionId: 's1',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
    })
    expect(report.aborted).toBe(true)
    expect(report.report).toContain('execução abortada no portão')
    await store.close()
  })
})

describe('preempção e a cerca (teste de preempção do aceite E7)', () => {
  it('worker com época velha tenta promover → conflict; o resultado NÃO vira verdade', async () => {
    const context: { fleet?: Fleet; clock?: { value: number } } = {}
    const { engine, store, fleet, clock } = await harness({
      execute: async () => {
        // No MEIO da execução o pc-02 "perde a rede": o lease vence e outro
        // worker assume — a época anda.
        context.clock!.value += LEASE_TTL_MS + 1
        await context.fleet!.acquire('t1', 'pc-03')
        return 'trabalho da época velha'
      },
    })
    context.fleet = fleet
    context.clock = clock

    const report = await engine.run({ sessionId: 's1', tasks: [task('t1')] })

    const outcome = report.outcomes[0]!
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('o resultado não pôde ser promovido')
    // A verdade NUNCA registrou o trabalho da época velha.
    expect(report.results['t1']).toBeUndefined()
    const snapshot = await engine.journal.replay()
    expect(snapshot.taskStates.get('t1')).toBe('task.conflict')
    expect(snapshot.runs.get('run-t1-a1')?.state).toBe('task.conflict')
    await store.close()
  })
})

describe('cenários §41: worker morto e fila', () => {
  it('worker morto → heartbeat/lease vencem → a TaskRun é re-enfileirada noutra máquina com época nova', async () => {
    const dispatches: Array<{ worker: string; epoch: number; attempt: number }> = []
    const context: { fleet?: Fleet; clock?: { value: number } } = {}
    const { engine, store, fleet, clock } = await harness({
      // pc-02 entra primeiro no desempate estável; pc-03 é o sobrevivente.
      workers: [pc('pc-02'), pc('pc-03')],
      execute: (assignment) => {
        dispatches.push({
          worker: assignment.worker.id,
          epoch: assignment.plan.leaseEpoch,
          attempt: assignment.attempt,
        })
        if (assignment.attempt === 1) {
          // O PC morre no meio: o resultado nunca chega.
          throw new Error('conexão com o worker perdida')
        }
        return 'terminado pela segunda máquina'
      },
      gate: async (): Promise<GateDecision> => {
        // Entre as tentativas o tempo passa: o heartbeat do pc-02 vence, o
        // lease vence, e só o pc-03 continua batendo o coração.
        context.clock!.value += LEASE_TTL_MS + 1
        await context.fleet!.heartbeat('pc-03')
        return 'retry'
      },
    })
    context.fleet = fleet
    context.clock = clock

    const report = await engine.run({
      sessionId: 's1',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
    })

    expect(dispatches[0]).toMatchObject({ worker: 'pc-02', epoch: 1, attempt: 1 })
    // Re-enfileirada: outro PC, época BUMPADA — o que faz o resultado atrasado
    // do pc-02 bater na cerca se um dia chegar.
    expect(dispatches[1]).toMatchObject({ worker: 'pc-03', epoch: 2, attempt: 2 })
    expect(report.results['t1']).toBe('terminado pela segunda máquina')
    await store.close()
  })

  it('sem worker compatível → fila com MOTIVO (e o modelo não fura a fila nomeando máquina)', async () => {
    const { engine, store } = await harness({
      workers: [pc('pc-02', ['node'])],
      execute: () => 'nunca chega aqui',
    })
    const report = await engine.run({
      sessionId: 's1',
      tasks: [
        task('t1', { requirements: { runtimes: ['python'], workerId: 'pc-02' } }),
        task('t2', { dependsOn: ['t1'] }),
      ],
      maxConcurrency: 1,
    })
    const queued = report.outcomes.find((outcome) => outcome.taskId === 't1')!
    expect(queued.queued).toBe(true)
    expect(queued.error).toContain('sem worker compatível')
    expect(queued.error).toContain('pc-02 (runtime python)')
    expect(report.report).toContain('✗ t1 (fila)')
    // Nada foi despachado para t1: nem gasto de orçamento, nem estado além de ready.
    const snapshot = await engine.journal.replay()
    expect(snapshot.taskStates.get('t1')).toBe('task.ready')
    await store.close()
  })

  it('insumo obrigatório ausente segura o despacho até existir (readiness dinâmica)', async () => {
    const { engine, store, gates } = await harness({
      execute: (assignment) => `feito ${assignment.task.id}`,
      gate: () => 'retry',
    })
    const report = await engine.run({
      sessionId: 's1',
      tasks: [
        task('produtor', { produces: ['binario'] }),
        task('consumidor', { needs: ['binario'] }),
        task('final', { dependsOn: ['produtor', 'consumidor'] }),
      ],
    })
    // Tentativa 1: consumidor esperou o insumo; o retry o despachou depois de
    // o produtor concluir — sem aresta dependsOn artificial entre os dois.
    expect(gates.length).toBeGreaterThanOrEqual(1)
    expect(report.report).toContain('aguardando insumo obrigatório: binario')
    expect(report.results['consumidor']).toBe('feito consumidor')
    expect(report.results['final']).toBe('feito final')
    await store.close()
  })
})
