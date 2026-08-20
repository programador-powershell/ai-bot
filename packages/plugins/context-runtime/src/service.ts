/**
 * O ContextRuntimeService (`ctx.contextRuntime`): a cápsula viva por sessão, a
 * montagem do working set, os gatilhos do Budget Manager e o ciclo
 * checkpoint/resume — o Context Runtime como Service do kernel.
 *
 * A dobra é serializada POR SESSÃO (KeyedMutex): um turno substituído pode
 * terminar a dobra dele enquanto o substituto termina a própria, e duas
 * dobras lendo o mesmo cursor dobrariam os mesmos eventos duas vezes — a
 * mesma trava do foldCapsule do oráculo, agora com o motivo RS5 (o event loop
 * não protege nada entre awaits).
 *
 * Os eventos `context.compacted` e `checkpoint.created` saem por DOIS canais:
 * o barramento tipado do kernel (observadores do processo) e o LOG da sessão.
 * No log eles viajam como payload do verbo `state` com um campo NOVO — o
 * conjunto KINDS é fechado e pertence ao protocolo (E2); verbo novo é decisão
 * de protocolo, e campo novo é compatível por contrato ("acrescentar é
 * compatível"). Quando o protocolo ganhar os verbos próprios, só este arquivo
 * muda.
 */

import { Service, type Context } from '@aibot2/harness-kernel'
import {
  KeyedMutex,
  MAX_EVENT_BATCH,
  type Envelope,
  type StorageDriver,
} from '@aibot2/domain-events'
import { BudgetManager, type BudgetPressure } from './budget.js'
import { Capsule, foldValidated } from './capsule.js'
import { tailFromEnvelopes, type TailItem } from './history.js'
import { assemble, type Assembly } from './assembler.js'
import {
  buildCheckpoint,
  resumeFromCheckpoint,
  type Checkpoint,
  type CheckpointStore,
  type Resumed,
} from './checkpoint.js'

/* --------------------------- eventos tipados ------------------------------ */

/** O que uma compactação fez — a telemetria de quem observa o funil de contexto. */
export interface ContextCompactedEvent {
  sessionId: string
  /** O gatilho que disparou: soft (fim de turno), prefire (~85% do hard), hard ou phase (done). */
  trigger: 'soft' | 'prefire' | 'hard' | 'phase'
  /** O cursor da cápsula depois da dobra. */
  cursor: number
  folds: number
  events: number
}

export interface CheckpointCreatedEvent {
  sessionId: string
  eventCursor: number
  pendingApprovals: number
  artifacts: number
}

declare module '@aibot2/harness-kernel' {
  interface Context {
    contextRuntime: ContextRuntimeService
  }
  interface Events {
    'context.compacted'(event: ContextCompactedEvent): void
    'checkpoint.created'(event: CheckpointCreatedEvent): void
  }
}

/* ------------------------------ configuração ------------------------------ */

export interface ContextRuntimeConfig {
  store: StorageDriver
  checkpoints: CheckpointStore
  /** A janela do modelo em tokens. Ausente = DEFAULT_CONTEXT_TOKENS (conservador). */
  contextTokens?: number
}

/** O pedido de montagem de um working set. */
export interface AssembleRequest {
  sessionId: string
  system: readonly string[]
  retrieved?: readonly string[]
  notes?: readonly string[]
  /** Itens com seq > este valor são o turno atual (relevantes por definição). */
  relevantFromSeq?: number
}

/** A montagem + a pressão medida — o que o agent loop consome por passo. */
export interface AssembledContext extends Assembly {
  pressure: BudgetPressure
}

/* -------------------------------- o serviço ------------------------------- */

export class ContextRuntimeService extends Service {
  readonly budget: BudgetManager
  readonly #store: StorageDriver
  readonly #checkpoints: CheckpointStore
  readonly #locks = new KeyedMutex()
  /**
   * As cápsulas vivas — CACHE da verdade, nunca a verdade: qualquer uma se
   * reconstrói de checkpoint+log (resume). Perder este mapa é perder nada.
   */
  readonly #capsules = new Map<string, Capsule>()
  #counter = 0

  constructor(ctx: Context, config: ContextRuntimeConfig) {
    super(ctx, 'contextRuntime')
    this.#store = config.store
    this.#checkpoints = config.checkpoints
    this.budget = new BudgetManager(config.contextTokens)
  }

  /** A cápsula viva da sessão (vazia para sessão nunca vista NESTE processo). */
  capsuleOf(sessionId: string): Capsule {
    let capsule = this.#capsules.get(sessionId)
    if (capsule === undefined) {
      capsule = new Capsule()
      this.#capsules.set(sessionId, capsule)
    }
    return capsule
  }

  /**
   * Retoma a sessão de checkpoint + event store. NUNCA da RAM do processo
   * anterior — este método existe exatamente porque aquela RAM não existe
   * mais. A cápsula retomada vira a viva desta sessão.
   */
  async resume(sessionId: string): Promise<Resumed> {
    return this.#locks.runExclusive(sessionId, async () => {
      const resumed = await resumeFromCheckpoint(this.#store, this.#checkpoints, sessionId)
      this.#capsules.set(sessionId, resumed.capsule)
      return resumed
    })
  }

  /**
   * Monta o working set: system + cápsula + cauda recente + retrieved +
   * projeções — nunca o histórico bruto completo (a cauda é lida do FIM do
   * log, como o history() do oráculo: ler do zero entregaria para sempre o
   * começo da conversa). Se o fit ladder descartou grupos que a cápsula ainda
   * não dobrou, dobra-os AGORA e remonta uma vez — o grupo só sai da janela
   * com a representação garantida.
   */
  async assembleFor(request: AssembleRequest): Promise<AssembledContext> {
    const tail = await this.#recentTail(request.sessionId)
    const capsule = this.capsuleOf(request.sessionId)
    const input = {
      system: request.system,
      capsule,
      tail,
      retrieved: request.retrieved ?? [],
      notes: request.notes ?? [],
      ...(request.relevantFromSeq !== undefined ? { relevantFromSeq: request.relevantFromSeq } : {}),
    }
    let assembly = assemble(input, this.budget)
    if (assembly.droppedUnabsorbed.length > 0) {
      // O contrato do assembler: estes seqs saíram da janela SEM estarem na
      // cápsula. Dobra até cobri-los e remonta — uma vez basta, porque depois
      // da dobra eles são "histórico absorvido" por definição.
      const upTo = assembly.droppedUnabsorbed[assembly.droppedUnabsorbed.length - 1]!
      await this.foldSession(request.sessionId, upTo)
      assembly = assemble({ ...input, capsule: this.capsuleOf(request.sessionId) }, this.budget)
    }
    // A pressão mede a DEMANDA (pré-fit), não o resultado espremido: a
    // preventiva dispara antes de o ladder degradar a qualidade, nunca depois.
    return { ...assembly, pressure: this.budget.pressure(assembly.demandTokens) }
  }

  /**
   * Dobra os envelopes novos do log para dentro da cápsula — em DUAS passadas
   * (extração e validação): a candidata só substitui a cápsula atual se
   * preservou o estado crítico. Candidata reprovada é descartada e a anterior
   * fica — nunca trocar cápsula válida por resumo que perdeu estado.
   */
  async foldSession(sessionId: string, upToSeq?: number): Promise<Capsule> {
    return this.#locks.runExclusive(sessionId, async () => {
      let capsule = this.capsuleOf(sessionId)
      // Semente do objetivo, como no oráculo: cápsula sem objetivo não presta,
      // e o título da sessão é o melhor objetivo disponível antes da 1ª fala.
      if (capsule.goal === '') {
        try {
          const meta = await this.#store.getSession(sessionId)
          if (meta.title !== '') capsule.goal = meta.title
        } catch {
          // Sessão sem cabeçalho ainda — a 1ª mensagem do usuário semeia.
        }
      }
      for (;;) {
        const batch = await this.#store.since(sessionId, capsule.cursor, MAX_EVENT_BATCH)
        if (batch.length === 0) break
        const slice = upToSeq === undefined ? batch : batch.filter((envelope) => envelope.seq <= upToSeq)
        if (slice.length === 0) break
        const outcome = foldValidated(capsule, slice)
        if (!outcome.adopted) {
          // A candidata perdeu estado crítico: fica a anterior e o defeito
          // faz barulho no canal de erro — dobra muda de silenciosa para
          // observável exatamente quando erra.
          this.ctx.emit('internal/error', new Error(
            `context-runtime: dobra da sessão ${sessionId} reprovada na validação: ${outcome.losses.join('; ')}`,
          ))
          break
        }
        capsule = outcome.capsule
        this.#capsules.set(sessionId, capsule)
        if (slice.length < batch.length || batch.length < MAX_EVENT_BATCH) break
      }
      return capsule
    })
  }

  /**
   * Compacta: dobra tudo que o log tem e ANUNCIA — evento tipado no kernel e
   * a marca durável no log da sessão. A compactação não apaga nada: o
   * histórico continua no log; o que muda é a PROMESSA de que a próxima
   * montagem não o reenvia verbatim (a cápsula o representa).
   */
  async compact(sessionId: string, trigger: ContextCompactedEvent['trigger']): Promise<Capsule> {
    const capsule = await this.foldSession(sessionId)
    const event: ContextCompactedEvent = {
      sessionId,
      trigger,
      cursor: capsule.cursor,
      folds: capsule.telemetry.folds,
      events: capsule.telemetry.events,
    }
    this.ctx.emit('context.compacted', event)
    await this.#mark(sessionId, { contextCompacted: event })
    return capsule
  }

  /**
   * Tira o checkpoint da sessão: cápsula + cursor + artefatos + pendências de
   * aprovação (lidas do LOG). Anuncia nos dois canais.
   */
  async checkpoint(sessionId: string): Promise<Checkpoint> {
    const capsule = this.capsuleOf(sessionId)
    const checkpoint = await buildCheckpoint(this.#store, sessionId, capsule)
    await this.#checkpoints.save(checkpoint)
    const event: CheckpointCreatedEvent = {
      sessionId,
      eventCursor: checkpoint.eventCursor,
      pendingApprovals: checkpoint.pendingApprovals.length,
      artifacts: checkpoint.artifacts.length,
    }
    this.ctx.emit('checkpoint.created', event)
    await this.#mark(sessionId, { checkpointCreated: event })
    return checkpoint
  }

  /* ------------------------------- interno -------------------------------- */

  /** A cauda recente do log — lida do FIM, nunca do começo. */
  async #recentTail(sessionId: string): Promise<TailItem[]> {
    const last = await this.#store.lastSeq(sessionId)
    const from = last > MAX_EVENT_BATCH ? last - MAX_EVENT_BATCH : 0
    const envelopes: Envelope[] = await this.#store.since(sessionId, from, MAX_EVENT_BATCH)
    return tailFromEnvelopes(envelopes)
  }

  /**
   * A marca no log: payload de `state` com o campo novo. `busy` é exigido pelo
   * contrato do payload; a marca não altera o estado observável da conversa,
   * então repete o que o momento é — o runtime só marca fora do caminho da
   * resposta.
   */
  async #mark(sessionId: string, extra: Record<string, unknown>): Promise<void> {
    try {
      await this.#store.append(sessionId, {
        id: `cr-${Date.now()}-${++this.#counter}`,
        kind: 'state',
        from: { kind: 'system', id: 'context-runtime' },
        payload: { busy: false, ...extra },
      })
    } catch {
      // A marca é observabilidade, não transação: sessão apagada no meio (ou
      // log fechado no shutdown) não pode derrubar a compactação que já
      // aconteceu em memória e no checkpoint.
    }
  }
}
