/**
 * Bateria do daemon — HTTP REAL em 127.0.0.1 (porta efêmera), token gerado
 * por teste (segredo nunca mora no repositório). Os aceites E7:
 * - os verbos da spec §36 respondem e o resto é 404 (SEM Docker passthrough);
 * - token errado é 401 em toda rota;
 * - o daemon EXECUTA e RELATA: nenhum evento reportado carrega `seq`;
 * - publica na área de espera da ÉPOCA e PARA (não promove);
 * - renovação de lease com época diferente é recusada;
 * - fim da tarefa destrói a execução (container efêmero).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkerRecord } from '@aibot2/domain-workers'
import type { WorkspacePlan } from '@aibot2/domain-workspace'
import {
  LocalProcessRuntime,
  createWorkerDaemon,
  type ContainerRuntime,
  type ExecutionResult,
  type ExecutionSpec,
  type WorkerDaemon,
} from './index.js'

function worker(id = 'pc-02'): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: { cpus: 4, ramBytes: 8_000_000_000, arch: 'x64', runtimes: ['node'], slots: 2 },
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
    leaseEpoch: 4,
    source: { provider: 'local', uri: 'local://sem-pasta', revision: 'live' },
    runtime: { snapshotDigest: 'host' },
    staging: { uri: 'staging://t1/epoch-4' },
    baseline: { revision: 'live', manifestDigest: 'live' },
    ...over,
  }
}

/** Executor roteirizado: devolve o resultado combinado e conta destroys. */
class ScriptedRuntime implements ContainerRuntime {
  destroyed: string[] = []
  cancelled = 0
  constructor(private readonly result: ExecutionResult) {}
  id(): string {
    return 'scripted'
  }
  async available(): Promise<boolean> {
    return true
  }
  async start(_spec: ExecutionSpec) {
    return {
      wait: async () => this.result,
      cancel: async () => {
        this.cancelled++
      },
    }
  }
  async destroy(taskRunId: string): Promise<void> {
    this.destroyed.push(taskRunId)
  }
}

interface TestBox {
  daemon: WorkerDaemon
  port: number
  token: string
  workRoot: string
  runtime: ScriptedRuntime
}

const boxes: TestBox[] = []

async function up(over: {
  runtime?: ContainerRuntime
  workerId?: string
} = {}): Promise<TestBox> {
  const token = randomUUID() // segredo por teste — nunca um valor fixo no repo
  const workRoot = mkdtempSync(join(tmpdir(), 'aibot2-daemon-'))
  const runtime = (over.runtime ?? new ScriptedRuntime({ ok: true, output: 'saida do bot' })) as ScriptedRuntime
  const daemon = createWorkerDaemon({
    token,
    worker: worker(over.workerId ?? 'pc-02'),
    runtime,
    workRoot,
  })
  const port = await daemon.listen()
  const box = { daemon, port, token, workRoot, runtime }
  boxes.push(box)
  return box
}

afterEach(async () => {
  for (const box of boxes.splice(0, boxes.length)) {
    await box.daemon.close()
    rmSync(box.workRoot, { recursive: true, force: true })
  }
})

async function call(
  box: TestBox,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${box.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token ?? box.token}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** O ciclo completo até o start, reutilizado pelos testes de ponta. */
async function acquireAndStart(box: TestBox): Promise<void> {
  const acquire = await call(box, 'POST', '/task/acquire', {
    taskRunId: 'run-t1-a1',
    taskId: 't1',
    lease: { workerId: 'pc-02', epoch: 4 },
  })
  expect(acquire.status).toBe(200)
  const materialize = await call(box, 'POST', '/workspace/materialize', {
    taskRunId: 'run-t1-a1',
    plan: plan(),
  })
  expect(materialize.status).toBe(200)
  const start = await call(box, 'POST', '/task/start', { taskRunId: 'run-t1-a1', command: ['noop'] })
  expect(start.status).toBe(200)
}

describe('autenticação e superfície', () => {
  it('token errado é 401 em TODAS as rotas — o daemon executa comando da rede', async () => {
    const box = await up()
    for (const [method, path] of [
      ['GET', '/health'],
      ['GET', '/capabilities'],
      ['POST', '/task/acquire'],
      ['POST', '/lease/renew'],
    ] as const) {
      const denied = await call(box, method, path, method === 'POST' ? {} : undefined, 'token-errado')
      expect(denied.status).toBe(401)
    }
  })

  it('sem Docker passthrough: rota fora do contrato é 404 mesmo autenticada', async () => {
    const box = await up()
    for (const path of ['/containers/json', '/images/create', '/docker/exec', '/task/promote']) {
      const denied = await call(box, 'POST', path, {})
      expect(denied.status).toBe(404)
    }
    // E o GET desconhecido idem.
    expect((await call(box, 'GET', '/containers/json')).status).toBe(404)
  })

  it('health e capabilities respondem a identidade real da máquina', async () => {
    const box = await up()
    const health = await call(box, 'GET', '/health')
    expect(health.body).toMatchObject({ ok: true, workerId: 'pc-02', runtime: 'scripted' })
    const capabilities = await call(box, 'GET', '/capabilities')
    expect(capabilities.body['worker']).toMatchObject({
      id: 'pc-02',
      capabilities: { runtimes: ['node'] },
    })
  })
})

describe('o ciclo acquire → prepare → materialize → start → publish → result', () => {
  it('executa, publica na área de espera DA ÉPOCA e para — quem promove é o control plane', async () => {
    const box = await up()
    await acquireAndStart(box)

    const prepare = await call(box, 'POST', '/runtime/prepare', {
      taskRunId: 'run-t1-a1',
      base: 'node-24',
      manifests: [{ name: 'pnpm-lock.yaml', content: 'lockfileVersion: 9' }],
    })
    expect(prepare.status).toBe(200)
    expect((prepare.body['snapshot'] as Record<string, unknown>)['key']).toMatch(/^node-24\//)

    const publish = await call(box, 'POST', '/staging/publish', { taskRunId: 'run-t1-a1' })
    expect(publish.status).toBe(200)
    // A época faz parte do endereço: duas publicações nunca se misturam.
    expect(publish.body['stagingUri']).toBe('staging://t1/epoch-4')
    const staged = readFileSync(join(box.workRoot, 'staging', 't1', 'epoch-4', 'result.txt'), 'utf8')
    expect(staged).toBe('saida do bot')

    const result = await call(box, 'POST', '/task/result', { taskRunId: 'run-t1-a1' })
    expect(result.body).toMatchObject({ state: 'done', ok: true, output: 'saida do bot' })

    // Fim da tarefa destrói a execução: container é EXECUÇÃO, não morada.
    expect(box.runtime.destroyed).toEqual(['run-t1-a1'])
  })

  it('o daemon RELATA e nunca numera: nenhum evento devolvido carrega seq (nem session)', async () => {
    const box = await up()
    await acquireAndStart(box)
    const result = await call(box, 'POST', '/task/result', { taskRunId: 'run-t1-a1' })
    const events = result.body['events'] as Array<Record<string, unknown>>
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event).not.toHaveProperty('seq')
      expect(event).not.toHaveProperty('session')
      expect(event['from']).toMatchObject({ kind: 'worker', id: 'pc-02' })
    }
  })

  it('acquire recusa lease endereçado a OUTRO worker e respeita os slots', async () => {
    const box = await up()
    const alheio = await call(box, 'POST', '/task/acquire', {
      taskRunId: 'run-tx-a1',
      taskId: 'tx',
      lease: { workerId: 'pc-99', epoch: 1 },
    })
    expect(alheio.status).toBe(409)
    expect(String(alheio.body['error'])).toContain('pc-99')

    // 2 slots: a terceira tarefa simultânea é recusada com o motivo.
    for (const n of [1, 2]) {
      const ok = await call(box, 'POST', '/task/acquire', {
        taskRunId: `run-t${n}-a1`,
        taskId: `t${n}`,
        lease: { workerId: 'pc-02', epoch: 1 },
      })
      expect(ok.status).toBe(200)
    }
    const cheio = await call(box, 'POST', '/task/acquire', {
      taskRunId: 'run-t3-a1',
      taskId: 't3',
      lease: { workerId: 'pc-02', epoch: 1 },
    })
    expect(cheio.status).toBe(409)
    expect(String(cheio.body['error'])).toContain('sem slot livre')
  })

  it('materialize confere a tríade do plano na porta: outro worker ou outra época é 409', async () => {
    const box = await up()
    await call(box, 'POST', '/task/acquire', {
      taskRunId: 'run-t1-a1',
      taskId: 't1',
      lease: { workerId: 'pc-02', epoch: 4 },
    })
    const outraEpoca = await call(box, 'POST', '/workspace/materialize', {
      taskRunId: 'run-t1-a1',
      plan: plan({ leaseEpoch: 3 }),
    })
    expect(outraEpoca.status).toBe(409)
    const outroWorker = await call(box, 'POST', '/workspace/materialize', {
      taskRunId: 'run-t1-a1',
      plan: plan({ workerId: 'pc-99' }),
    })
    expect(outroWorker.status).toBe(409)
    // Plano incompleto morre na validação, não dentro do runtime.
    const invalido = await call(box, 'POST', '/workspace/materialize', {
      taskRunId: 'run-t1-a1',
      plan: plan({ baseline: { revision: 'live', manifestDigest: '' } }),
    })
    expect(invalido.status).toBe(400)
  })

  it('start antes de materialize é 409 — a ordem do ciclo é contrato', async () => {
    const box = await up()
    await call(box, 'POST', '/task/acquire', {
      taskRunId: 'run-t1-a1',
      taskId: 't1',
      lease: { workerId: 'pc-02', epoch: 4 },
    })
    const start = await call(box, 'POST', '/task/start', { taskRunId: 'run-t1-a1' })
    expect(start.status).toBe(409)
    expect(String(start.body['error'])).toContain('materialize antes de start')
  })

  it('publicar sem execução terminada é 409: a área de espera só recebe desfecho', async () => {
    const box = await up()
    await call(box, 'POST', '/task/acquire', {
      taskRunId: 'run-t1-a1',
      taskId: 't1',
      lease: { workerId: 'pc-02', epoch: 4 },
    })
    const publish = await call(box, 'POST', '/staging/publish', { taskRunId: 'run-t1-a1' })
    expect(publish.status).toBe(409)
  })
})

describe('lease/renew', () => {
  it('renova na MESMA época; época diferente é recusada (o mundo andou)', async () => {
    const box = await up()
    await call(box, 'POST', '/task/acquire', {
      taskRunId: 'run-t1-a1',
      taskId: 't1',
      lease: { workerId: 'pc-02', epoch: 4 },
    })
    const renovado = await call(box, 'POST', '/lease/renew', {
      taskRunId: 'run-t1-a1',
      lease: { workerId: 'pc-02', epoch: 4 },
    })
    expect(renovado.body).toMatchObject({ renewed: true, epoch: 4 })

    const epocaNova = await call(box, 'POST', '/lease/renew', {
      taskRunId: 'run-t1-a1',
      lease: { workerId: 'pc-02', epoch: 5 },
    })
    expect(epocaNova.status).toBe(409)
    expect(String(epocaNova.body['error'])).toContain('renovação recusada')
  })
})

describe('cancelamento e executor local real', () => {
  it('task/cancel cancela a execução em andamento', async () => {
    const pending = new Promise<ExecutionResult>(() => {
      // nunca resolve: a execução "trava" até o cancel
    })
    let cancels = 0
    const runtime: ContainerRuntime = {
      id: () => 'travado',
      available: async () => true,
      start: async () => ({
        wait: () => pending,
        cancel: async () => {
          cancels++
        },
      }),
      destroy: async () => {},
    }
    const box = await up({ runtime })
    await acquireAndStart(box)
    const cancel = await call(box, 'POST', '/task/cancel', { taskRunId: 'run-t1-a1', reason: 'desisti' })
    expect(cancel.body).toMatchObject({ cancelled: true })
    expect(cancels).toBe(1)
  })

  it('LocalProcessRuntime executa um processo de verdade com a MESMA interface (o seam do Docker)', async () => {
    const runtime = new LocalProcessRuntime()
    const handle = await runtime.start({
      taskRunId: 'run-x-a1',
      plan: plan(),
      localRoot: '',
      command: [process.execPath, '-e', "console.log('ola do processo')"],
    })
    const result = await handle.wait()
    expect(result.ok).toBe(true)
    expect(result.output.trim()).toBe('ola do processo')

    const falha = await runtime.start({
      taskRunId: 'run-y-a1',
      plan: plan(),
      localRoot: '',
      command: [process.execPath, '-e', 'process.exit(3)'],
    })
    expect((await falha.wait()).ok).toBe(false)
    await runtime.destroy('run-x-a1')
  })
})
