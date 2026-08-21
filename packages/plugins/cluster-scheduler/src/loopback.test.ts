/**
 * O ELO que faltava, agora VERDE de ponta a ponta (Onda 5): o scheduler liga o
 * worker-daemon DE VERDADE. Este teste é o loopback do desenho §2 rodando ao
 * vivo — não mais um executor de mentira em `over.execute`, e sim o
 * DaemonTaskExecutor batendo nos 9 verbos §36 de um worker-daemon HTTP real em
 * 127.0.0.1:
 *
 *   Goal → plano congelado → despacho ao daemon → execução efêmera → staging →
 *   FENCE (worker+época, no control plane) → promote → evento no log → release.
 *
 * "Docker real não há nesta estação" (nota de escopo do M1): o daemon roda com
 * o LocalProcessRuntime — o seam honesto do ContainerRuntime. A validação com
 * ENGINE (dockerode) fica como pendência DECLARADA; o que se prova aqui é o
 * loopback e as invariantes de autoridade, que são indiferentes ao backend de
 * execução (foi assim que o seam foi desenhado).
 *
 * Os aceites literais da Onda 5, cada um num bloco:
 *   1. loopback ponta a ponta (Goal→…→promote) verde;
 *   2. preempção: época velha PUBLICA (o daemon executou e publicou) e mesmo
 *      assim o resultado NÃO vira verdade — a cerca do control plane recusa;
 *   3. o daemon publica e PARA — não promove, não tem rota para isso;
 *   4. reinício do server no meio não zera débito nem duplica despacho.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteEventStore } from '@aibot2/domain-events'
import { LEASE_TTL_MS, Fleet, type WorkerRecord } from '@aibot2/domain-workers'
import { WorkspaceManager } from '@aibot2/domain-workspace'
import type { TaskSpec } from '@aibot2/domain-tasks'
import {
  LocalProcessRuntime,
  createWorkerDaemon,
  type ContainerRuntime,
  type ExecutionHandle,
  type ExecutionSpec,
  type WorkerDaemon,
} from '@aibot2/worker-daemon'

import { CrewEngine } from './engine.js'
import { DaemonTaskExecutor, type ReportedEvent } from './executor.js'

const T0 = Date.parse('2026-08-20T10:00:00Z')

/** O MESMO WorkerRecord alimenta a frota e o daemon — id e capacidades batem. */
function pc(id = 'pc-02'): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: { cpus: 4, ramBytes: 8_000_000_000, arch: 'x64', runtimes: ['node'], slots: 4 },
    lastSeen: new Date(T0).toISOString(),
  }
}

/** Runtime real que RELATA o destroy — a prova do "release" (container efêmero). */
class SpyingLocalRuntime implements ContainerRuntime {
  readonly destroyed: string[] = []
  readonly #inner = new LocalProcessRuntime()
  id(): string {
    return this.#inner.id()
  }
  available(): Promise<boolean> {
    return this.#inner.available()
  }
  start(spec: ExecutionSpec): Promise<ExecutionHandle> {
    return this.#inner.start(spec)
  }
  async destroy(taskRunId: string): Promise<void> {
    this.destroyed.push(taskRunId)
    await this.#inner.destroy(taskRunId)
  }
}

interface Box {
  engine: CrewEngine
  store: SqliteEventStore
  fleet: Fleet
  clock: { value: number }
  daemon: WorkerDaemon
  runtime: SpyingLocalRuntime
  events: ReportedEvent[]
  workRoot: string
  worker: WorkerRecord
  port: number
  token: string
  newEngine: (goalId: string) => CrewEngine
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

/**
 * Sobe o control plane INTEIRO ligado a um daemon real: frota + workspaces +
 * daemon HTTP + DaemonTaskExecutor + CrewEngine. `command` decide o que a
 * execução roda (o entrypoint que o M2/toolbox ainda não fornecem — por isso é
 * injeção, não default fabricado).
 */
async function up(over: {
  goalId?: string
  command?: (taskId: string) => string[]
  wrapExecutor?: (real: DaemonTaskExecutor, ctx: { fleet: Fleet; clock: { value: number } }) => {
    run: (assignment: Parameters<DaemonTaskExecutor['run']>[0]) => Promise<string>
  }
  store?: SqliteEventStore
} = {}): Promise<Box> {
  const clock = { value: T0 }
  const store = over.store ?? SqliteEventStore.open(':memory:')
  if (over.store === undefined) cleanups.push(() => store.close())

  const worker = pc()
  const fleet = new Fleet({ now: () => clock.value })
  await fleet.register(worker)

  const workspaces = new WorkspaceManager({
    roots: () => 'C:/projeto',
    leases: { currentLease: (taskId) => fleet.currentLease(taskId) },
  })

  // O daemon real, com o executor local que RELATA destroy.
  const token = randomUUID()
  const workRoot = mkdtempSync(join(tmpdir(), 'aibot2-loopback-'))
  const runtime = new SpyingLocalRuntime()
  const daemon = createWorkerDaemon({ token, worker, runtime, workRoot, now: () => clock.value })
  const port = await daemon.listen()
  cleanups.push(async () => {
    await daemon.close()
    rmSync(workRoot, { recursive: true, force: true })
  })

  const events: ReportedEvent[] = []
  const command =
    over.command ??
    ((taskId: string) => [
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(`resultado real de ${taskId}`)})`,
    ])

  const realExecutor = new DaemonTaskExecutor({
    // O scheduler escolheu o worker; o executor só resolve o endpoint dele.
    endpointFor: (chosen) =>
      chosen.id === worker.id ? { baseUrl: `http://127.0.0.1:${port}`, token } : undefined,
    commandFor: (assignment) => ({ command: command(assignment.task.id) }),
    onEvents: (_assignment, batch) => {
      events.push(...batch)
    },
    // Poll rápido e sem relógio real: a execução local termina em milissegundos.
    pollIntervalMs: 5,
    sleep: () => Promise.resolve(),
  })

  const executor = over.wrapExecutor ? over.wrapExecutor(realExecutor, { fleet, clock }) : realExecutor

  const newEngine = (goalId: string): CrewEngine =>
    new CrewEngine({
      store,
      goalId,
      fleet,
      workspaces,
      executor,
      chooseOptions: { now: () => clock.value },
    })

  const engine = newEngine(over.goalId ?? 'crm')
  return {
    engine,
    store,
    fleet,
    clock,
    daemon,
    runtime,
    events,
    workRoot,
    worker,
    port,
    token,
    newEngine,
  }
}

function task(id: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return { id, title: `tarefa ${id}`, specialist: 'code', goal: `objetivo ${id}`, ...over }
}

describe('loopback ponta a ponta: Goal → daemon → staging → fence → promote', () => {
  it('executa no daemon REAL, promove pela cerca e registra o ciclo no journal', async () => {
    const box = await up()

    const report = await box.engine.run({ sessionId: 's1', tasks: [task('t1')] })

    // O texto veio da execução REAL no daemon (não de um executor de mentira).
    expect(report.aborted).toBe(false)
    expect(report.results['t1']).toBe('resultado real de t1')
    expect(report.report).toContain('✓ t1')

    // O ciclo de estados atravessou o journal até o desfecho durável.
    const snapshot = await box.engine.journal.replay()
    expect(snapshot.taskStates.get('t1')).toBe('task.done')
    expect(snapshot.dispatched).toBe(1)
    expect(snapshot.runs.get('run-t1-a1')).toMatchObject({
      state: 'task.done',
      workerId: box.worker.id,
      leaseEpoch: 1,
    })

    // "evento no log": os eventos RELATADOS pelo daemon (sem seq) chegaram ao
    // sink — e o desfecho worker.done está entre eles.
    expect(box.events.length).toBeGreaterThan(0)
    for (const event of box.events) {
      expect(event).not.toHaveProperty('seq')
      expect(event.from).toMatchObject({ kind: 'worker', id: box.worker.id })
    }
    expect(box.events.some((event) => event.kind === 'worker.done')).toBe(true)

    // "release": o fim da tarefa DESTRUIU a execução (container efêmero).
    expect(box.runtime.destroyed).toEqual(['run-t1-a1'])
    // E a área de espera DA ÉPOCA recebeu a publicação (staging → fence → promote).
    const staged = readFileSync(join(box.workRoot, 'staging', 't1', 'epoch-1', 'result.txt'), 'utf8')
    expect(staged).toBe('resultado real de t1')
  })

  it('encadeia dependentes: a t2 recebe o upstream de t1 pelo mesmo loopback', async () => {
    const box = await up()
    const report = await box.engine.run({
      sessionId: 's1',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
      maxConcurrency: 1,
    })
    expect(report.results['t1']).toBe('resultado real de t1')
    expect(report.results['t2']).toBe('resultado real de t2')
    expect((await box.engine.journal.replay()).dispatched).toBe(2)
  })
})

describe('preempção AO VIVO pelo daemon (aceite §25): época velha publica, não vira verdade', () => {
  it('o daemon executa e PUBLICA, mas a cerca recusa a promoção da época velha → conflict', async () => {
    const box = await up({
      // O executor real roda o loopback INTEIRO (o daemon publica em staging);
      // ao retornar, o mundo "andou": o lease vence e outro worker assume — é
      // exatamente o PC-02 que voltou do limbo depois do PC-03 pegar a tarefa.
      wrapExecutor: (real, ctx) => ({
        run: async (assignment) => {
          const text = await real.run(assignment)
          ctx.clock.value += LEASE_TTL_MS + 1
          await ctx.fleet.acquire(assignment.task.id, 'pc-99')
          return text
        },
      }),
    })

    const report = await box.engine.run({ sessionId: 's1', tasks: [task('t1')] })

    const outcome = report.outcomes[0]!
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('não pôde ser promovido')
    // A verdade NUNCA registrou o trabalho da época velha.
    expect(report.results['t1']).toBeUndefined()
    const snapshot = await box.engine.journal.replay()
    expect(snapshot.taskStates.get('t1')).toBe('task.conflict')

    // MAS o daemon executou e publicou de fato (publica-e-para): o arquivo está
    // na área de espera da época velha — recusado na promoção, não na execução.
    const staged = readFileSync(join(box.workRoot, 'staging', 't1', 'epoch-1', 'result.txt'), 'utf8')
    expect(staged).toBe('resultado real de t1')
    // E a execução foi destruída mesmo com a preempção (o release não depende do desfecho).
    expect(box.runtime.destroyed).toEqual(['run-t1-a1'])
  })
})

describe('o daemon publica e PARA — não promove (autoridade do control plane)', () => {
  it('publica na área de espera e NÃO tem rota de promoção (404)', async () => {
    const box = await up()
    await box.engine.run({ sessionId: 's1', tasks: [task('t1')] })

    // Publicou (a execução foi para staging da época)...
    const staged = readFileSync(join(box.workRoot, 'staging', 't1', 'epoch-1', 'result.txt'), 'utf8')
    expect(staged).toBe('resultado real de t1')

    // ...mas promover é do control plane: o daemon não expõe rota para isso.
    const response = await fetch(`http://127.0.0.1:${box.port}/task/promote`, {
      method: 'POST',
      headers: { authorization: `Bearer ${box.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ taskRunId: 'run-t1-a1' }),
    })
    expect(response.status).toBe(404)
  })
})

describe('reinício do server no meio: não zera débito nem duplica despacho', () => {
  it('novo motor sobre o MESMO store enxerga o débito e recusa re-despachar tarefa concluída', async () => {
    const store = SqliteEventStore.open(':memory:')
    cleanups.push(() => store.close())
    const box = await up({ goalId: 'crm', store })

    // Onda 1: t1 vai até done pelo loopback real. Débito = 1 despacho.
    await box.engine.run({ sessionId: 's1', tasks: [task('t1')] })
    expect((await box.engine.journal.replay()).dispatched).toBe(1)

    // "Reinício": um motor NOVO sobre o MESMO store e goal. O débito NÃO zera —
    // ele é contado dos envelopes de despacho, que sobrevivem ao processo.
    const reiniciado = box.newEngine('crm')
    expect((await reiniciado.journal.replay()).dispatched).toBe(1)

    // E não DUPLICA: re-submeter a tarefa já concluída é recusado pela máquina
    // de estados durável (done não transiciona para dispatched) — o mesmo
    // TaskRun não é despachado duas vezes.
    await expect(
      reiniciado.run({ sessionId: 's1', tasks: [task('t1')] }),
    ).rejects.toThrow(/transição ilegal/)
    // O débito continua 1: a recusa aconteceu ANTES de gravar um novo despacho.
    expect((await reiniciado.journal.replay()).dispatched).toBe(1)
  })
})
