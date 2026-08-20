/**
 * O BrowserRuntimeService (`ctx.browser`): o seam que o agent loop usa para
 * ter um navegador — e a REGRA task-scoped da spec §32, aplicada ANTES de
 * qualquer HTTP:
 *
 * 1. **Sem execution target = recusa com motivo.** O browser não é do bot nem
 *    da sessão de conversa: é da TENTATIVA (taskRunId+workerId+leaseEpoch+
 *    runtimeId). Um chamador sem target não tem onde pendurar o ciclo de vida
 *    — e um browser sem dono declarado é exatamente o vazamento que a
 *    cirurgia §3 removeu do openbot.
 * 2. **Sem requirements.browser=true no plano = recusa com motivo.** O
 *    requisito é de ADMISSÃO (domain/runtime): o scheduler escolheu a máquina
 *    porque a tarefa DECLAROU precisar de navegador. Abrir browser para uma
 *    tarefa que não declarou inverteria a autoridade — o executor passaria a
 *    decidir requisito depois do despacho. A leitura usa o MESMO
 *    parseRequirements do scheduler: um `browser: "sim"` que passasse aqui e
 *    não passasse lá seria duas políticas divergindo.
 * 3. **Fechar é automático no fim da TaskRun.** O open registra o close como
 *    DISPOSER do kernel no escopo do dono (o Context da TaskRun): quando o
 *    escopo desmonta — fim normal, falha, preempção —, o contexto do browser
 *    morre DE VERDADE no agent-computer. Bot ocioso consome zero navegadores.
 */

import { Service, type Context } from '@aibot2/harness-kernel'
import { parseRequirements } from '@aibot2/domain-runtime'
import {
  AgentComputerClient,
  type BrowserAction,
  type BrowserControlState,
  type BrowserSnapshot,
  type FetchLike,
} from './client.js'
import { BrowserRefusalError, validateTarget, type ExecutionTarget } from './target.js'

declare module '@aibot2/harness-kernel' {
  interface Context {
    browser: BrowserRuntimeService
  }
}

export interface BrowserRuntimeConfig {
  /** Onde o agent-computer atende (http://127.0.0.1:<porta> no M1). */
  baseUrl: string
  /** O token compartilhado — chega por config na subida (cofre → env), nunca no código. */
  token: string
  /** Injetável para teste; ausente = fetch global. */
  fetchFn?: FetchLike
}

/** O pedido de abertura: o target do despacho + o plano congelado da TaskRun. */
export interface OpenBrowserRequest {
  /** A chave de execução. AUSENTE = recusa — não existe browser sem dono. */
  target?: ExecutionTarget
  /**
   * Os requirements COMO A TAREFA OS DECLAROU (o Record opaco do plano da
   * TaskRun). A leitura estreita é a do domain/runtime — a mesma do scheduler.
   */
  requirements?: Record<string, unknown>
}

/**
 * O navegador ARRENDADO a uma TaskRun: a superfície que o agent loop usa.
 * `close` é idempotente porque o disposer do kernel e um close explícito
 * podem ambos chegar — fechar duas vezes é tão inofensivo quanto uma.
 */
export interface BrowserLease {
  readonly target: ExecutionTarget
  navigate(url: string): Promise<{ url: string; title: string }>
  snapshot(): Promise<BrowserSnapshot>
  act(action: BrowserAction): Promise<Record<string, unknown>>
  /**
   * O VOLANTE da execução (Take the Wheel), preso ao runtimeId do lease — não a
   * um bot. `control()` LÊ o estado (o que a UI forkada mostra como cartão);
   * take/release/request dirigem o handover. Enquanto o humano segura, `act`
   * acima RECUSA com humanHasControl (nunca enfileira) — a semântica do
   * control.ts do agent-computer chega à tela por aqui.
   */
  control(): Promise<BrowserControlState>
  requestControl(reason: string): Promise<BrowserControlState>
  takeControl(): Promise<BrowserControlState>
  releaseControl(): Promise<BrowserControlState>
  close(): Promise<void>
}

export class BrowserRuntimeService extends Service {
  readonly #client: AgentComputerClient

  constructor(ctx: Context, config: BrowserRuntimeConfig) {
    super(ctx, 'browser')
    this.#client = new AgentComputerClient({
      baseUrl: config.baseUrl,
      token: config.token,
      ...(config.fetchFn !== undefined ? { fetchFn: config.fetchFn } : {}),
    })
  }

  /**
   * Abre o navegador da TaskRun — ou RECUSA com motivo, antes de qualquer
   * HTTP.
   *
   * `owner` é o Context de quem está executando a TaskRun: o close entra como
   * disposer NO ESCOPO DELE, então o fim da TaskRun (unload do escopo) fecha
   * o contexto de verdade sem ninguém lembrar de chamar close. Ausente, o
   * dono é o escopo do próprio plugin — o shutdown do processo ainda fecha.
   */
  async open(request: OpenBrowserRequest, owner?: Context): Promise<BrowserLease> {
    const target = request.target
    if (target === undefined) {
      throw new BrowserRefusalError(
        'browser é task-scoped: abrir exige um execution target (taskRunId, workerId, leaseEpoch, runtimeId) — nenhum foi fornecido',
      )
    }
    validateTarget(target)

    // A MESMA leitura estreita do scheduler: campo desconhecido não existe, e
    // só `browser: true` literal conta como requisito declarado.
    const requirements = parseRequirements(request.requirements)
    if (requirements.browser !== true) {
      throw new BrowserRefusalError(
        `a TaskRun ${target.taskRunId} não declarou requirements.browser=true no plano — ` +
          'browser task-scoped só nasce para tarefa que o declarou (spec §32)',
      )
    }

    const client = this.#client
    const runtimeId = target.runtimeId
    await client.open(runtimeId)

    // Idempotência do close: disposer do kernel + close explícito podem ambos
    // chegar; o flag garante UM fechamento e o resto é não-operação.
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await client.close(runtimeId)
    }

    // O ciclo de vida: o fim do escopo do dono fecha o browser DE VERDADE.
    ;(owner ?? this.ctx).effect(() => close, `browser:${runtimeId}`)

    return {
      target,
      navigate: (url) => client.navigate(runtimeId, url),
      snapshot: () => client.snapshot(runtimeId),
      act: (action) => client.act(runtimeId, action),
      control: () => client.control(runtimeId),
      requestControl: (reason) => client.requestControl(runtimeId, reason),
      takeControl: () => client.takeControl(runtimeId),
      releaseControl: () => client.releaseControl(runtimeId),
      close,
    }
  }
}
