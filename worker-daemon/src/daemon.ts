/**
 * O worker-daemon: o esqueleto do daemon do PC físico sobre node:http, com os
 * verbos da spec §36.
 *
 * O daemon é o componente mais SENSÍVEL do sistema — ele executa comando que
 * chega pela rede, e isso é a função dele, não efeito colateral. As defesas
 * do desenho estão todas aqui:
 *
 * - **Token do enrolamento.** Um PC não entra no pool por se anunciar: alguém
 *   aprova a máquina e ela recebe um token PRÓPRIO. O valor chega por config
 *   na subida (cofre → env do processo); NUNCA mora no código nem no repo —
 *   segredos vão para o cofre da casa (AWS Secrets Manager/Passbolt em DEV,
 *   Vaultwarden nos demais). A comparação é em tempo constante.
 * - **O daemon não decide nada.** Recebe comando JÁ aprovado pelo portão do
 *   orquestrador; duplicar a decisão aqui criaria duas políticas divergentes.
 * - **Reporta, nunca grava seq.** Os eventos saem como relato SEM número — o
 *   sequenciador é do server (D1); um daemon que numerasse criaria duas
 *   verdades para a mesma sessão.
 * - **Publica e PARA.** /staging/publish escreve na área de espera da época e
 *   nada mais: não promove, não apaga, não decide. Quem confere a época e
 *   promove é o control plane (a cerca do domain/workspace).
 * - **Sem Docker passthrough.** Rota desconhecida é 404; o Docker, quando
 *   aprovado, entra pelo seam ContainerRuntime — jamais como proxy de socket.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { snapshotFingerprint, type ManifestFile } from '@aibot2/domain-runtime'
import type { WorkerRecord } from '@aibot2/domain-workers'
import { stagingUri, validatePlan, type WorkspacePlan } from '@aibot2/domain-workspace'
import type { ContainerRuntime, ExecutionHandle, ExecutionResult } from './runtime.js'

/**
 * Um evento RELATADO pelo daemon — a forma do EnvelopeInput do protocolo,
 * deliberadamente SEM `seq` e sem `session`: quem numera e endereça é o
 * sequenciador do server, na chegada do relato.
 */
export interface ReportedEvent {
  id: string
  ts: string
  kind: string
  from: { kind: string; id: string }
  payload?: unknown
}

/** O lease como o despacho o entregou ao daemon. */
export interface AssignedLease {
  workerId: string
  epoch: number
}

interface Assignment {
  taskRunId: string
  taskId: string
  lease: AssignedLease
  leaseExpiresAtMs: number
  plan?: WorkspacePlan
  localRoot?: string
  handle?: ExecutionHandle
  result?: ExecutionResult
  published?: string
  events: ReportedEvent[]
  counter: number
}

export interface WorkerDaemonConfig {
  /** O token do enrolamento — injetado na subida (cofre/env), nunca hardcoded. */
  token: string
  worker: WorkerRecord
  runtime: ContainerRuntime
  /** Onde materializar workspaces e staging nesta máquina. */
  workRoot?: string
  /** TTL do lease que o daemon assume quando o acquire não informa um. */
  leaseTtlMs?: number
  now?: () => number
}

export interface WorkerDaemon {
  server: Server
  /** Sobe em 127.0.0.1 (o M1 é loopback por decisão) e devolve a porta. */
  listen(port?: number): Promise<number>
  close(): Promise<void>
}

const DEFAULT_LEASE_TTL_MS = 3 * 60 * 1000

export function createWorkerDaemon(config: WorkerDaemonConfig): WorkerDaemon {
  if (config.token.trim() === '') {
    // Sem token não há enrolamento — subir aberto seria executar comando de
    // qualquer origem da rede.
    throw new Error('worker-daemon exige token de enrolamento')
  }
  const now = config.now ?? Date.now
  const workRoot = config.workRoot ?? join(tmpdir(), 'aibot2-daemon')
  const leaseTtl = config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const assignments = new Map<string, Assignment>()
  const startedAt = now()

  const tokenBuffer = Buffer.from(config.token, 'utf8')
  function authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? ''
    const value = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    const candidate = Buffer.from(value, 'utf8')
    // timingSafeEqual exige comprimentos iguais; comprimentos diferentes já
    // são recusa — comparar antes não vaza mais que o próprio 401.
    return candidate.length === tokenBuffer.length && timingSafeEqual(candidate, tokenBuffer)
  }

  function report(assignment: Assignment, kind: string, payload: unknown): void {
    assignment.counter++
    assignment.events.push({
      id: `wd-${assignment.taskRunId}-${assignment.counter}`,
      ts: new Date(now()).toISOString(),
      kind,
      from: { kind: 'worker', id: config.worker.id },
      payload,
    })
  }

  function json(response: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(data)
  }

  async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > 1_048_576) {
        throw new Error('corpo maior que 1MiB')
      }
      chunks.push(chunk as Buffer)
    }
    if (chunks.length === 0) return {}
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('corpo não é um objeto JSON')
    }
    return parsed as Record<string, unknown>
  }

  function assignmentOf(
    body: Record<string, unknown>,
    response: ServerResponse,
  ): Assignment | undefined {
    const taskRunId = typeof body['taskRunId'] === 'string' ? body['taskRunId'] : ''
    const assignment = assignments.get(taskRunId)
    if (assignment === undefined) {
      json(response, 404, { error: `taskRun desconhecida: ${taskRunId}` })
      return undefined
    }
    return assignment
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request)) {
      json(response, 401, { error: 'token de enrolamento ausente ou inválido' })
      return
    }
    const route = `${request.method} ${request.url ?? ''}`

    if (route === 'GET /health') {
      json(response, 200, {
        ok: true,
        workerId: config.worker.id,
        runtime: config.runtime.id(),
        busy: [...assignments.values()].filter((each) => each.handle !== undefined && each.result === undefined).length,
        uptimeMs: now() - startedAt,
      })
      return
    }

    if (route === 'GET /capabilities') {
      json(response, 200, { worker: config.worker })
      return
    }

    if (request.method !== 'POST') {
      json(response, 404, { error: 'rota desconhecida' })
      return
    }

    let body: Record<string, unknown>
    try {
      body = await readBody(request)
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    switch (request.url) {
      case '/task/acquire': {
        const taskRunId = typeof body['taskRunId'] === 'string' ? body['taskRunId'] : ''
        const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : ''
        const lease = body['lease'] as AssignedLease | undefined
        if (taskRunId === '' || taskId === '' || lease === undefined) {
          json(response, 400, { error: 'acquire exige taskRunId, taskId e lease' })
          return
        }
        // O lease do despacho tem de ser para ESTA máquina: aceitar tarefa
        // endereçada a outro worker quebraria a cerca antes de ela existir.
        if (lease.workerId !== config.worker.id) {
          json(response, 409, {
            error: `o lease é de ${lease.workerId}, este daemon é ${config.worker.id}`,
          })
          return
        }
        const slots = config.worker.capabilities.slots ?? 1
        const busy = [...assignments.values()].filter((each) => each.result === undefined).length
        if (busy >= slots) {
          json(response, 409, { error: `sem slot livre (${busy}/${slots})` })
          return
        }
        const assignment: Assignment = {
          taskRunId,
          taskId,
          lease,
          leaseExpiresAtMs: now() + leaseTtl,
          events: [],
          counter: 0,
        }
        assignments.set(taskRunId, assignment)
        report(assignment, 'task.progress', { taskId, taskRunId, note: 'aceita pelo daemon' })
        json(response, 200, { accepted: true, workerId: config.worker.id })
        return
      }

      case '/runtime/prepare': {
        const assignment = assignmentOf(body, response)
        if (assignment === undefined) return
        const base = typeof body['base'] === 'string' ? body['base'] : ''
        const manifests = Array.isArray(body['manifests'])
          ? (body['manifests'] as ManifestFile[])
          : []
        try {
          const key = snapshotFingerprint(base, manifests)
          report(assignment, 'task.progress', {
            taskId: assignment.taskId,
            taskRunId: assignment.taskRunId,
            note: `runtime preparado: ${key.key}`,
          })
          json(response, 200, { snapshot: key })
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      case '/workspace/materialize': {
        const assignment = assignmentOf(body, response)
        if (assignment === undefined) return
        const plan = body['plan'] as WorkspacePlan | undefined
        if (plan === undefined) {
          json(response, 400, { error: 'materialize exige o plano congelado' })
          return
        }
        try {
          validatePlan(plan)
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        // O plano congelou worker+época; um plano de outro worker ou de outra
        // época não materializa AQUI — é a mesma tríade da cerca, na porta.
        if (plan.workerId !== config.worker.id || plan.leaseEpoch !== assignment.lease.epoch) {
          json(response, 409, {
            error: `o plano é de ${plan.workerId}/época ${plan.leaseEpoch}; o lease deste daemon é ${config.worker.id}/época ${assignment.lease.epoch}`,
          })
          return
        }
        // O caminho FÍSICO nasce aqui, dentro do worker — o plano nunca o
        // carregou (spec §21) e a resposta também não o devolve ao control
        // plane: onde cada PC monta as coisas é assunto do PC.
        const localRoot = join(workRoot, 'runs', plan.id)
        mkdirSync(localRoot, { recursive: true })
        assignment.plan = plan
        assignment.localRoot = localRoot
        report(assignment, 'task.progress', {
          taskId: assignment.taskId,
          taskRunId: assignment.taskRunId,
          note: 'workspace materializado',
        })
        json(response, 200, { materialized: true })
        return
      }

      case '/task/start': {
        const assignment = assignmentOf(body, response)
        if (assignment === undefined) return
        if (assignment.plan === undefined || assignment.localRoot === undefined) {
          json(response, 409, { error: 'materialize antes de start' })
          return
        }
        const command = Array.isArray(body['command'])
          ? (body['command'] as string[])
          : []
        // Imagem e rede chegam DECIDIDAS pelo control plane (a rede veio dos
        // requirements da tarefa); o daemon repassa, nunca decide — os campos
        // só existem no spec quando vieram, para o runtime aplicar o
        // fail-closed dele (sem network declarado = sem rede).
        const image = typeof body['image'] === 'string' ? body['image'] : undefined
        const network = typeof body['network'] === 'boolean' ? body['network'] : undefined
        try {
          const handleStarted = await config.runtime.start({
            taskRunId: assignment.taskRunId,
            plan: assignment.plan,
            localRoot: assignment.localRoot,
            command,
            ...(image !== undefined ? { image } : {}),
            ...(network !== undefined ? { network } : {}),
          })
          assignment.handle = handleStarted
          report(assignment, 'task.progress', {
            taskId: assignment.taskId,
            taskRunId: assignment.taskRunId,
            note: 'execução iniciada',
          })
          // O desfecho é observado em segundo plano e RELATADO — o control
          // plane o coleta em /task/result quando quiser.
          void handleStarted.wait().then((result) => {
            assignment.result = result
            report(assignment, 'worker.done', {
              taskId: assignment.taskId,
              workerId: config.worker.id,
              ok: result.ok,
              ...(result.ok ? { result: result.output } : { error: result.error ?? 'falhou' }),
            })
          })
          json(response, 200, { started: true })
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      case '/task/cancel': {
        const assignment = assignmentOf(body, response)
        if (assignment === undefined) return
        if (assignment.handle !== undefined) {
          await assignment.handle.cancel(
            typeof body['reason'] === 'string' ? body['reason'] : 'cancelada',
          )
        }
        json(response, 200, { cancelled: true })
        return
      }

      case '/staging/publish': {
        const assignment = assignmentOf(body, response)
        if (assignment === undefined) return
        if (assignment.result === undefined) {
          json(response, 409, { error: 'nada a publicar: a execução não terminou' })
          return
        }
        // Publica na área de espera DA ÉPOCA e PARA: não promove, não apaga,
        // não decide. Duas publicações da mesma tarefa nunca se misturam
        // porque a época faz parte do endereço.
        const uri = stagingUri(assignment.taskId, assignment.lease.epoch)
        const stagingDir = join(
          workRoot,
          'staging',
          assignment.taskId,
          `epoch-${assignment.lease.epoch}`,
        )
        mkdirSync(stagingDir, { recursive: true })
        writeFileSync(join(stagingDir, 'result.txt'), assignment.result.output, 'utf8')
        assignment.published = uri
        report(assignment, 'task.progress', {
          taskId: assignment.taskId,
          taskRunId: assignment.taskRunId,
          note: `publicado em ${uri}`,
        })
        json(response, 200, { stagingUri: uri })
        return
      }

      case '/task/result': {
        const assignment = assignmentOf(body, response)
        if (assignment === undefined) return
        const events = assignment.events.splice(0, assignment.events.length)
        if (assignment.result === undefined) {
          json(response, 200, { state: 'running', events })
          return
        }
        // Fim da tarefa destrói a execução (container efêmero): o que não foi
        // publicado morre com ela.
        await config.runtime.destroy(assignment.taskRunId)
        assignments.delete(assignment.taskRunId)
        json(response, 200, {
          state: 'done',
          ok: assignment.result.ok,
          output: assignment.result.output,
          ...(assignment.result.error !== undefined ? { error: assignment.result.error } : {}),
          ...(assignment.published !== undefined ? { stagingUri: assignment.published } : {}),
          events,
        })
        return
      }

      case '/lease/renew': {
        const assignment = assignmentOf(body, response)
        if (assignment === undefined) return
        const lease = body['lease'] as AssignedLease | undefined
        if (lease === undefined) {
          json(response, 400, { error: 'renew exige o lease' })
          return
        }
        // Renovar é do MESMO dono na MESMA época; época diferente significa
        // que o mundo andou — este daemon não é mais (ou nunca foi) o dono.
        if (lease.workerId !== assignment.lease.workerId || lease.epoch !== assignment.lease.epoch) {
          json(response, 409, {
            error: `época ${lease.epoch} não é a deste daemon (${assignment.lease.epoch}) — renovação recusada`,
          })
          return
        }
        assignment.leaseExpiresAtMs = now() + leaseTtl
        json(response, 200, { renewed: true, epoch: assignment.lease.epoch })
        return
      }

      default:
        // Nenhuma rota além do contrato — em especial, NENHUM passthrough de
        // Docker: /containers/*, /images/*, /docker/* morrem aqui.
        json(response, 404, { error: 'rota desconhecida' })
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  return {
    server,
    listen(port = 0): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        // 127.0.0.1 de propósito: o M1 é loopback (a nota de escopo do E7);
        // expor na rede é decisão do M2, junto com o enrolamento completo.
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          resolve(typeof address === 'object' && address !== null ? address.port : port)
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}
