/**
 * Bateria do runtime Docker — o dockerode fica atrás do seam DockerEngine e o
 * unit fecha o contrato contra um engine FALSO, porque esta estação não tem
 * engine rodando (fato declarado no plano; a validação com engine real é
 * pendência registrada, nunca fingida). O que os testes fixam:
 *
 * - a criação recebe o HostConfig com os campos EXATOS do hardening §37
 *   (CapDrop ALL, no-new-privileges, tetos de RAM/CPU/PIDs) e NENHUM bind com
 *   cara de socket Docker;
 * - rede é fail-closed: sem requirements.network o container nasce em `none`;
 * - nomes são DERIVADOS de taskRunId validado — id fora da regex é recusado;
 * - ciclo start→wait→cancel→destroy: exit 0 é ok, exit ≠0 é falha com código,
 *   cancel mata, destroy remove à força e o que não foi publicado morre;
 * - detecção honesta: engine mudo → executor local e capabilities SEM docker;
 * - o daemon inteiro continua funcionando com o runtime docker plugado no
 *   MESMO seam (o ciclo dos 9 verbos, com o fake por baixo).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkerRecord } from '@aibot2/domain-workers'
import type { WorkspacePlan } from '@aibot2/domain-workspace'
import {
  DockerContainerRuntime,
  EPOCH_LABEL,
  OWNER_LABEL,
  TASK_RUN_LABEL,
  WORKER_LABEL,
  announceDocker,
  containerNameFor,
  demuxDockerLogs,
  detectContainerRuntime,
  type DockerEngine,
  type EngineContainer,
  type EngineCreateOptions,
  type OwnedContainerRef,
} from './docker-runtime.js'
import { createWorkerDaemon, type WorkerDaemon } from './index.js'

/* ------------------------------------------------------------------------ */
/* O engine falso                                                             */
/* ------------------------------------------------------------------------ */

interface FakeContainerScript {
  /** Código de saída que o wait() reporta (default 0). */
  statusCode?: number
  /** O que logs() devolve. */
  logs?: string
  /** wait() só resolve quando kill() for chamado (encena execução travada). */
  hangUntilKilled?: boolean
}

class FakeContainer implements EngineContainer {
  readonly id: string
  started = 0
  killed = 0
  removed: Array<{ force: boolean }> = []
  #resolveWait: ((code: number) => void) | undefined

  constructor(
    readonly create: EngineCreateOptions,
    private readonly script: FakeContainerScript,
  ) {
    this.id = `ctr-${create.name}`
  }

  async start(): Promise<void> {
    this.started++
  }

  wait(): Promise<{ StatusCode: number }> {
    if (this.script.hangUntilKilled === true) {
      return new Promise((resolve) => {
        this.#resolveWait = (code) => resolve({ StatusCode: code })
      })
    }
    return Promise.resolve({ StatusCode: this.script.statusCode ?? 0 })
  }

  async logs(): Promise<string> {
    return this.script.logs ?? ''
  }

  async kill(): Promise<void> {
    this.killed++
    // Docker de verdade: kill faz o wait() destravar com código ≠ 0.
    this.#resolveWait?.(137)
  }

  async remove(options: { force: boolean }): Promise<void> {
    this.removed.push(options)
  }
}

class FakeEngine implements DockerEngine {
  alive = true
  containers: FakeContainer[] = []
  orphans: Array<{ id: string; labels: Record<string, string>; removed: boolean }> = []
  script: FakeContainerScript = {}

  async ping(): Promise<void> {
    if (!this.alive) throw new Error('engine indisponível')
  }

  async createContainer(options: EngineCreateOptions): Promise<EngineContainer> {
    const container = new FakeContainer(options, this.script)
    this.containers.push(container)
    return container
  }

  async listOwned(): Promise<OwnedContainerRef[]> {
    return this.orphans.map((orphan) => ({
      id: orphan.id,
      labels: orphan.labels,
      remove: async () => {
        orphan.removed = true
      },
    }))
  }
}

/** Engine que nem responde ping — a estação sem Docker. */
class DeadEngine implements DockerEngine {
  async ping(): Promise<void> {
    throw new Error('sem engine nesta estação')
  }
  async createContainer(): Promise<EngineContainer> {
    throw new Error('sem engine nesta estação')
  }
  async listOwned(): Promise<OwnedContainerRef[]> {
    throw new Error('sem engine nesta estação')
  }
}

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
    runtime: { snapshotDigest: 'node-24/19f810' },
    staging: { uri: 'staging://t1/epoch-4' },
    baseline: { revision: 'live', manifestDigest: 'live' },
    ...over,
  }
}

function runtimeWith(engine: DockerEngine): DockerContainerRuntime {
  return new DockerContainerRuntime({
    engine,
    workerId: 'pc-02',
    defaultImage: 'aibot2/node-24:base',
    memoryBytes: 1_073_741_824,
    nanoCpus: 1_000_000_000,
    pidsLimit: 256,
  })
}

const spec = (over: Partial<Parameters<DockerContainerRuntime['start']>[0]> = {}) => ({
  taskRunId: 'run-t1-a1',
  plan: plan(),
  localRoot: 'C:/work/runs/wp-crm-t1-1',
  command: ['node', 'index.js'],
  ...over,
})

describe('hardening §37 — os campos EXATOS na criação', () => {
  it('CapDrop ALL, no-new-privileges, tetos e SEM bind de socket — assertado campo a campo', async () => {
    const engine = new FakeEngine()
    const runtime = runtimeWith(engine)
    await runtime.start(spec({ env: { GOAL: 'crm' } }))

    const create = engine.containers[0]!.create
    // Os campos exatos: um a um, não por matcher frouxo — regressão aqui é
    // rota de fuga do container, não detalhe.
    expect(create.HostConfig.CapDrop).toEqual(['ALL'])
    expect(create.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true'])
    expect(create.HostConfig.Memory).toBe(1_073_741_824)
    expect(create.HostConfig.NanoCpus).toBe(1_000_000_000)
    expect(create.HostConfig.PidsLimit).toBe(256)
    expect(create.HostConfig.RestartPolicy).toEqual({ Name: 'no' })
    // Workspace montado — e é o ÚNICO bind.
    expect(create.HostConfig.Binds).toEqual(['C:/work/runs/wp-crm-t1-1:/workspace'])
    // NENHUM bind com cara de socket, em nenhuma grafia de plataforma.
    for (const bind of create.HostConfig.Binds) {
      expect(bind.toLowerCase()).not.toContain('docker.sock')
      expect(bind.toLowerCase()).not.toContain('docker_engine')
      expect(bind.toLowerCase()).not.toContain('/var/run/docker')
    }
    expect(create.WorkingDir).toBe('/workspace')
    expect(create.Env).toEqual(['GOAL=crm'])
    expect(create.Cmd).toEqual(['node', 'index.js'])
  })

  it('a guarda de construção recusa workspace com cara de socket — cinto e suspensório', async () => {
    const engine = new FakeEngine()
    const runtime = runtimeWith(engine)
    await expect(
      runtime.start(spec({ localRoot: '/var/run/docker.sock' })),
    ).rejects.toThrow(/socket Docker nunca entra/)
    expect(engine.containers).toHaveLength(0)
  })

  it('rede é fail-closed: sem requirements.network nasce em none; declarado usa a rede do runtime', async () => {
    const engine = new FakeEngine()
    const runtime = runtimeWith(engine)
    await runtime.start(spec())
    expect(engine.containers[0]!.create.HostConfig.NetworkMode).toBe('none')

    await runtime.start(spec({ taskRunId: 'run-t2-a1', network: true }))
    expect(engine.containers[1]!.create.HostConfig.NetworkMode).toBe('bridge')
  })

  it('labels carregam o EXECUTION TARGET: posse, taskRun, worker e época do lease', async () => {
    const engine = new FakeEngine()
    const runtime = runtimeWith(engine)
    await runtime.start(spec())
    expect(engine.containers[0]!.create.Labels).toEqual({
      [OWNER_LABEL]: 'true',
      [TASK_RUN_LABEL]: 'run-t1-a1',
      [WORKER_LABEL]: 'pc-02',
      [EPOCH_LABEL]: '4',
    })
  })

  it('sem imagem, sem comando ou sem workspace a criação nem acontece', async () => {
    const engine = new FakeEngine()
    const semImagem = new DockerContainerRuntime({ engine, workerId: 'pc-02' })
    await expect(semImagem.start(spec())).rejects.toThrow(/sem imagem/)
    const runtime = runtimeWith(engine)
    await expect(runtime.start(spec({ command: [] }))).rejects.toThrow(/sem comando/)
    await expect(runtime.start(spec({ localRoot: ' ' }))).rejects.toThrow(/sem workspace/)
    expect(engine.containers).toHaveLength(0)
  })
})

describe('nomes derivados — a fronteira do openbot preservada', () => {
  it('deriva de taskRunId válido e recusa qualquer id fora da regex fechada', () => {
    expect(containerNameFor('run-t1-a1')).toBe('aibot2-run-run-t1-a1')
    // `/`, `..`, `:` e espaço escapariam para outro segmento da API do socket.
    for (const invalido of ['../etc', 'a/b', 'a:b', 'a b', '', '-comeca-com-hifen', 'x'.repeat(65)]) {
      expect(() => containerNameFor(invalido)).toThrow(/taskRunId inválido/)
    }
  })
})

describe('o ciclo da execução efêmera', () => {
  it('exit 0 é ok com os logs; exit ≠ 0 é falha com o código no erro', async () => {
    const engine = new FakeEngine()
    engine.script = { statusCode: 0, logs: 'saida do bot' }
    const runtime = runtimeWith(engine)
    const handle = await runtime.start(spec())
    expect(await handle.wait()).toEqual({ ok: true, output: 'saida do bot' })

    engine.script = { statusCode: 3, logs: 'quebrou' }
    const falha = await runtime.start(spec({ taskRunId: 'run-t2-a1' }))
    const result = await falha.wait()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('código 3')
    expect(result.output).toBe('quebrou')
  })

  it('cancel mata o container e o desfecho sai cancelado, nunca sucesso', async () => {
    const engine = new FakeEngine()
    engine.script = { hangUntilKilled: true }
    const runtime = runtimeWith(engine)
    const handle = await runtime.start(spec())
    await handle.cancel('desisti')
    const result = await handle.wait()
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(engine.containers[0]!.killed).toBe(1)
  })

  it('destroy remove à força — o que não foi publicado morre com o container', async () => {
    const engine = new FakeEngine()
    engine.script = { statusCode: 0 }
    const runtime = runtimeWith(engine)
    await runtime.start(spec())
    await runtime.destroy('run-t1-a1')
    expect(engine.containers[0]!.removed).toEqual([{ force: true }])
    // Destruir de novo (ou o desconhecido) é no-op, nunca erro: o fim da
    // tarefa passa por aqui incondicionalmente.
    await runtime.destroy('run-t1-a1')
    await runtime.destroy('run-nunca-existiu')
    expect(engine.containers[0]!.removed).toHaveLength(1)
  })

  it('a varredura de órfãos só toca containers com o NOSSO label e DESTE worker', async () => {
    const engine = new FakeEngine()
    engine.orphans = [
      // Órfão legítimo: nosso label, nosso worker, TaskRun de um daemon morto.
      { id: 'c1', labels: { [OWNER_LABEL]: 'true', [WORKER_LABEL]: 'pc-02', [TASK_RUN_LABEL]: 'run-velha-a1' }, removed: false },
      // De OUTRO worker: inexistente para nós.
      { id: 'c2', labels: { [OWNER_LABEL]: 'true', [WORKER_LABEL]: 'pc-99', [TASK_RUN_LABEL]: 'run-x-a1' }, removed: false },
      // Sem o label de posse: alheio, mesmo que o nome pareça nosso.
      { id: 'c3', labels: { [WORKER_LABEL]: 'pc-02' }, removed: false },
    ]
    const runtime = runtimeWith(engine)
    const reaped = await runtime.reapOrphans()
    expect(reaped).toEqual(['run-velha-a1'])
    expect(engine.orphans.map((each) => each.removed)).toEqual([true, false, false])
  })

  it('execução VIVA no registro não é órfã — a varredura a poupa', async () => {
    const engine = new FakeEngine()
    engine.script = { hangUntilKilled: true }
    const runtime = runtimeWith(engine)
    const handle = await runtime.start(spec())
    engine.orphans = [
      { id: 'c1', labels: { [OWNER_LABEL]: 'true', [WORKER_LABEL]: 'pc-02', [TASK_RUN_LABEL]: 'run-t1-a1' }, removed: false },
    ]
    expect(await runtime.reapOrphans()).toEqual([])
    expect(engine.orphans[0]!.removed).toBe(false)
    await handle.cancel()
  })
})

describe('detecção honesta de engine', () => {
  it('engine mudo → executor local e capabilities SEM docker (o campo nem existe)', async () => {
    const detected = await detectContainerRuntime({ workerId: 'pc-02', engine: new DeadEngine() })
    expect(detected.docker).toBe(false)
    expect(detected.runtime.id()).toBe('local-process')

    const announced = announceDocker(worker(), detected.docker)
    // NUNCA finge: nem true, nem false — ausência é o retrato exato.
    expect('docker' in announced.capabilities).toBe(false)
  })

  it('engine respondendo → runtime docker e capabilities com docker: true', async () => {
    const engine = new FakeEngine()
    const detected = await detectContainerRuntime({ workerId: 'pc-02', engine })
    expect(detected.docker).toBe(true)
    expect(detected.runtime.id()).toBe('docker')
    expect(announceDocker(worker(), true).capabilities.docker).toBe(true)
  })

  it('a detecção REAL desta estação é consistente consigo mesma (sem engine aqui: pendência declarada)', async () => {
    // Sem engine fixado: usa o dockerode de verdade. Nesta estação não há
    // engine rodando (fato do plano) — mas o teste não FIXA isso: ele fixa a
    // coerência, para continuar verde no dia em que um engine existir.
    const detected = await detectContainerRuntime({
      workerId: 'pc-02',
      runtimeOptions: { pingTimeoutMs: 1_500 },
    })
    expect(typeof detected.docker).toBe('boolean')
    expect(detected.runtime.id()).toBe(detected.docker ? 'docker' : 'local-process')
  }, 15_000)
})

describe('demux dos logs do Docker', () => {
  it('desmonta quadros multiplexados e deixa texto puro (TTY) passar intacto', () => {
    // Dois quadros: stdout "ola " + stderr "erro".
    const frame = (stream: number, text: string): Buffer => {
      const payload = Buffer.from(text, 'utf8')
      const header = Buffer.alloc(8)
      header.writeUInt8(stream, 0)
      header.writeUInt32BE(payload.length, 4)
      return Buffer.concat([header, payload])
    }
    expect(demuxDockerLogs(Buffer.concat([frame(1, 'ola '), frame(2, 'erro')]))).toBe('ola erro')
    expect(demuxDockerLogs(Buffer.from('texto puro de tty', 'utf8'))).toBe('texto puro de tty')
    expect(demuxDockerLogs(Buffer.alloc(0))).toBe('')
  })
})

/* ------------------------------------------------------------------------ */
/* O daemon inteiro com o runtime docker plugado no MESMO seam                */
/* ------------------------------------------------------------------------ */

describe('daemon + runtime docker (fake por baixo): o ciclo dos 9 verbos', () => {
  const daemons: Array<{ daemon: WorkerDaemon; workRoot: string }> = []

  afterEach(async () => {
    for (const box of daemons.splice(0, daemons.length)) {
      await box.daemon.close()
      rmSync(box.workRoot, { recursive: true, force: true })
    }
  })

  it('acquire → materialize → start (com image/network do corpo) → result destrói o container', async () => {
    const engine = new FakeEngine()
    engine.script = { statusCode: 0, logs: 'feito no container' }
    const runtime = runtimeWith(engine)
    const token = randomUUID()
    const workRoot = mkdtempSync(join(tmpdir(), 'aibot2-docker-daemon-'))
    const daemon = createWorkerDaemon({ token, worker: worker(), runtime, workRoot })
    const port = await daemon.listen()
    daemons.push({ daemon, workRoot })

    const call = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return (await response.json()) as Record<string, unknown>
    }

    await call('/task/acquire', {
      taskRunId: 'run-t1-a1',
      taskId: 't1',
      lease: { workerId: 'pc-02', epoch: 4 },
    })
    await call('/workspace/materialize', { taskRunId: 'run-t1-a1', plan: plan() })
    const started = await call('/task/start', {
      taskRunId: 'run-t1-a1',
      command: ['node', 'index.js'],
      image: 'aibot2/python-3.12:8ac927',
      network: true,
    })
    expect(started).toMatchObject({ started: true })

    // O corpo do start decidiu imagem e rede — e o container recebeu ambos.
    const create = engine.containers[0]!.create
    expect(create.Image).toBe('aibot2/python-3.12:8ac927')
    expect(create.HostConfig.NetworkMode).toBe('bridge')

    // O desfecho chega e o fim da tarefa DESTRÓI o container (efêmero).
    const deadline = Date.now() + 5_000
    let result: Record<string, unknown> = {}
    while (Date.now() < deadline) {
      result = await call('/task/result', { taskRunId: 'run-t1-a1' })
      if (result['state'] === 'done') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(result).toMatchObject({ state: 'done', ok: true, output: 'feito no container' })
    expect(engine.containers[0]!.removed).toEqual([{ force: true }])
  })
})
