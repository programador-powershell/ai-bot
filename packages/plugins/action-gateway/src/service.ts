/**
 * O ActionGateway como Service do kernel (`ctx.actionGateway`) — o funil ÚNICO
 * de efeitos do AI-BOT 2 (m1-plano §5 E4, decisão D3).
 *
 * Três heranças costuradas num caminho só:
 *
 *  1. o Gate do gateway Go (gate.ts): política declarativa, decisão humana
 *     ANTES do efeito, digest com escopo;
 *  2. o envelope govern() do openbot: a linha de auditoria é gravada ANTES do
 *     efeito e uma segunda linha depois (sucedeu/falhou) — aqui as duas linhas
 *     são os envelopes DURÁVEIS `tool.call` e `tool.result`, e o pedido de
 *     aprovação/decisão humana ficam entre elas, exatamente como a fixture
 *     sessions/ferramenta-aprovada gravou; o resumo que a pessoa lê é
 *     resolvido pelo SERVIDOR a partir dos argumentos, nunca por rótulo que o
 *     modelo tenha mandado;
 *  3. o Tool Output Gateway (tool-output.ts): a janela do modelo recebe a
 *     projeção; o integral vira artefato content-addressed.
 *
 * Invariante de casa: NENHUM efeito sai sem passar por `execute()` — o
 * executor de ferramentas (seam ToolExecutor) só é entregue a este serviço, e
 * o teste-espelho prova que um tool call sem decisão do portão não executa.
 * Diferente do oráculo (que ignora erro de emissão com `_ =`), aqui a escrita
 * da linha de auditoria é aguardada e a falha dela IMPEDE o efeito: uma ação
 * sem registro não aconteceu — é a disciplina do govern() do openbot, e é a
 * mais forte das duas.
 */

import { Service, type Context } from '@aibot2/harness-kernel'
import {
  MAX_EVENT_BATCH,
  type Actor,
  type ApprovalDecision,
  type ApprovalRequest,
  type Risk,
  type StorageDriver,
  type ToolCall,
  type ToolResult,
} from '@aibot2/domain-events'
import {
  Gate,
  approvalScope,
  defaultPolicy,
  digestOf,
  riskOf,
  type Decision,
  type SpecialistDirectory,
} from './gate.js'
import { normalizeIntent, type Intent, type IntentSubject } from './intents.js'
import type { ArtifactStore } from './artifacts.js'
import { projectToolOutput, summarize, truncate } from './tool-output.js'

/**
 * Quanto o funil espera por uma decisão humana. Passado isso a ferramenta é
 * RECUSADA, não liberada: o silêncio de quem saiu para o almoço não pode ser
 * lido como consentimento (o approvalTimeout do oráculo).
 */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/* ------------------------------ seams do E4 ------------------------------ */

/**
 * Quem SABE executar ferramentas — o Toolbox. O funil é o único consumidor
 * legítimo deste seam: entregá-lo a mais alguém na montagem é abrir a porta
 * lateral que este pacote existe para fechar.
 */
export interface ToolExecutor {
  call(sessionId: string, tool: string, args: unknown): Promise<string>
}

/* ------------------------------- contratos ------------------------------- */

/** Uma chamada de ferramenta como ela chega ao funil. */
export interface ActionRequest {
  sessionId: string
  /** O turno da conversa. Ausente = o funil cunha um id próprio. */
  turn?: string
  /** Sob QUEM a chamada roda — é o catálogo dele que o portão confere. */
  specialistId: string
  /** Quem assina os envelopes. Ausente = o próprio especialista. */
  actor?: Actor
  tool: string
  /** Os argumentos decodificados — o que o executor recebe e o tool.call registra. */
  args?: unknown
  /**
   * O JSON CRU como o modelo o emitiu. O digest do "aprovar sempre" é
   * calculado DELE (o mesmo byte que o oráculo digeriu) — ausente, o funil
   * serializa `args`, o que basta quando não há compat byte-a-byte em jogo.
   */
  rawArgs?: string
  /** A tecla de um computer_key — Enter/Espaço ativam, o resto digita. */
  key?: string
  /** A chamada MCP decomposta (efeito vem de catálogo revisado, nunca do nome). */
  mcp?: IntentSubject['mcp']
  /** O Stop do turno: abortado antes da decisão humana, a chamada é recusada. */
  signal?: AbortSignal
}

/** O desfecho estruturado de uma chamada que passou pelo funil. */
export interface ActionResult {
  callId: string
  turn: string
  /** O veredito do PORTÃO (um "ask" aprovado pela pessoa segue como ask + ok). */
  decision: Decision
  ok: boolean
  /**
   * A frase que volta ao MODELO — inclusive na recusa, porque o modelo
   * precisa saber que foi recusado para tentar outro caminho em vez de
   * repetir (o contrato do executeTool do oráculo).
   */
  text: string
  output?: string
  error?: string
  elapsedMs?: number
  artifactRef?: string
  rawBytes?: number
  truncated?: boolean
}

/** Um pedido de aprovação que sobreviveu a um reinício — reaparece na tela. */
export interface PendingApproval {
  turn: string
  request: ApprovalRequest
}

/** O desfecho de uma chamada feita pela interface (contrato {ok, output|error}). */
export interface UIToolResult {
  ok: boolean
  output?: string
  error?: string
}

/* --------------------------- eventos tipados ------------------------------ */

/** O veredito do portão, para quem observa o funil (telemetria, presença). */
export interface ActionDecisionEvent {
  sessionId: string
  turn: string
  callId: string
  tool: string
  intent: Intent
  risk: Risk
  decision: Decision
  reason: string
  digest: string
  /** Resolvido pelo SERVIDOR a partir dos argumentos — nunca rótulo do modelo. */
  summary: string
}

/** O desfecho de uma chamada que o portão deixou passar. */
export interface ActionOutcomeEvent {
  sessionId: string
  turn: string
  callId: string
  tool: string
  ok: boolean
  error?: string
  elapsedMs: number
  artifactRef?: string
  rawBytes?: number
  truncated?: boolean
}

declare module '@aibot2/harness-kernel' {
  interface Context {
    actionGateway: ActionGatewayService
  }
  interface Events {
    /** Sai para TODO veredito — inclusive deny (a recusa também é observável). */
    'action.decision'(event: ActionDecisionEvent): void
    'action.succeeded'(event: ActionOutcomeEvent): void
    /** Recusa (portão ou pessoa) e falha da ferramenta: para a régua da Equipe, tudo falha. */
    'action.failed'(event: ActionOutcomeEvent): void
  }
}

/* ------------------------------ whitelist UI ------------------------------ */

/**
 * O que a INTERFACE pode pedir por conta própria — porte do uiAllowedTools do
 * oráculo, as MESMAS 9 ferramentas. A lista é FECHADA e menor que o catálogo
 * de propósito: o funil de permissão decide COMO uma ferramenta roda, mas não
 * decide QUEM tem o direito de iniciá-la. Ferramenta de processo, rede,
 * segredo e commit NÃO entram aqui, nem com aprovação: um XSS na webview
 * viraria execução a um clique apertado no automático — quem precisa delas
 * fala com o modelo, que é o caminho auditável.
 */
export const UI_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'fs.read', 'fs.list', 'fs.search',
  'fs.write', 'fs.patch',
  'git.status', 'git.diff',
  'flow.validate', 'context.fetch',
])

/** A lista em ordem estável — a recusa cita o que É permitido. */
export function uiAllowedList(): string {
  return [...UI_ALLOWED_TOOLS].sort().join(', ')
}

/**
 * Atende a sessão que ainda não tem modo. O padrão do roteador é o "chat",
 * mas ele não tem ferramenta de arquivo nenhuma — cair nele faria a árvore de
 * arquivos nascer morta justamente na conversa recém-criada.
 */
export const UI_FALLBACK_SPECIALIST = 'code'

/* ------------------------------ configuração ------------------------------ */

export interface ActionGatewayConfig {
  store: StorageDriver
  tools: ToolExecutor
  directory: SpecialistDirectory
  /**
   * O Artifact Store. Ausente, o funil ainda projeta — mas o integral se
   * perde ("só esta projeção existe"), como o Store nil do oráculo.
   */
  artifacts?: ArtifactStore
  /**
   * A política DECLARADA, como dado cru (arquivo, rede). Ausente (ou
   * `undefined`) = DefaultPolicy; presente e ILEGÍVEL = deny em tudo até
   * alguém corrigi-la. Nunca default silencioso — a memória da casa "política
   * declarada e não lida" já custou três incidentes.
   */
  policy?: unknown
  /** Só para teste: o prazo da decisão humana. Produção usa o padrão de 10 min. */
  approvalTimeoutMs?: number
}

/* -------------------------------- o serviço ------------------------------- */

interface Waiter {
  settled: boolean
  resolve(decision: ApprovalDecision): void
}

export class ActionGatewayService extends Service {
  /** O portão, exposto para a superfície de política (SetPolicy/Granted/Revoke). */
  readonly gate: Gate
  /** O store de artefatos, exposto para o context.fetch (E6) ler fatias. */
  readonly artifacts: ArtifactStore | undefined
  readonly #store: StorageDriver
  readonly #tools: ToolExecutor
  readonly #approvalTimeoutMs: number
  readonly #waiting = new Map<string, Waiter>()
  #counter = 0

  constructor(ctx: Context, config: ActionGatewayConfig) {
    super(ctx, 'actionGateway')
    this.#store = config.store
    this.#tools = config.tools
    this.artifacts = config.artifacts
    this.#approvalTimeoutMs = config.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
    this.gate = new Gate(defaultPolicy(), config.directory)
    if (config.policy !== undefined) {
      // O campo declarado é LIDO aqui, na montagem — ilegível envenena o
      // portão (deny em tudo) em vez de cair calado no default.
      this.gate.loadPolicy(config.policy)
    }
  }

  /* ------------------------------- o funil ------------------------------- */

  /**
   * Executa UMA chamada de ferramenta pelo caminho completo:
   * tool.call (auditoria ANTES do efeito) → portão → aprovação humana durável
   * quando o veredito pede → efeito → projeção → tool.result (a segunda linha:
   * sucedeu/falhou). A ordem dos envelopes é a da fixture
   * sessions/ferramenta-aprovada — é ela que a suíte de compat confere.
   */
  async execute(request: ActionRequest): Promise<ActionResult> {
    const tool = request.tool.trim()
    if (tool === '') {
      // Bloco com JSON inválido é assunto do parser de cerca (E6) — aqui uma
      // chamada sem ferramenta é engano de chamador, e engano faz barulho.
      throw new TypeError('action-gateway: chamada sem ferramenta — nada para decidir')
    }
    const sessionId = request.sessionId
    const specialistId = request.specialistId.trim()
    const turn = request.turn ?? this.#nextId('t')
    const callId = this.#nextId('c')
    const rawArgs =
      request.rawArgs ?? (request.args === undefined ? '' : JSON.stringify(request.args))
    const actor: Actor =
      request.actor ?? { kind: 'specialist', id: specialistId, specialist: specialistId }

    // O digest carrega o ESCOPO (projeto+especialista), não só tool+args —
    // ver digestOf. O MESMO valor viaja no tool.call e no approval.request:
    // é a igualdade dos dois lados do portão que o aceite E4 exige.
    const digest = digestOf(approvalScope(await this.#sessionCwd(sessionId), specialistId), tool, rawArgs)
    const risk = riskOf(tool)
    const subject: IntentSubject = { tool }
    if (request.key !== undefined) subject.key = request.key
    if (request.mcp !== undefined) subject.mcp = request.mcp
    const intent = normalizeIntent(subject)
    // Resolvido AQUI, dos argumentos crus — um rótulo que viesse na chamada
    // não é lido: alvo dito pelo modelo é teatro (govern() do openbot).
    const summary = summarize(tool, rawArgs)

    // A primeira linha da auditoria: o pedido do modelo é registrado ANTES de
    // o portão decidir — mesmo que a execução venha a ser recusada (invariante
    // da fixture). A escrita é aguardada: sem registro, nada anda.
    const callPayload: ToolCall = { callId, tool, digest }
    if (request.args !== undefined) callPayload.args = request.args
    await this.#append(sessionId, turn, 'tool.call', actor, callPayload)

    const verdict = this.gate.evaluate(specialistId, tool, risk, digest)
    this.ctx.emit('action.decision', {
      sessionId, turn, callId, tool, intent, risk,
      decision: verdict.decision, reason: verdict.reason, digest, summary,
    })

    if (verdict.decision === 'deny') {
      await this.#toolResult(sessionId, turn, actor, callId, tool, verdict.reason, 0)
      this.#failed(sessionId, turn, callId, tool, verdict.reason, 0)
      return {
        callId, turn, decision: 'deny', ok: false, error: verdict.reason,
        text: `RECUSADO (${tool}): ${verdict.reason}`,
      }
    }

    if (verdict.decision === 'ask') {
      const asked = await this.#askApproval(
        sessionId, turn, actor, callId, specialistId, tool, rawArgs, risk, digest, request.signal,
      )
      if (!asked.allowed) {
        await this.#toolResult(sessionId, turn, actor, callId, tool, asked.why, 0)
        this.#failed(sessionId, turn, callId, tool, asked.why, 0)
        return {
          callId, turn, decision: 'ask', ok: false, error: asked.why,
          text: `RECUSADO PELO USUÁRIO (${tool}): ${asked.why}`,
        }
      }
    }

    // Só AQUI o efeito acontece — depois da decisão do portão (e da pessoa,
    // quando o risco pediu) já estar durável no log.
    const started = Date.now()
    let output: string
    try {
      output = await this.#tools.call(sessionId, tool, request.args)
    } catch (error) {
      const elapsed = Date.now() - started
      const message = error instanceof Error ? error.message : String(error)
      await this.#toolResult(sessionId, turn, actor, callId, tool, message, elapsed)
      this.#failed(sessionId, turn, callId, tool, message, elapsed)
      return {
        callId, turn, decision: verdict.decision, ok: false, error: message,
        elapsedMs: elapsed, text: `ERRO em ${tool}: ${message}`,
      }
    }
    const elapsed = Date.now() - started

    // O TOOL OUTPUT GATEWAY: a saída grande vira artefato integral +
    // projeção início/fim. É a projeção que entra no LOG e volta ao modelo.
    const projection = await projectToolOutput(this.artifacts, sessionId, tool, output)
    const projected = truncate(projection.projected, 20000)
    const resultPayload: ToolResult = { callId, tool, ok: true, elapsedMs: elapsed }
    if (projected !== '') resultPayload.output = projected
    if (projection.truncated) resultPayload.truncated = true
    if (projection.ref !== '') resultPayload.artifactRef = projection.ref
    if (projection.rawBytes > 0) resultPayload.rawBytes = projection.rawBytes
    await this.#append(sessionId, turn, 'tool.result', actor, resultPayload)

    const succeeded: ActionOutcomeEvent = {
      sessionId, turn, callId, tool, ok: true, elapsedMs: elapsed,
    }
    if (projection.ref !== '') succeeded.artifactRef = projection.ref
    if (projection.rawBytes > 0) succeeded.rawBytes = projection.rawBytes
    if (projection.truncated) succeeded.truncated = true
    this.ctx.emit('action.succeeded', succeeded)

    const result: ActionResult = {
      callId, turn, decision: verdict.decision, ok: true,
      output: projected, elapsedMs: elapsed, text: `${tool} =>\n${projected}`,
    }
    if (projection.ref !== '') result.artifactRef = projection.ref
    if (projection.rawBytes > 0) result.rawBytes = projection.rawBytes
    if (projection.truncated) result.truncated = true
    return result
  }

  /* ------------------------- aprovação humana ---------------------------- */

  /**
   * Entrega a decisão humana à chamada que espera. Segunda decisão para o
   * mesmo pedido é ruído (dois cliques, duas janelas) — ignorada; decisão
   * para pedido que ninguém espera é engano, e engano faz barulho.
   */
  decide(decision: ApprovalDecision): void {
    const waiter = this.#waiting.get(decision.callId)
    if (!waiter) {
      throw new Error(`nenhuma aprovação pendente para ${decision.callId}`)
    }
    if (waiter.settled) return
    waiter.settled = true
    waiter.resolve(decision)
  }

  /**
   * Os pedidos de aprovação SEM decisão e SEM desfecho, lidos do LOG — é isto
   * que faz o pedido REAPARECER depois de um reinício (aceite E4: a aprovação
   * é durável, não um canal em memória). Um pedido some da lista quando o log
   * ganha o approval.decision dele ou o tool.result (o timeout recusa por
   * tool.result, então prazo estourado também não reaparece).
   */
  async pendingApprovals(sessionId: string): Promise<PendingApproval[]> {
    const pending = new Map<string, PendingApproval>()
    let from = 0
    for (;;) {
      const batch = await this.#store.since(sessionId, from, MAX_EVENT_BATCH)
      if (batch.length === 0) break
      for (const envelope of batch) {
        from = envelope.seq
        if (envelope.kind === 'approval.request') {
          const payload = envelope.payload as ApprovalRequest | undefined
          if (payload?.callId) {
            pending.set(payload.callId, { turn: envelope.turn ?? '', request: payload })
          }
        } else if (envelope.kind === 'approval.decision' || envelope.kind === 'tool.result') {
          const payload = envelope.payload as { callId?: string } | undefined
          if (payload?.callId) pending.delete(payload.callId)
        }
      }
      if (batch.length < MAX_EVENT_BATCH) break
    }
    return [...pending.values()]
  }

  /** Publica o pedido e espera a decisão humana. */
  async #askApproval(
    sessionId: string,
    turn: string,
    actor: Actor,
    callId: string,
    specialistId: string,
    tool: string,
    rawArgs: string,
    risk: Risk,
    digest: string,
    signal: AbortSignal | undefined,
  ): Promise<{ allowed: boolean; why: string }> {
    // O canal entra no mapa ANTES de o pedido ir ao log: a decisão pode chegar
    // durante o próprio await do append (o mesmo motivo do Go registrar o
    // channel antes do emit).
    let resolveDecision!: (decision: ApprovalDecision) => void
    const decided = new Promise<ApprovalDecision>((resolve) => {
      resolveDecision = resolve
    })
    this.#waiting.set(callId, { settled: false, resolve: resolveDecision })

    try {
      const requestPayload: ApprovalRequest = {
        callId, tool, risk,
        summary: summarize(tool, rawArgs),
        detail: truncate(rawArgs, 2000),
        digest,
      }
      await this.#append(sessionId, turn, 'approval.request', actor, requestPayload)

      type Outcome =
        | { kind: 'decision'; decision: ApprovalDecision }
        | { kind: 'timeout' }
        | { kind: 'cancelled' }
      const outcome = await new Promise<Outcome>((resolve) => {
        const onAbort = (): void => {
          clearTimeout(timer)
          resolve({ kind: 'cancelled' })
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ kind: 'timeout' })
        }, this.#approvalTimeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        void decided.then((decision) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve({ kind: 'decision', decision })
        })
      })

      if (outcome.kind === 'timeout') {
        // Silêncio NÃO é consentimento.
        return { allowed: false, why: 'ninguém decidiu dentro do prazo — a execução foi recusada por segurança' }
      }
      if (outcome.kind === 'cancelled') {
        return { allowed: false, why: 'o turno foi cancelado antes da decisão' }
      }

      // A decisão vira ENVELOPE DURÁVEL antes de qualquer efeito. Sem ela o
      // log ficava tool.call → approval.request → tool.result(ok) e, lendo
      // depois, não dava para distinguir "a pessoa autorizou" de "a política
      // deixava passar" — sumia o registro do último degrau antes do efeito.
      const decision = outcome.decision
      const decisionPayload: ApprovalDecision = { callId, allow: decision.allow }
      if (decision.scope !== undefined) decisionPayload.scope = decision.scope
      if (decision.comment !== undefined) decisionPayload.comment = decision.comment
      await this.#append(sessionId, turn, 'approval.decision', { kind: 'user' }, decisionPayload)

      if (decision.allow) {
        this.gate.grant(decision.scope ?? '', specialistId, tool, digest)
        return { allowed: true, why: '' }
      }
      const comment = decision.comment?.trim() ?? ''
      return { allowed: false, why: comment !== '' ? comment : 'a pessoa recusou a execução' }
    } finally {
      this.#waiting.delete(callId)
    }
  }

  /* ------------------------------ o caminho da UI ------------------------- */

  /**
   * Executa UMA ferramenta a pedido da interface, fora do turno — porte do
   * CallToolFromUI do oráculo. A rota é só MAIS UM CHAMADOR do mesmo funil:
   * mesmo portão, mesmos envelopes. Recusa de whitelist, recusa do portão,
   * recusa humana e falha da ferramenta voltam DENTRO do UIToolResult; só
   * infraestrutura (sessão inexistente, log que não grava) vira exceção.
   */
  async callToolFromUI(sessionId: string, tool: string, rawArgs: string): Promise<UIToolResult> {
    tool = tool.trim()
    if (tool === '') {
      return { ok: false, error: 'faltou o nome da ferramenta em "tool"' }
    }

    // A whitelist vem ANTES de qualquer coisa — inclusive de abrir a sessão.
    // E a recusa NÃO deixa envelope: o pedido nem chegou ao funil, é violação
    // do contrato da rota, não decisão de política. Se a recusa fosse logada,
    // a UI teria um jeito de encher o log sem passar por portão nenhum.
    if (!UI_ALLOWED_TOOLS.has(tool)) {
      return {
        ok: false,
        error:
          `a interface não pode pedir ${tool} fora do turno — ` +
          `as ferramentas liberadas para a UI são: ${uiAllowedList()}`,
      }
    }

    const session = await this.#store.getSession(sessionId)
    // O especialista avaliado é o DA SESSÃO: é o catálogo dele que o portão
    // confere, e é ao par (projeto, especialista) dele que um "aprovar
    // sempre" fica preso — o mesmo escopo do turno.
    const specialistId = session.specialist?.trim() || UI_FALLBACK_SPECIALIST

    // Marca de onde começa a fatia nova do log — é dela que o desfecho é
    // lido depois (ver #uiOutcome).
    const before = await this.#store.lastSeq(sessionId)

    // Um id de turno próprio ("ui-…"): isto não é turno de conversa — não
    // disputa com o modelo; o id existe porque todo envelope carrega um, e é
    // por ele que a tela agrupa o que esta chamada produziu.
    const turn = this.#nextId('ui')

    let args: unknown
    const trimmed = rawArgs.trim()
    if (trimmed !== '') {
      try {
        args = JSON.parse(trimmed)
      } catch {
        // JSON quebrado vira digest do cru mesmo; o executor decide o que
        // fazer com args ausentes — o funil não conserta pedido da UI.
      }
    }

    // O ator é a PESSOA agindo pela interface — não o especialista. É o que a
    // auditoria precisa distinguir: "o modelo pediu" e "a UI pediu" são
    // origens diferentes do mesmo funil.
    const request: ActionRequest = {
      sessionId, turn, specialistId, tool, rawArgs,
      actor: { kind: 'user', id: 'ui', specialist: specialistId },
    }
    if (args !== undefined) request.args = args
    const result = await this.execute(request)

    // O desfecho é lido do LOG, não deduzido do texto: o envelope tool.result
    // é o contrato do protocolo, enquanto o texto do execute é frase para
    // modelo ler — parseá-la acoplaria a rota a uma redação.
    const outcome = await this.#uiOutcome(sessionId, before, turn)
    if (outcome !== undefined) return outcome
    // Sem envelope só há uma explicação: o log recusou a escrita. Uma
    // execução sem rastro não pode voltar como sucesso numa rota que existe
    // para ser auditável — falha alto, com o texto cru para o diagnóstico.
    throw new Error(`a execução não deixou registro no log da sessão: ${truncate(result.text, 300)}`)
  }

  /** Procura na fatia nova do log o tool.result do turno desta chamada. */
  async #uiOutcome(sessionId: string, from: number, turn: string): Promise<UIToolResult | undefined> {
    for (;;) {
      const batch = await this.#store.since(sessionId, from, MAX_EVENT_BATCH)
      if (batch.length === 0) return undefined
      for (const envelope of batch) {
        from = envelope.seq
        if (envelope.kind !== 'tool.result' || envelope.turn !== turn) continue
        const payload = envelope.payload as ToolResult
        let output = payload.output ?? ''
        // A INTERFACE recebe o INTEGRAL, nunca a projeção: a projeção no
        // editor seria um arquivo CORROMPIDO E SALVÁVEL — fs.read de 200 KB
        // abriria picotado e o Ctrl+S gravaria o picote por cima do arquivo
        // real. O integral já está no Artifact Store (o gateway o guardou ao
        // projetar); daqui ele volta inteiro.
        if (payload.ok && payload.truncated) {
          if (!payload.artifactRef) {
            return {
              ok: false,
              error:
                'a saída passou do teto e o artefato integral não pôde ser ' +
                'guardado — rode de novo ou peça um trecho menor',
            }
          }
          if (this.artifacts === undefined) {
            return {
              ok: false,
              error: 'a saída integral não pôde ser lida do artefato: este gateway subiu sem Artifact Store',
            }
          }
          try {
            const slice = await this.artifacts.read(sessionId, payload.artifactRef, 0, payload.rawBytes ?? 0)
            output = slice.chunk
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { ok: false, error: `a saída integral não pôde ser lida do artefato: ${message}` }
          }
        }
        const out: UIToolResult = { ok: payload.ok }
        if (output !== '') out.output = output
        if (payload.error !== undefined && payload.error !== '') out.error = payload.error
        return out
      }
      if (batch.length < MAX_EVENT_BATCH) return undefined
    }
  }

  /* ------------------------------- miudezas ------------------------------- */

  /**
   * A raiz do projeto da sessão, para o escopo do digest. Sessão que não
   * existe (ou store que falhou a leitura) cai em "sem raiz" — o
   * approvalScope traduz para a marca fixa "sem-projeto", como o oráculo.
   */
  async #sessionCwd(sessionId: string): Promise<string | undefined> {
    try {
      const meta = await this.#store.getSession(sessionId)
      return meta.cwd
    } catch {
      return undefined
    }
  }

  /** A segunda linha da auditoria quando o desfecho é recusa ou falha. */
  async #toolResult(
    sessionId: string,
    turn: string,
    actor: Actor,
    callId: string,
    tool: string,
    failure: string,
    elapsedMs: number,
  ): Promise<void> {
    const payload: ToolResult = { callId, tool, ok: false, elapsedMs }
    if (failure !== '') payload.error = failure
    await this.#append(sessionId, turn, 'tool.result', actor, payload)
  }

  #failed(sessionId: string, turn: string, callId: string, tool: string, error: string, elapsedMs: number): void {
    this.ctx.emit('action.failed', { sessionId, turn, callId, tool, ok: false, error, elapsedMs })
  }

  async #append(
    sessionId: string,
    turn: string,
    kind: 'tool.call' | 'tool.result' | 'approval.request' | 'approval.decision',
    from: Actor,
    payload: unknown,
  ): Promise<void> {
    await this.#store.append(sessionId, { id: this.#nextId('e'), turn, kind, from, payload })
  }

  /** Ids na MESMA forma do oráculo (prefixo-epoch-contador) — legíveis no log. */
  #nextId(prefix: string): string {
    return `${prefix}-${Date.now()}-${++this.#counter}`
  }
}
