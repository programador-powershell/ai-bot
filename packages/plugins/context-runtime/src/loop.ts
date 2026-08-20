/**
 * O Agent Loop plugável (`ctx.agentLoop`) — o seam da spec E6.
 *
 * O turno é um pipeline fixo: o ASSEMBLER monta o contexto → o MODELO (seam;
 * scriptedModel nos testes) responde → as TOOL CALLS passam pelo
 * ctx.actionGateway (NUNCA por fora — o loop não conhece executor nenhum; o
 * único caminho até um efeito é o funil auditado do E4) → o resultado
 * PROJETADO volta ao contexto pelo próprio log (o gateway grava tool.call e
 * tool.result; a montagem seguinte os lê como evidência) → done fecha o turno
 * e a dobra da cápsula + checkpoint rodam fora do caminho da resposta.
 *
 * O molde é o AgentFactory do harness (FORMA, nunca linha — clean-room):
 * create/resume devolvem um agente com INBOX — followup (a próxima fala, já
 * enfileirada), steer (correção de rumo NO MEIO do turno) e inject (contexto
 * efêmero de processo). followup e steer são fala da pessoa e vão ao LOG;
 * inject não vai — replay que reencenasse uma injeção de processo seria
 * defeito, o mesmo motivo do Notice efêmero.
 *
 * A chamada de ferramenta é por BLOCO CERCADO (```aibot:tool), não pelo
 * function-calling de cada provedor — a razão de produto do oráculo: o
 * usuário escolhe o modelo, e nem todo modelo do catálogo tem
 * function-calling. O custo é o modelo poder errar o JSON, e por isso o erro
 * de parse VOLTA para ele como resultado em vez de virar exceção.
 */

import { Service, type Context } from '@aibot2/harness-kernel'
import type { Actor, StorageDriver } from '@aibot2/domain-events'
import { truncate, type ActionRequest } from '@aibot2/plugin-action-gateway'
import type { ChatMessage } from './history.js'
import { toolEvidence } from './history.js'
import type { AssembledContext, ContextRuntimeService } from './service.js'

/* ------------------------------ seam do modelo ----------------------------- */

/** O que o modelo recebe por passo. */
export interface ModelStep {
  sessionId: string
  turn: string
  /** 1 = o primeiro passo do turno. */
  step: number
  messages: ChatMessage[]
  signal?: AbortSignal
}

/**
 * O seam do modelo: o loop conversa com ISTO, nunca com um provedor. Nos
 * testes, um scriptedModel; em produção, o roteador de modelos do M2.
 */
export interface ChatModel {
  complete(step: ModelStep): Promise<string>
}

/* ------------------------------- tool calls -------------------------------- */

export const TOOL_FENCE = '```aibot:tool'

/** Uma chamada extraída da resposta. `raw` guarda o texto original. */
export interface ToolInvocation {
  tool: string
  args?: unknown
  raw: string
}

/** Extrai as chamadas do texto do modelo — porte do parseToolCalls do oráculo. */
export function parseToolCalls(answer: string): ToolInvocation[] {
  const out: ToolInvocation[] = []
  let rest = answer
  for (;;) {
    const start = rest.indexOf(TOOL_FENCE)
    if (start < 0) return out
    rest = rest.slice(start + TOOL_FENCE.length)
    const end = rest.indexOf('```')
    if (end < 0) {
      // Bloco aberto e não fechado: o modelo cortou no meio. Ignorar é o
      // certo — executar um JSON truncado seria executar outra coisa.
      return out
    }
    const body = rest.slice(0, end).trim()
    rest = rest.slice(end + 3)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // Guarda a chamada mesmo assim: o erro precisa VOLTAR para o modelo,
      // senão ele repete o mesmo JSON quebrado para sempre.
      out.push({ tool: '', raw: body })
      continue
    }
    const record = parsed as Record<string, unknown> | null
    const tool = typeof record?.['tool'] === 'string' ? (record['tool'] as string) : ''
    if (tool === '') {
      out.push({ tool: '', raw: body })
      continue
    }
    const invocation: ToolInvocation = { tool, raw: body }
    if (record !== null && 'args' in record) invocation.args = record['args']
    out.push(invocation)
  }
}

/** Tira os blocos de ferramenta do texto mostrado à pessoa. */
export function stripToolBlocks(answer: string): string {
  let out = ''
  let rest = answer
  for (;;) {
    const start = rest.indexOf(TOOL_FENCE)
    if (start < 0) return (out + rest).trim()
    out += rest.slice(0, start)
    rest = rest.slice(start + TOOL_FENCE.length)
    const end = rest.indexOf('```')
    if (end < 0) return out.trim()
    rest = rest.slice(end + 3)
  }
}

/* --------------------------- eventos e contratos --------------------------- */

/** O que um passo está prestes a fazer — o payload do gancho agent/pre-step. */
export interface PreStepInfo {
  sessionId: string
  turn: string
  step: number
  specialistId: string
  messageCount: number
}

declare module '@aibot2/harness-kernel' {
  interface Context {
    agentLoop: AgentLoopService
  }
  interface Events {
    /**
     * Waterfall em volta da chamada de modelo: o miolo É o modelo. Não chamar
     * next() VETA o passo (o turno encerra interrompido) — é o gancho que o
     * plano promete para observadores e políticas de passo. O retorno aceita
     * undefined porque o veto se manifesta assim: listener que não chama
     * next() devolve nada, e o loop lê "nada" como passo vetado.
     */
    'agent/pre-step'(
      info: PreStepInfo,
      next: () => Promise<string>,
    ): Promise<string | undefined> | string | undefined
  }
}

export interface AgentLoopConfig {
  store: StorageDriver
  model: ChatModel
  /**
   * Teto de passos por turno. Um modelo que chama ferramenta para sempre não
   * é diligência, é laço — o teto encerra com interrupção declarada.
   */
  maxSteps?: number
}

export const DEFAULT_MAX_STEPS = 8

/** O que abre um agente. */
export interface AgentOptions {
  sessionId: string
  specialistId: string
  /** Instruções fixas (política, contratos) — nunca caem da janela. */
  system?: readonly string[]
  /** Restrições declaradas — entram na cápsula como estado crítico. */
  constraints?: readonly string[]
  maxSteps?: number
}

/** O desfecho de um turno. */
export interface TurnOutcome {
  turn: string
  /** A resposta final, já sem blocos de ferramenta. */
  answer: string
  steps: number
  toolCalls: number
  /** true = o teto de passos (ou um veto de pre-step) encerrou o turno. */
  interrupted: boolean
  /** true = alguma compactação por gatilho de orçamento rodou neste turno. */
  compacted: boolean
}

/* ---------------------------------- agente --------------------------------- */

export class Agent {
  readonly sessionId: string
  readonly specialistId: string
  readonly #service: AgentLoopService
  readonly #system: readonly string[]
  readonly #maxSteps: number
  /** Fala da pessoa para DEPOIS do turno atual — cada uma vira um turno. */
  readonly #followups: string[] = []
  /** Correções de rumo para o PRÓXIMO passo do turno atual. */
  readonly #steers: string[] = []
  /** Contexto efêmero de processo para a PRÓXIMA montagem (uma vez só). */
  readonly #injections: string[] = []
  /** Serializa os turnos: um agente conversa uma conversa. */
  #queue: Promise<unknown> = Promise.resolve()
  #turnActive = false

  constructor(service: AgentLoopService, options: AgentOptions) {
    this.sessionId = options.sessionId
    this.specialistId = options.specialistId
    this.#service = service
    this.#system = options.system ?? []
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  }

  /** Roda um turno completo para este prompt (enfileirado atrás dos anteriores). */
  runTurn(prompt: string, signal?: AbortSignal): Promise<TurnOutcome> {
    const run = this.#queue.then(async () => {
      this.#turnActive = true
      try {
        return await this.#service.executeTurn(this, prompt, signal)
      } finally {
        this.#turnActive = false
      }
    })
    // A fila nunca guarda rejeição: o erro é de quem pediu o turno, não de
    // quem pedir o seguinte.
    this.#queue = run.catch(() => undefined)
    return run
  }

  /**
   * followup: a próxima fala, já enfileirada — vira um turno próprio quando
   * chegar a vez dela.
   */
  followup(prompt: string, signal?: AbortSignal): Promise<TurnOutcome> {
    return this.runTurn(prompt, signal)
  }

  /**
   * steer: correção de rumo NO MEIO do turno. Vai ao LOG como fala da pessoa
   * (o replay tem de mostrá-la) e entra ANTES do próximo passo do modelo.
   * Sem turno ativo, vira followup — corrigir o rumo de ninguém é falar.
   */
  steer(text: string): void {
    if (this.#turnActive) {
      this.#steers.push(text)
      return
    }
    void this.followup(text)
  }

  /**
   * inject: contexto de PROCESSO para a próxima montagem, uma vez só. Não vai
   * ao log de propósito — não é fala, e um replay que a reencenasse mentiria
   * sobre o que a pessoa disse.
   */
  inject(note: string): void {
    this.#injections.push(note)
  }

  /** @internal drena as correções de rumo pendentes. */
  drainSteers(): string[] {
    return this.#steers.splice(0)
  }

  /** @internal drena as injeções pendentes. */
  drainInjections(): string[] {
    return this.#injections.splice(0)
  }

  /** @internal */
  get systemMessages(): readonly string[] {
    return this.#system
  }

  /** @internal */
  get maxSteps(): number {
    return this.#maxSteps
  }
}

/* --------------------------------- o serviço ------------------------------- */

export class AgentLoopService extends Service {
  readonly #store: StorageDriver
  readonly #model: ChatModel
  readonly #maxSteps: number
  #counter = 0

  constructor(ctx: Context, config: AgentLoopConfig) {
    super(ctx, 'agentLoop')
    this.#store = config.store
    this.#model = config.model
    this.#maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS
  }

  /** Abre um agente novo sobre a sessão. */
  create(options: AgentOptions): Agent {
    const agent = new Agent(this, { maxSteps: this.#maxSteps, ...options })
    for (const constraint of options.constraints ?? []) {
      this.ctx.contextRuntime.capsuleOf(options.sessionId).addConstraint(constraint)
    }
    return agent
  }

  /**
   * Retoma um agente depois de um reinício: cápsula de checkpoint + event
   * store (via ctx.contextRuntime.resume) — NUNCA a RAM do processo anterior.
   * As restrições vêm do CHECKPOINT (a cápsula as carrega), não da config.
   */
  async resume(options: AgentOptions): Promise<Agent> {
    await this.ctx.contextRuntime.resume(options.sessionId)
    return new Agent(this, { maxSteps: this.#maxSteps, ...options })
  }

  /**
   * @internal O turno inteiro. Chamado pelo Agent (que serializa); nunca
   * diretamente — dois turnos simultâneos na mesma sessão intercalariam
   * envelopes de turnos diferentes.
   */
  async executeTurn(agent: Agent, prompt: string, signal?: AbortSignal): Promise<TurnOutcome> {
    const runtime = this.ctx.contextRuntime
    const sessionId = agent.sessionId
    const turn = this.#nextId('t')
    const userActor: Actor = { kind: 'user' }
    const specialistActor: Actor = {
      kind: 'specialist',
      id: agent.specialistId,
      specialist: agent.specialistId,
    }

    // O prompt vai ao log ANTES de tudo: ele volta pelo histórico (a mesma
    // regra do oráculo — acrescentá-lo de novo à mão faria o modelo ver a
    // pergunta duas vezes).
    const promptSeq = await this.#append(sessionId, turn, 'message', userActor, {
      role: 'user',
      text: prompt,
    })

    let steps = 0
    let toolCalls = 0
    let compacted = false
    let softPromised = false
    let interrupted = false
    let finalAnswer = ''

    while (steps < agent.maxSteps) {
      steps++

      // steer: a correção de rumo entra ANTES do passo, como fala durável.
      for (const steerText of agent.drainSteers()) {
        await this.#append(sessionId, turn, 'message', userActor, { role: 'user', text: steerText })
      }

      const assembled = await this.#assembleWithBudget(agent, promptSeq)
      if (assembled.compactedNow) compacted = true
      if (assembled.softPromised) softPromised = true

      // O gancho waterfall em volta do modelo: não chamar next() veta o passo.
      const info: PreStepInfo = {
        sessionId,
        turn,
        step: steps,
        specialistId: agent.specialistId,
        messageCount: assembled.context.messages.length,
      }
      const modelStep: ModelStep = {
        sessionId,
        turn,
        step: steps,
        messages: assembled.context.messages,
      }
      if (signal !== undefined) modelStep.signal = signal
      const answer = await this.ctx.waterfall('agent/pre-step', info, () => this.#model.complete(modelStep))
      if (answer === undefined) {
        // Veto declarado: o turno encerra interrompido, com rastro no log.
        interrupted = true
        break
      }

      const calls = parseToolCalls(answer)
      const spoken = stripToolBlocks(answer)

      // A fala do modelo (sem os blocos) é durável — é o que a pessoa viu.
      if (spoken !== '') {
        await this.#append(sessionId, turn, 'message', specialistActor, {
          role: 'assistant',
          text: spoken,
          specialist: agent.specialistId,
        })
      }

      if (calls.length === 0) {
        finalAnswer = spoken
        break
      }

      // As ferramentas: TODAS pelo ctx.actionGateway — o funil grava
      // tool.call/tool.result e o resultado PROJETADO volta ao contexto pela
      // montagem seguinte (que lê o log). Não existe caminho lateral.
      for (const call of calls) {
        if (signal?.aborted === true) {
          interrupted = true
          break
        }
        if (call.tool === '') {
          // JSON quebrado volta para o modelo como evidência durável — o
          // mesmo contrato do executeTool do oráculo.
          await this.#append(sessionId, turn, 'message', { kind: 'system', id: 'agent-loop' }, {
            role: 'user',
            text: toolEvidence(
              '(bloco inválido)',
              `ERRO: bloco de ferramenta com JSON inválido. Recebido:\n${truncate(call.raw, 500)}`,
            ),
          })
          continue
        }
        toolCalls++
        const request: ActionRequest = {
          sessionId,
          turn,
          specialistId: agent.specialistId,
          tool: call.tool,
          rawArgs: call.raw,
        }
        if (call.args !== undefined) request.args = call.args
        if (signal !== undefined) request.signal = signal
        await this.ctx.actionGateway.execute(request)
      }
      if (interrupted) break
      // O laço continua: a próxima montagem já enxerga as evidências.
    }

    if (steps >= agent.maxSteps && finalAnswer === '' && !interrupted) {
      // O teto de passos: encerrar declarado é melhor que rodar para sempre.
      interrupted = true
      await this.#append(sessionId, turn, 'message', specialistActor, {
        role: 'assistant',
        text: `O turno atingiu o teto de ${agent.maxSteps} passos e foi encerrado — o estado ficou na cápsula.`,
        specialist: agent.specialistId,
      })
    }

    // done fecha o turno — com interrupted quando for o caso: o replay tem de
    // distinguir "terminou" de "foi cortado".
    const donePayload: Record<string, unknown> = { turn, specialist: agent.specialistId }
    if (interrupted) donePayload['interrupted'] = true
    await this.#append(sessionId, turn, 'done', { kind: 'supervisor' }, donePayload)

    // Fora do caminho da resposta: o gatilho soft cumpre a promessa AGORA
    // (compactação anunciada nos dois canais); sem gatilho, a dobra por fase
    // roda silenciosa como no oráculo — o done é o fim de fase natural.
    if (softPromised) {
      await runtime.compact(sessionId, 'soft')
      compacted = true
    } else {
      await runtime.foldSession(sessionId)
    }
    await runtime.checkpoint(sessionId)

    return { turn, answer: finalAnswer, steps, toolCalls, interrupted, compacted }
  }

  /**
   * Monta o working set aplicando os gatilhos do Budget Manager: prefire/hard
   * compactam AGORA (antes do modelo — a preventiva de ~85%) e remontam; soft
   * fica prometido para o fim do turno (fora do caminho da resposta).
   */
  async #assembleWithBudget(
    agent: Agent,
    promptSeq: number,
  ): Promise<{ context: AssembledContext; compactedNow: boolean; softPromised: boolean }> {
    const runtime = this.ctx.contextRuntime
    // As notas drenam UMA vez por passo; a remontagem pós-compactação reusa as
    // mesmas — a primeira montagem foi descartada, a injeção ainda não falou.
    const request = {
      sessionId: agent.sessionId,
      system: agent.systemMessages,
      notes: agent.drainInjections(),
      relevantFromSeq: promptSeq - 1,
    }
    let context = await runtime.assembleFor(request)
    let compactedNow = false
    let softPromised = false
    if (context.pressure === 'prefire' || context.pressure === 'hard') {
      await runtime.compact(agent.sessionId, context.pressure)
      compactedNow = true
      context = await runtime.assembleFor(request)
    } else if (context.pressure === 'soft') {
      softPromised = true
    }
    return { context, compactedNow, softPromised }
  }

  async #append(
    sessionId: string,
    turn: string,
    kind: 'message' | 'done',
    from: Actor,
    payload: unknown,
  ): Promise<number> {
    return this.#store.append(sessionId, {
      id: this.#nextId('e'),
      turn,
      kind,
      from,
      payload,
    })
  }

  /** Ids na MESMA forma do oráculo (prefixo-epoch-contador) — legíveis no log. */
  #nextId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++this.#counter}`
  }
}
