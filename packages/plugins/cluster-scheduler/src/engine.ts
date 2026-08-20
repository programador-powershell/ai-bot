/**
 * O motor de ondas — porte do runCrew/runWorker do crew.go do oráculo, com as
 * residências novas do E7:
 *
 * - os TETOS moram na política resolvida e o DÉBITO no store durável por Goal
 *   (GoalBudget sobre o TaskJournal) — reinício não zera, sub-equipe herda;
 * - o worker de cada tarefa é ESCOLHIDO pelo scheduler (§28) a partir dos
 *   requirements declarados — nunca nomeado pela decisão do modelo;
 * - o plano de workspace é congelado UMA vez, antes do despacho, e é ESTE
 *   plano que a execução usa e promove — worker que perdeu o lease pode até
 *   terminar, mas não vira verdade (a cerca vira task.conflict no journal);
 * - recusa é FALHA (refusal conservador), escalação NÃO é (conta no portão e
 *   não em failures) — as duas contagens alimentam perguntas diferentes;
 * - refazer refaz SÓ quem não produziu resultado (retry debita unfinished).
 *
 * O laço modelo↔ferramenta de cada trabalhador é da E6 (agent loop) e entra
 * pelo seam TaskExecutor: este motor decide O QUE roda ONDE e o que vira
 * verdade — não COMO o modelo conversa.
 */

import type { StorageDriver } from '@aibot2/domain-events'
import { resolveCeilings, type CrewCeilings } from '@aibot2/domain-goals'
import {
  CONCURRENCY_CEIL,
  GoalBudget,
  ReadinessTracker,
  TaskJournal,
  escalation,
  gateReason,
  makeTaskRunId,
  planTasks,
  refusal,
  type PlanOptions,
  type TaskSpec,
} from '@aibot2/domain-tasks'
import { LeaseHeldError, type Fleet, type WorkerRecord } from '@aibot2/domain-workers'
import {
  StaleWorkspaceError,
  type WorkspaceManager,
  type WorkspacePlan,
} from '@aibot2/domain-workspace'
import { chooseWorker, type ChooseOptions } from './choose.js'

/** Quantas vezes uma onda pode ser executada — a primeira mais os "refazer"
 * do portão. Sem teto, um modelo que responde retry toda vez prende a equipe
 * num laço que só o cancelamento interrompe. */
export const MAX_WAVE_ATTEMPTS = 3

export type GateDecision = 'proceed' | 'retry' | 'abort'

/** O que o portão recebe para decidir. */
export interface GatePrompt {
  wave: number
  failures: number
  escalations: number
  reason: string
}

/** A execução que o seam recebe — tudo decidido, nada a resolver. */
export interface TaskAssignment {
  task: TaskSpec
  /** LÓGICO, com tentativa — nunca o nome da máquina (D2). */
  taskRunId: string
  attempt: number
  wave: number
  /** O PC escolhido pelo scheduler, ao LADO do id lógico. */
  worker: WorkerRecord
  /** O plano congelado no despacho — a execução roda DENTRO dele. */
  plan: WorkspacePlan
  /** Resultado das tarefas de que esta depende. */
  upstream: Record<string, string>
}

/**
 * Executa a TaskRun e devolve o texto final do trabalhador. O motor aplica
 * escalação/recusa/vazio e a cerca de promoção sobre esse texto — o executor
 * não decide desfecho.
 */
export interface TaskExecutor {
  run(assignment: TaskAssignment): Promise<string>
}

/** O desfecho de uma tarefa na onda. */
export interface TaskOutcome {
  taskId: string
  taskRunId?: string
  ok: boolean
  result?: string
  error?: string
  escalated?: boolean
  /** Ficou na fila (sem worker compatível) — com o motivo do scheduler. */
  queued?: boolean
}

export interface CrewReport {
  report: string
  outcomes: TaskOutcome[]
  results: Record<string, string>
  aborted: boolean
}

export interface CrewEngineOptions {
  store: StorageDriver
  goalId: string
  fleet: Fleet
  workspaces: WorkspaceManager
  executor: TaskExecutor
  ceilings?: Partial<CrewCeilings>
  /**
   * O portão entre ondas. Ausente = proceed imediato (o prazo de 2 minutos do
   * oráculo é responsabilidade do chamador com timer de verdade — um default
   * que espera relógio tornaria o motor intestável).
   */
  decideGate?: (gate: GatePrompt) => Promise<GateDecision>
  planOptions?: PlanOptions
  chooseOptions?: ChooseOptions
  /** Insumos que já existem antes de qualquer tarefa (readiness dinâmica). */
  seedInputs?: string[]
}

export interface CrewRequest {
  sessionId: string
  tasks: TaskSpec[]
  maxConcurrency?: number
  /** O nível desta equipe na árvore (0 = raiz). Sub-equipes chamam com +1. */
  depth?: number
}

export class CrewEngine {
  readonly #options: CrewEngineOptions
  readonly #journal: TaskJournal
  readonly #ceilings: CrewCeilings

  constructor(options: CrewEngineOptions) {
    this.#options = options
    this.#journal = new TaskJournal(options.store, options.goalId)
    this.#ceilings = resolveCeilings(options.ceilings, CONCURRENCY_CEIL)
  }

  /** O journal deste Goal — exposto para inspeção e testes de retomada. */
  get journal(): TaskJournal {
    return this.#journal
  }

  async run(request: CrewRequest): Promise<CrewReport> {
    const depth = request.depth ?? 0
    // A profundidade é conferida ANTES de validar o plano: recusar a geração
    // seguinte custa uma frase; montá-la custa até 128 modelos.
    if (depth >= this.#ceilings.maxDepth) {
      throw new Error(
        `esta equipe já está no nível ${depth + 1} e o teto da política é ${this.#ceilings.maxDepth} — ` +
          'execute estas tarefas você mesmo em vez de montar mais uma equipe',
      )
    }

    let maxConcurrency = request.maxConcurrency ?? 0
    if (maxConcurrency <= 0 || maxConcurrency > this.#ceilings.maxChildren) {
      maxConcurrency = this.#ceilings.maxChildren
    }

    // O erro de plano volta como exceção com a MENSAGEM do validador: o modelo
    // precisa ler "t3 depende de t9, que não existe" para corrigir o grafo.
    const plan = planTasks(request.tasks, maxConcurrency, this.#options.planOptions ?? {})

    // O orçamento é debitado DEPOIS do plano e ANTES da execução: plano
    // inválido não gasta cota; plano válido não roda para descobrir que não
    // cabia. O débito é durável por Goal — reinício não o zera.
    const budget = new GoalBudget(this.#journal, this.#ceilings)
    await budget.take(request.tasks.length)

    await this.#journal.open()
    const tracker = new ReadinessTracker(request.tasks, this.#options.seedInputs ?? [])
    const byId = new Map(request.tasks.map((task) => [task.id, task]))
    const attempts = new Map<string, number>()
    const results: Record<string, string> = {}
    const allOutcomes: TaskOutcome[] = []

    const lines: string[] = []
    lines.push(
      `plano: ${request.tasks.length} tarefas em ${plan.waves.length} ondas (paralelismo ${plan.maxParallelism})`,
    )
    for (const warning of plan.warnings) {
      lines.push(`aviso: ${warning}`)
    }

    // Nascimento durável de cada tarefa (idempotente na retomada: quem já
    // tem estado no journal não nasce de novo).
    for (const task of request.tasks) {
      if (this.#journal.stateOf(task.id) === undefined) {
        await this.#journal.record({ state: 'task.created', taskId: task.id })
      }
    }

    for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex++) {
      let pending = plan.waves[waveIndex]!

      for (let attempt = 1; ; attempt++) {
        // Readiness DINÂMICA, decidida numa FOTO no início da tentativa: as
        // tarefas da onda rodam em paralelo, e consultar o tracker no meio da
        // corrida faria a mesma onda ora despachar ora enfileirar a mesma
        // tarefa conforme quem terminasse primeiro — não-determinismo que a
        // pessoa lê como defeito intermitente. A foto é estável; o que ficou
        // de fora entra na tentativa seguinte, quando o insumo já existe.
        const queueReasons = new Map<string, string | undefined>()
        for (const taskId of pending) {
          const task = byId.get(taskId)
          if (task === undefined) continue
          if (tracker.isReady(taskId)) {
            queueReasons.set(taskId, undefined)
            continue
          }
          const missing = (task.needs ?? []).filter((need) => !tracker.hasInput(need))
          queueReasons.set(
            taskId,
            missing.length > 0
              ? `aguardando insumo obrigatório: ${missing.join(', ')}`
              : 'aguardando dependências',
          )
        }

        const outcomes: TaskOutcome[] = []
        await Promise.all(
          pending.map(async (taskId) => {
            const task = byId.get(taskId)
            if (task === undefined) return
            const tryNumber = (attempts.get(taskId) ?? 0) + 1
            attempts.set(taskId, tryNumber)
            const outcome = await this.#runOne(
              task,
              tryNumber,
              waveIndex + 1,
              tracker,
              results,
              queueReasons.get(taskId),
            )
            outcomes.push(outcome)
            if (outcome.taskRunId !== undefined) {
              // A reserva virou gasto real: o despacho está no journal e o
              // replay passa a contá-lo.
              budget.confirmDispatch()
            } else {
              // Nada foi despachado (fila, lease alheio, congelamento falhou):
              // a reserva volta — contar duas vezes negaria refações válidas.
              budget.releaseReservation(1)
            }
          }),
        )
        // Ordem estável no relatório: a de declaração da onda, não a de término.
        outcomes.sort((a, b) => pending.indexOf(a.taskId) - pending.indexOf(b.taskId))
        allOutcomes.push(...outcomes)

        // Duas contagens, porque as duas perguntas são diferentes: failures é
        // quem ERROU; escalations é quem PAROU PARA PERGUNTAR. Nenhuma das
        // duas produziu resultado, e é a SOMA que decide o portão.
        let failures = 0
        let escalations = 0
        const unfinished: string[] = []
        for (const outcome of outcomes) {
          if (outcome.ok) {
            results[outcome.taskId] = outcome.result ?? ''
            lines.push(`✓ ${outcome.taskId}: ${truncate(outcome.result ?? '', 400)}`)
            continue
          }
          unfinished.push(outcome.taskId)
          if (outcome.escalated === true) {
            escalations++
            lines.push(`↑ ${outcome.taskId} (escalou e espera resposta): ${outcome.error ?? ''}`)
            continue
          }
          failures++
          if (outcome.queued === true) {
            lines.push(`✗ ${outcome.taskId} (fila): ${outcome.error ?? ''}`)
          } else {
            lines.push(`✗ ${outcome.taskId}: ${outcome.error ?? ''}`)
          }
        }

        // Portão entre ondas: a onda que deixou tarefa SEM RESULTADO não segue
        // em silêncio — as seguintes dependem do que ela deveria ter produzido.
        if (failures + escalations === 0 || waveIndex + 1 >= plan.waves.length) {
          break
        }

        const decision = await this.#gate(waveIndex + 1, failures, escalations)
        lines.push(`portão da onda ${waveIndex + 1}: ${decision}`)
        if (decision === 'abort') {
          lines.push('execução abortada no portão')
          return { report: lines.join('\n'), outcomes: allOutcomes, results, aborted: true }
        }
        if (decision !== 'retry') {
          break
        }
        if (attempt >= MAX_WAVE_ATTEMPTS) {
          lines.push(
            `refazer pedido ${attempt} vez(es) na onda ${waveIndex + 1} — seguindo com o que há`,
          )
          break
        }
        // Só quem NÃO produziu resultado volta à fila: reexecutar quem deu
        // certo gastaria modelo de novo e repetiria efeito colateral já
        // aplicado — um commit, um arquivo escrito, uma mensagem enviada.
        try {
          await budget.take(unfinished.length)
        } catch (error) {
          lines.push(`refazer negado: ${error instanceof Error ? error.message : String(error)}`)
          break
        }
        pending = unfinished
        lines.push(
          `refazendo ${pending.length} tarefa(s) da onda ${waveIndex + 1} (tentativa ${attempt + 1})`,
        )
      }
    }

    return { report: lines.join('\n'), outcomes: allOutcomes, results, aborted: false }
  }

  /* ----------------------------- uma tarefa ------------------------------ */

  async #runOne(
    task: TaskSpec,
    attempt: number,
    wave: number,
    tracker: ReadinessTracker,
    results: Record<string, string>,
    queueReason: string | undefined,
  ): Promise<TaskOutcome> {
    const outcome: TaskOutcome = { taskId: task.id, ok: false }

    // Estado durável: quem falhou (ou escalou e parou em progress, ou levou
    // conflict da cerca) passa por retried antes de ser redespachado; quem
    // nunca nasceu passa por ready.
    const state = this.#journal.stateOf(task.id)
    if (state === 'task.failed' || state === 'task.conflict' || state === 'task.progress') {
      await this.#journal.record({ state: 'task.retried', taskId: task.id })
    } else if (state === 'task.created') {
      await this.#journal.record({ state: 'task.ready', taskId: task.id })
    }

    // Readiness DINÂMICA (foto tirada no início da tentativa): a onda diz que
    // é a vez dela, mas o insumo real obrigatório manda — insumo ausente é
    // fila com motivo, não despacho cego.
    if (queueReason !== undefined) {
      outcome.queued = true
      outcome.error = queueReason
      return outcome
    }

    // O SCHEDULER escolhe a máquina pelos requirements declarados (§28) — um
    // workerId que o modelo tenha tentado embutir já morreu na leitura.
    const choice = chooseWorker(
      task.requirements,
      this.#options.fleet.workers(),
      this.#options.chooseOptions ?? {},
    )
    if ('queued' in choice) {
      outcome.queued = true
      outcome.error = choice.reason
      return outcome
    }
    const worker = choice.chosen

    // Lease com época ANTES de congelar: o plano carimba exatamente o lease
    // que o despacho obteve.
    try {
      await this.#options.fleet.acquire(task.id, worker.id)
    } catch (error) {
      if (error instanceof LeaseHeldError) {
        outcome.queued = true
        outcome.error = error.message
        return outcome
      }
      throw error
    }

    // O plano é congelado UMA VEZ, antes do despacho — e é ESTE plano que a
    // execução usa e promove. Congelar de novo lá dentro seria uma segunda
    // decisão: no dia em que o lease andasse entre o despacho e a execução, o
    // envelope anunciaria uma época e o trabalho rodaria em outra.
    let plan: WorkspacePlan
    try {
      plan = await this.#options.workspaces.plan({
        sessionId: this.#options.goalId,
        taskId: task.id,
        botId: task.specialist,
        attempt,
        goalId: this.#options.goalId,
      })
    } catch (error) {
      outcome.error = `não foi possível congelar o workspace da tarefa: ${message(error)}`
      await this.#recordFailure(task.id, undefined, outcome.error)
      return outcome
    }

    const taskRunId = makeTaskRunId(task.id, attempt)
    outcome.taskRunId = taskRunId
    await this.#journal.record({
      state: 'task.dispatched',
      taskId: task.id,
      taskRunId,
      attempt,
      wave,
      workerId: worker.id,
      leaseEpoch: plan.leaseEpoch,
      workspacePlanId: plan.id,
    })
    tracker.markDispatched(task.id)

    const upstream: Record<string, string> = {}
    for (const dependency of task.dependsOn ?? []) {
      upstream[dependency] = results[dependency] ?? ''
    }

    await this.#journal.record({ state: 'task.started', taskId: task.id, taskRunId })

    let answer: string
    try {
      answer = await this.#options.executor.run({
        task,
        taskRunId,
        attempt,
        wave,
        worker,
        plan,
        upstream,
      })
    } catch (error) {
      outcome.error = message(error)
      await this.#recordFailure(task.id, taskRunId, outcome.error)
      tracker.release(task.id)
      return outcome
    }

    // Escalar NÃO é falha: é o trabalhador se recusando a adivinhar. OK fica
    // falso porque não há resultado para as dependentes lerem — quem separa
    // uma coisa da outra é o escalated, que vai até o portão.
    const escalated = escalation(answer)
    if (escalated.escalated) {
      outcome.escalated = true
      outcome.error = `escalado: ${escalated.question}`
      await this.#journal.record({
        state: 'task.progress',
        taskId: task.id,
        taskRunId,
        detail: outcome.error,
      })
      tracker.release(task.id)
      return outcome
    }

    // Resposta VAZIA não é tarefa concluída: marcar como sucesso escreveria
    // results[t] = '' e a dependente receberia o bloco do upstream vazio.
    if (answer.trim() === '') {
      outcome.error = 'o trabalhador terminou sem produzir resultado'
      await this.#recordFailure(task.id, taskRunId, outcome.error)
      tracker.release(task.id)
      return outcome
    }

    // RECUSA não é resultado (recusa-como-falha): sem results, com ✗ no
    // relatório e com o portão abrindo como abre para qualquer falha.
    if (refusal(answer)) {
      outcome.error = `o trabalhador recusou a tarefa: ${truncate(answer.trim(), 200)}`
      await this.#recordFailure(task.id, taskRunId, outcome.error)
      tracker.release(task.id)
      return outcome
    }

    // A CERCA, na hora de aceitar: o resultado só vira verdade se o worker
    // AINDA detém o lease na época congelada. É aqui que o PC-02 que perdeu a
    // rede e voltou depois do PC-03 assumir bate — e o journal grava CONFLICT,
    // o desfecho durável da preempção.
    try {
      await this.#options.workspaces.promote(plan, { stagingUri: plan.staging.uri })
    } catch (error) {
      if (error instanceof StaleWorkspaceError) {
        outcome.error = `o resultado não pôde ser promovido: ${error.message}`
        await this.#journal.record({
          state: 'task.conflict',
          taskId: task.id,
          taskRunId,
          workerId: worker.id,
          leaseEpoch: plan.leaseEpoch,
          detail: outcome.error,
        })
        tracker.release(task.id)
        return outcome
      }
      outcome.error = `o resultado não pôde ser promovido: ${message(error)}`
      await this.#recordFailure(task.id, taskRunId, outcome.error)
      tracker.release(task.id)
      return outcome
    }

    await this.#journal.record({ state: 'task.done', taskId: task.id, taskRunId })
    tracker.complete(task.id)
    outcome.ok = true
    outcome.result = answer
    return outcome
  }

  async #recordFailure(taskId: string, taskRunId: string | undefined, detail: string): Promise<void> {
    const transition: Parameters<TaskJournal['record']>[0] = {
      state: 'task.failed',
      taskId,
      detail,
    }
    if (taskRunId !== undefined) transition.taskRunId = taskRunId
    await this.#journal.record(transition)
  }

  async #gate(wave: number, failures: number, escalations: number): Promise<GateDecision> {
    const prompt: GatePrompt = {
      wave,
      failures,
      escalations,
      reason: gateReason(wave, failures, escalations),
    }
    if (this.#options.decideGate === undefined) {
      // Sem decisor, seguir é o default do oráculo no esgotamento do prazo:
      // travar a equipe porque uma tarefa de três falhou é pior que seguir
      // com o aviso registrado.
      return 'proceed'
    }
    return this.#options.decideGate(prompt)
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
