/**
 * O seam ContainerRuntime: a INTERFACE da execução efêmera.
 *
 * A regra do cluster é "worker é computador, CONTAINER É EXECUÇÃO" (R8): a
 * execução nasce para a tarefa e morre com o estrago dentro; o resultado só
 * existe se publicado e promovido. O Docker (dockerode, aprovado em M11)
 * implementa EXATAMENTE esta interface em docker-runtime.ts — o daemon não
 * mudou uma linha, que era o propósito do seam. O executor local em processo
 * continua cumprindo o contrato quando não há engine (detecção honesta em
 * detectContainerRuntime — a nota de escopo do M1: loopback primeiro,
 * multi-PC é deploy, não redesign).
 */

import { spawn } from 'node:child_process'
import type { WorkspacePlan } from '@aibot2/domain-workspace'

/** O que a execução recebe — tudo decidido pelo control plane, nada a resolver. */
export interface ExecutionSpec {
  taskRunId: string
  plan: WorkspacePlan
  /** O root local materializado NESTA máquina (nunca veio no plano). */
  localRoot: string
  /** O comando a executar — vetor já aprovado pelo control plane. */
  command: string[]
  env?: Record<string, string>
  /** A imagem da execução no runtime docker (o executor local a ignora). */
  image?: string
  /**
   * A tarefa declarou requirements.network? A decisão vem PRONTA do control
   * plane — sem declaração, a execução docker nasce SEM rede (fail-closed).
   */
  network?: boolean
}

export interface ExecutionResult {
  ok: boolean
  output: string
  error?: string
  cancelled?: boolean
}

/** A execução em andamento. */
export interface ExecutionHandle {
  wait(): Promise<ExecutionResult>
  cancel(reason?: string): Promise<void>
}

/** O contrato que o Docker implementará por igual. */
export interface ContainerRuntime {
  /** Identifica o backend ("local-process", "docker"...). */
  id(): string
  available(): Promise<boolean>
  start(spec: ExecutionSpec): Promise<ExecutionHandle>
  /**
   * Destrói a execução da TaskRun — o fim da tarefa SEMPRE passa por aqui
   * (container efêmero: o que não foi publicado morre junto).
   */
  destroy(taskRunId: string): Promise<void>
}

/**
 * O executor local: um processo filho por TaskRun, cwd no workspace
 * materializado. Sem shell (shell:false) — o comando chega como vetor já
 * decidido e aprovado pelo control plane; passar por um shell reabriria
 * injeção por concatenação exatamente onde o daemon é mais sensível (comando
 * que chega pela rede).
 */
export class LocalProcessRuntime implements ContainerRuntime {
  readonly #running = new Map<string, ExecutionHandle>()

  id(): string {
    return 'local-process'
  }

  async available(): Promise<boolean> {
    return true
  }

  async start(spec: ExecutionSpec): Promise<ExecutionHandle> {
    const [command, ...args] = spec.command
    if (command === undefined || command === '') {
      throw new Error('execução local sem comando')
    }
    const child = spawn(command, args, {
      cwd: spec.localRoot === '' ? undefined : spec.localRoot,
      env: { ...process.env, ...spec.env },
      shell: false,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let cancelled = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const finished = new Promise<ExecutionResult>((resolve) => {
      child.on('error', (error) => {
        resolve({ ok: false, output: stdout, error: error.message })
      })
      child.on('close', (code) => {
        if (cancelled) {
          resolve({ ok: false, output: stdout, error: 'cancelado', cancelled: true })
          return
        }
        if (code === 0) {
          resolve({ ok: true, output: stdout })
        } else {
          resolve({
            ok: false,
            output: stdout,
            error: stderr.trim() !== '' ? stderr.trim() : `processo saiu com código ${code}`,
          })
        }
      })
    })

    const handle: ExecutionHandle = {
      wait: () => finished,
      cancel: async () => {
        cancelled = true
        child.kill()
      },
    }
    this.#running.set(spec.taskRunId, handle)
    return handle
  }

  async destroy(taskRunId: string): Promise<void> {
    const handle = this.#running.get(taskRunId)
    if (handle !== undefined) {
      await handle.cancel('destruída')
      this.#running.delete(taskRunId)
    }
  }
}
