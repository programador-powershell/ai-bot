/**
 * Bateria do DaemonTaskExecutor em ISOLAMENTO — sem daemon de pé, com o fetch
 * injetado (FetchLike). O loopback.test prova a integração com o daemon REAL;
 * aqui provamos a lógica do cliente que aquele teste não alcança de propósito:
 * o endpoint ausente, a admissão do runtime, a execução que FALHA, o poll de
 * conclusão (publish 409→200), o cancel no caminho de erro e — a invariante de
 * autoridade — que o LEASE e a ÉPOCA que viajam no acquire vêm do PLANO
 * congelado, não do executor.
 */

import { describe, expect, it } from 'vitest'
import type { WorkerRecord } from '@aibot2/domain-workers'
import type { WorkspacePlan } from '@aibot2/domain-workspace'
import type { TaskSpec } from '@aibot2/domain-tasks'
import { DaemonTaskExecutor, type FetchLike } from './executor.js'
import type { TaskAssignment } from './engine.js'

function worker(over: Partial<WorkerRecord['capabilities']> = {}): WorkerRecord {
  return {
    id: 'pc-02',
    hostname: 'pc-02',
    capabilities: { cpus: 4, ramBytes: 8_000_000_000, arch: 'x64', runtimes: ['node'], slots: 4, ...over },
    lastSeen: new Date().toISOString(),
  }
}

function plan(over: Partial<WorkspacePlan> = {}): WorkspacePlan {
  return {
    id: 'wp-crm-t1-1',
    userId: 'paim',
    goalId: 'crm',
    taskId: 't1',
    botId: 'code',
    attempt: 1,
    workerId: 'pc-02',
    leaseEpoch: 7,
    source: { provider: 'local', uri: 'local://sem-pasta', revision: 'live' },
    runtime: { snapshotDigest: 'host' },
    staging: { uri: 'local://inplace' },
    baseline: { revision: 'live', manifestDigest: 'live' },
    ...over,
  }
}

function assignment(over: { task?: Partial<TaskSpec>; worker?: WorkerRecord } = {}): TaskAssignment {
  const task: TaskSpec = { id: 't1', title: 'tarefa', specialist: 'code', goal: 'fazer', ...over.task }
  return {
    task,
    taskRunId: 'run-t1-a1',
    attempt: 1,
    wave: 1,
    worker: over.worker ?? worker(),
    plan: plan(),
    upstream: {},
  }
}

/** Uma chamada registrada — para inspecionar o que viajou no fio. */
interface Recorded {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

/**
 * Um fetch roteirizado: cada rota devolve um status e corpo combinados; um
 * contador por rota permite roteirizar respostas diferentes na 1ª e 2ª chamada
 * (o poll de publish). Registra tudo que passou.
 */
function scriptedFetch(routes: Record<string, Array<{ status: number; body?: unknown }>>): {
  fetch: FetchLike
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const cursors: Record<string, number> = {}
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path, body })
    const scripted = routes[path]
    if (scripted === undefined || scripted.length === 0) {
      return { status: 404, json: async () => ({ error: `sem roteiro para ${path}` }) }
    }
    const index = Math.min(cursors[path] ?? 0, scripted.length - 1)
    cursors[path] = (cursors[path] ?? 0) + 1
    const chosen = scripted[index]!
    return { status: chosen.status, json: async () => chosen.body ?? {} }
  }
  return { fetch, calls }
}

const ENDPOINT = { baseUrl: 'http://127.0.0.1:9', token: 'segredo-de-teste' }

/** As rotas do caminho feliz, com a saída combinável. */
function happyRoutes(output = 'saida', overResult: Record<string, unknown> = {}) {
  return {
    '/health': [{ status: 200, body: { ok: true } }],
    '/task/acquire': [{ status: 200, body: { accepted: true } }],
    '/runtime/prepare': [{ status: 200, body: { snapshot: { key: 'node-24/abc123' } } }],
    '/workspace/materialize': [{ status: 200, body: { materialized: true } }],
    '/task/start': [{ status: 200, body: { started: true } }],
    '/lease/renew': [{ status: 200, body: { renewed: true } }],
    '/staging/publish': [{ status: 200, body: { stagingUri: 'staging://t1/epoch-7' } }],
    '/task/result': [
      {
        status: 200,
        body: {
          state: 'done',
          ok: true,
          output,
          events: [{ id: 'e1', ts: 'now', kind: 'worker.done', from: { kind: 'worker', id: 'pc-02' } }],
          ...overResult,
        },
      },
    ],
  } as Record<string, Array<{ status: number; body?: unknown }>>
}

describe('endpoint e admissão de runtime', () => {
  it('worker sem endpoint é erro NOMEADO — o scheduler escolheu máquina sem daemon', async () => {
    const executor = new DaemonTaskExecutor({
      endpointFor: () => undefined,
      commandFor: () => ({ command: ['x'] }),
    })
    await expect(executor.run(assignment())).rejects.toThrow(/sem daemon para o worker escolhido pc-02/)
  })

  it('runtime que a máquina não hospeda é recusado ANTES do acquire (extensão §28)', async () => {
    const { fetch, calls } = scriptedFetch(happyRoutes())
    const executor = new DaemonTaskExecutor({
      endpointFor: () => ENDPOINT,
      commandFor: () => ({ command: ['x'] }),
      fetch,
    })
    // A tarefa exige docker; o worker padrão não tem — admissão do TIPO recusa.
    await expect(
      executor.run(assignment({ task: { requirements: { docker: true } } })),
    ).rejects.toThrow(/runtime docker não roda em pc-02/)
    // Recusou antes de tocar o daemon: nenhum verbo foi chamado.
    expect(calls).toHaveLength(0)
  })
})

describe('o caminho feliz e a autoridade do lease', () => {
  it('bate os verbos na ordem, devolve a saída e ENTREGA os eventos ao sink', async () => {
    const { fetch, calls } = scriptedFetch(happyRoutes('resultado real'))
    const events: unknown[] = []
    const executor = new DaemonTaskExecutor({
      endpointFor: () => ENDPOINT,
      commandFor: () => ({ command: ['node', 'run.js'] }),
      onEvents: (_a, batch) => {
        events.push(...batch)
      },
      fetch,
      sleep: () => Promise.resolve(),
    })

    const output = await executor.run(assignment())
    expect(output).toBe('resultado real')

    const paths = calls.map((call) => call.path)
    // health primeiro; result por último (destrói a execução — o release).
    expect(paths[0]).toBe('/health')
    expect(paths.at(-1)).toBe('/task/result')
    expect(paths).toContain('/task/acquire')
    expect(paths).toContain('/workspace/materialize')
    expect(paths).toContain('/task/start')
    expect(paths).toContain('/staging/publish')

    // O sink recebeu o worker.done relatado pelo daemon.
    expect(events).toHaveLength(1)
  })

  it('o LEASE e a ÉPOCA do acquire vêm do PLANO congelado — nunca inventados pelo executor', async () => {
    const { fetch, calls } = scriptedFetch(happyRoutes())
    const executor = new DaemonTaskExecutor({
      endpointFor: () => ENDPOINT,
      commandFor: () => ({ command: ['x'] }),
      fetch,
      sleep: () => Promise.resolve(),
    })
    // O plano foi congelado na época 7 pelo scheduler.
    await executor.run(assignment())
    const acquire = calls.find((call) => call.path === '/task/acquire')!
    expect(acquire.body?.['lease']).toEqual({ workerId: 'pc-02', epoch: 7 })
  })

  it('prepare é PULADO sem lockfile e CHAMADO quando há manifests', async () => {
    // Sem manifestsFor: nada de prepare (snapshot host não tem o que fingerprintar).
    const sem = scriptedFetch(happyRoutes())
    await new DaemonTaskExecutor({
      endpointFor: () => ENDPOINT,
      commandFor: () => ({ command: ['x'] }),
      fetch: sem.fetch,
      sleep: () => Promise.resolve(),
    }).run(assignment())
    expect(sem.calls.some((call) => call.path === '/runtime/prepare')).toBe(false)

    // Com manifests: prepare entra com a base e o lock.
    const com = scriptedFetch(happyRoutes())
    await new DaemonTaskExecutor({
      endpointFor: () => ENDPOINT,
      commandFor: () => ({ command: ['x'] }),
      manifestsFor: () => ({ base: 'node-24', manifests: [{ name: 'bun.lock', content: 'x' }] }),
      fetch: com.fetch,
      sleep: () => Promise.resolve(),
    }).run(assignment())
    const prepare = com.calls.find((call) => call.path === '/runtime/prepare')
    expect(prepare?.body).toMatchObject({ base: 'node-24' })
  })
})

describe('poll de conclusão e falha', () => {
  it('publish 409 (ainda rodando) faz o executor esperar e renovar, e o 200 encerra', async () => {
    const routes = happyRoutes()
    // Primeira verificação: ainda rodando; segunda: publicado.
    routes['/staging/publish'] = [
      { status: 409, body: { error: 'nada a publicar: a execução não terminou' } },
      { status: 200, body: { stagingUri: 'staging://t1/epoch-7' } },
    ]
    const { fetch, calls } = scriptedFetch(routes)
    const output = await new DaemonTaskExecutor({
      endpointFor: () => ENDPOINT,
      commandFor: () => ({ command: ['x'] }),
      fetch,
      sleep: () => Promise.resolve(),
    }).run(assignment())
    expect(output).toBe('saida')
    // Publicou duas vezes (409 e 200) e renovou o lease durante a espera.
    expect(calls.filter((call) => call.path === '/staging/publish')).toHaveLength(2)
    expect(calls.filter((call) => call.path === '/lease/renew').length).toBeGreaterThanOrEqual(2)
  })

  it('execução com ok=false é FALHA: sobe o erro do daemon, não vira saída', async () => {
    const { fetch } = scriptedFetch(happyRoutes('', { ok: false, error: 'processo saiu com código 3' }))
    await expect(
      new DaemonTaskExecutor({
        endpointFor: () => ENDPOINT,
        commandFor: () => ({ command: ['x'] }),
        fetch,
        sleep: () => Promise.resolve(),
      }).run(assignment()),
    ).rejects.toThrow(/código 3/)
  })

  it('erro depois do start CANCELA a execução para não deixar zumbi, e sobe a falha original', async () => {
    const routes = happyRoutes()
    // publish devolve um erro que NÃO é 409 → falha dura no meio.
    routes['/staging/publish'] = [{ status: 500, body: { error: 'daemon explodiu' } }]
    routes['/task/cancel'] = [{ status: 200, body: { cancelled: true } }]
    const { fetch, calls } = scriptedFetch(routes)
    await expect(
      new DaemonTaskExecutor({
        endpointFor: () => ENDPOINT,
        commandFor: () => ({ command: ['x'] }),
        fetch,
        sleep: () => Promise.resolve(),
      }).run(assignment()),
    ).rejects.toThrow(/daemon explodiu/)
    // Cancelou (best-effort) a execução que ficou de pé.
    expect(calls.some((call) => call.path === '/task/cancel')).toBe(true)
  })

  it('acquire recusado (409) sobe o motivo do daemon e nem chega a materializar', async () => {
    const routes = happyRoutes()
    routes['/task/acquire'] = [{ status: 409, body: { error: 'sem slot livre (4/4)' } }]
    const { fetch, calls } = scriptedFetch(routes)
    await expect(
      new DaemonTaskExecutor({
        endpointFor: () => ENDPOINT,
        commandFor: () => ({ command: ['x'] }),
        fetch,
        sleep: () => Promise.resolve(),
      }).run(assignment()),
    ).rejects.toThrow(/sem slot livre/)
    expect(calls.some((call) => call.path === '/workspace/materialize')).toBe(false)
  })
})
