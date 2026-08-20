/**
 * O master: decide QUEM atende. A regra de produto: A CONVERSA TEM UM MODO,
 * decidido no PRIMEIRO input e gravado nela — da segunda mensagem em diante
 * não há classificação nenhuma. Reclassificar a cada linha custa latência,
 * lê "agora corrija o login" como pedido isolado e troca a tela debaixo de
 * quem trabalha. Só `/mode` e o seletor trocam o modo de uma conversa viva.
 *
 * No primeiro input, a decisão desce a CASCATA e o barato vem primeiro:
 * FAST ROUTER (léxico, ~µs, offline) → NEEDLE (modelo local, ~ms, offline,
 * via seam OrchestratorModel) → LLM (rede, ~s, via seam Classifier). Os dois
 * degraus de IA podem faltar e a cascata encurta sozinha — degradação, não
 * falha: o app precisa abrir numa estação sem modelo e sem rede.
 *
 * Este plugin é CÉREBRO, não autoridade (spec §6): daqui saem decisões
 * validadas — nunca um efeito. Ele não conhece Docker, não escolhe worker,
 * não promove nada; quem executa é o control plane, atrás do action-gateway.
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@aibot2/harness-kernel'
import { DEFAULT_ID, MASTER_ID, type Definition, type SpecialistRegistry } from '@aibot2/specialist-registry'
import { combineAttachments } from './attachments.js'
import { cast, type Standby } from './cast.js'
import {
  FALLBACK_CONFIDENCE,
  MIN_CONFIDENCE,
  MIN_MARGIN,
  NEEDLE_MIN_CONFIDENCE,
  NEEDLE_TOOL_BUDGET,
  ORCHESTRATE_MAX_ATTEMPTS,
} from './constants.js'
import { validateDecision, type OrchestratorDecision } from './decision.js'
import { intentOf, INTENT_QUESTION } from './intent.js'
import { score as lexicalScore, soleDeliverable, type Scored, type TriggerLookup } from './score.js'
import type { Classifier, OrchestratorModel, OrchestratorQuery } from './seams.js'
import { goTrimSpace, indexOfSpace, normalize } from './text.js'

declare module '@aibot2/harness-kernel' {
  interface Context {
    router: RouterService
  }
}

/** COMO a rota foi decidida — a UI mostra ao passar o mouse no ícone. */
export type RouteReason = 'explicit' | 'heuristic' | 'needle' | 'model' | 'sticky' | 'fallback'

/** A decisão do master para uma linha da conversa. */
export interface Route {
  specialist: string
  previous: string
  reason: RouteReason
  confidence: number
  /**
   * A superfície viaja junto porque a troca de especialista e a troca de tela
   * são o MESMO evento — separá-las deixa a tela um quadro atrás do ícone.
   */
  surface: string
  signals: string[]
  standby: Standby[]
}

/** Tudo o que a decisão considera. */
export interface RouteInput {
  /** O prompt cru da pessoa (ainda com o `/mode`, se houver). */
  text: string
  /** O especialista escolhido na mão pelo seletor da interface. */
  explicit?: string
  /** O modo JÁ GRAVADO na conversa. Preenchido = nada mais é classificado. */
  current?: string
  /** Limita os candidatos ao que a política liberou. Vazio = todos. */
  allowed?: readonly string[]
  /**
   * NOMES dos anexos — só a extensão importa, e só no PRIMEIRO input: anexo
   * em conversa com modo não reclassifica nada.
   */
  attachments?: readonly string[]
}

export interface ParsedModeCommand {
  mode: string
  rest: string
  ok: boolean
}

export interface RouterConfig {
  /** O degrau local. Ausente ou não-pronto = a cascata pula, sem erro. */
  needle?: OrchestratorModel
  /** O degrau do modelo grande. Ausente = léxico → fallback. */
  classifier?: Classifier
  /**
   * Instrumentação de TESTE: substitui o scorer léxico. Existe para o aceite
   * do sticky ("nenhum scorer é chamado") ser uma asserção, não uma fé.
   */
  scoreFn?: (text: string, candidates: readonly Definition[], lookup: TriggerLookup) => Scored[]
}

/**
 * Cache do catálogo do jeito que o roteador precisa: a fatia de candidatos
 * materializada e os radicais já normalizados. Reconstruído no onChange do
 * registro — cache que não é reconstruído na troca faz o roteador decidir
 * pelo catálogo velho enquanto a tela mostra o novo.
 */
interface RouterCatalog {
  candidates: readonly Definition[]
  normalized: ReadonlyMap<string, string>
}

export class RouterService extends Service {
  static readonly inject: readonly string[] = ['specialists']

  private readonly registry: SpecialistRegistry
  private readonly needle: OrchestratorModel | undefined
  private readonly classifier: Classifier | undefined
  private readonly scoreFn: (text: string, candidates: readonly Definition[], lookup: TriggerLookup) => Scored[]
  private cache!: RouterCatalog

  constructor(ctx: Context, config: RouterConfig = {}) {
    super(ctx, 'router')
    this.registry = ctx.specialists
    this.needle = config.needle
    this.classifier = config.classifier
    this.scoreFn = config.scoreFn ?? ((text, candidates, lookup) => lexicalScore(text, candidates, lookup))
    this.rebuildCache()
    // O gancho morre com o plugin: unload do roteador não deixa um cache
    // órfão sendo reconstruído para ninguém.
    ctx.effect(() => this.registry.onChange(() => this.rebuildCache()), 'router:cache-do-catalogo')
  }

  /* ------------------------------ /mode ---------------------------------- */

  /**
   * Extrai o `/mode <id>` do início do texto. O comando vale sozinho ou com o
   * pedido na mesma linha. Corta no primeiro ESPAÇO EM BRANCO, não no literal
   * " ": quem aperta Shift+Enter depois do id mandava "office\ncorrige" como
   * candidato — e a troca simplesmente não acontecia, sem aviso. Modo
   * inexistente NÃO é comando: fica texto e o master trata como pergunta.
   */
  parseModeCommand(text: string): ParsedModeCommand {
    const trimmed = goTrimSpace(text)
    if (!trimmed.startsWith('/mode')) return { mode: '', rest: text, ok: false }
    const after = goTrimSpace(trimmed.slice('/mode'.length))
    if (after === '') return { mode: '', rest: text, ok: false }
    let candidate = after
    let remainder = ''
    const index = indexOfSpace(after)
    if (index >= 0) {
      candidate = after.slice(0, index)
      remainder = after.slice(index)
    }
    candidate = goTrimSpace(candidate).toLowerCase()
    if (!this.registry.exists(candidate) || candidate === MASTER_ID) {
      return { mode: '', rest: text, ok: false }
    }
    return { mode: candidate, rest: goTrimSpace(remainder), ok: true }
  }

  /* ------------------------------ rota ----------------------------------- */

  /**
   * Decide quem atende E monta o elenco de apoio. O elenco é só do PRIMEIRO
   * input: a conversa que já tem dono já tem elenco, e recalculá-lo a cada
   * mensagem trocaria a barra lateral debaixo de quem está trabalhando.
   */
  async route(input: RouteInput): Promise<Route> {
    const decided = await this.decide(input)
    if (decided.reason === 'sticky') return decided

    let text = input.text
    const parsed = this.parseModeCommand(input.text)
    if (parsed.ok) text = parsed.rest
    // Pergunta não tem elenco: o elenco é o formato de um PLANO, e uma dúvida
    // não produz artefato para ninguém trabalhar em cima.
    if (intentOf(normalize(text)) === INTENT_QUESTION) return decided
    const candidates = this.candidatesFor(input.allowed)
    decided.standby = cast(
      text,
      decided.specialist,
      this.score(text, candidates),
      candidates,
      (id) => this.registry.getOrDefault(id),
    )
    return decided
  }

  /** A cascata: explícito → sticky → anexo → léxico → local → modelo. */
  private async decide(input: RouteInput): Promise<Route> {
    const candidates = this.candidatesFor(input.allowed)
    const previous = input.current ?? ''
    if (candidates.length === 0) {
      return this.decorate(this.blank(DEFAULT_ID, previous, 'fallback', 0))
    }

    let text = input.text
    let explicit = input.explicit ?? ''
    // `/mode` vence o seletor: é a escolha mais recente e a mais deliberada.
    let denied = ''
    const parsed = this.parseModeCommand(input.text)
    if (parsed.ok) {
      if (allowedContains(candidates, parsed.mode)) {
        explicit = parsed.mode
        text = parsed.rest
      } else {
        // O modo existe no catálogo mas a POLÍTICA o barra. O comando é
        // reconhecido e RECUSADO com sinal: o modo não troca, e o pedido que
        // veio junto NÃO é esvaziado — descer a cascata com prompt vazio
        // gastava o Needle e o modelo para classificar nada.
        denied = parsed.mode
        text = parsed.rest
      }
    }

    if (denied !== '') {
      const blocked = `modo ${denied} bloqueado pela política desta sessão`
      // Com dono, a conversa fica onde está.
      if (previous !== '' && allowedContains(candidates, previous)) {
        const route = this.blank(previous, previous, 'sticky', 1)
        route.signals = [blocked]
        return this.decorate(route)
      }
      // Sem dono E sem pedido junto, não há o que classificar.
      if (goTrimSpace(text) === '') {
        const route = this.blank((candidates[0] as Definition).id, previous, 'fallback', 0)
        route.signals = [blocked]
        return this.decorate(route)
      }
      // Sobrou pedido de verdade numa conversa sem dono: a cascata decide
      // pelo conteúdo, como decidiria se o `/mode` não tivesse sido escrito.
    }

    // --- escolha explícita ---
    if (explicit !== '' && allowedContains(candidates, explicit)) {
      return this.decorate(this.blank(explicit, previous, 'explicit', 1))
    }

    // --- a conversa JÁ TEM modo ---
    // O caminho de quase toda mensagem, e ele custa zero: nada é pontuado,
    // nenhum modelo é chamado, nem o local.
    if (previous !== '' && allowedContains(candidates, previous)) {
      return this.decorate(this.blank(previous, previous, 'sticky', 1))
    }

    // A partir daqui é o PRIMEIRO input da conversa. Só ele desce a cascata.

    // --- degrau 1: fast router ---
    let scores = this.score(text, candidates)

    // Anexo entra ANTES do limiar léxico: um anexo decisivo encerra aqui; um
    // empate entre formatos segue a cascata levando o ranking combinado.
    if ((input.attachments?.length ?? 0) > 0) {
      const { combined, decisive } = combineAttachments(scores, input.attachments as readonly string[], candidates)
      if (decisive) {
        const top = combined[0] as Scored
        const route = this.blank(top.id, previous, 'heuristic', top.confidence)
        route.signals = top.signals
        return this.decorate(route)
      }
      scores = combined
    }

    // PERGUNTA não vira modo de trabalho: o custo do engano não é uma
    // resposta ruim — o modo fica GRAVADO e tudo que vier depois vai para o
    // executor errado. Vem antes do entregável e do limiar de propósito: os
    // dois olham ASSUNTO, e assunto é justamente o que engana aqui.
    if (intentOf(normalize(text)) === INTENT_QUESTION && allowedContains(candidates, DEFAULT_ID)) {
      const route = this.blank(DEFAULT_ID, previous, 'heuristic', MIN_CONFIDENCE)
      route.signals = ['pergunta, não pedido']
      return this.decorate(route)
    }

    // Dono ÚNICO do entregável decide sozinho, sem precisar de margem. A
    // confiança relatada tem PISO no limiar — quem decidiu foi a regra, não a
    // contagem de radicais; publicar 0,31 numa rota firme contaria uma
    // história que o código não viveu.
    const owner = soleDeliverable(scores)
    if (owner !== undefined) {
      const route = this.blank(owner.id, previous, 'heuristic', Math.max(owner.confidence, MIN_CONFIDENCE))
      route.signals = owner.signals
      return this.decorate(route)
    }

    if (scores.length > 0) {
      const top = scores[0] as Scored
      const runnerUp = scores.length > 1 ? (scores[1] as Scored).confidence : 0
      if (top.confidence >= MIN_CONFIDENCE && top.confidence - runnerUp >= MIN_MARGIN) {
        const route = this.blank(top.id, previous, 'heuristic', top.confidence)
        route.signals = top.signals
        return this.decorate(route)
      }
    }

    // --- degrau 2: Needle, na máquina ---
    if (this.needle !== undefined && this.needle.ready()) {
      const shortlist = shortlistFor(scores, candidates, NEEDLE_TOOL_BUDGET)
      try {
        const verdict = await this.needle.route({
          prompt: text,
          intent: intentOf(normalize(text)),
          candidates: shortlist,
        })
        // A resposta é conferida contra os candidatos: processo de terceiro
        // não escolhe quem a política não liberou. E o limiar é `>=`: um
        // veredito exatamente em 0.78 é aceito.
        if (allowedContains(candidates, verdict.specialist) && verdict.confidence >= NEEDLE_MIN_CONFIDENCE) {
          return this.decorate(this.blank(verdict.specialist, previous, 'needle', verdict.confidence))
        }
      } catch {
        // Erro do degrau local não derruba a decisão: sobe para o modelo
        // grande. A peça mais frágil da cascata não vira falha do turno.
      }
    }

    // --- degrau 3: o modelo grande ---
    if (this.classifier !== undefined) {
      try {
        const verdict = await this.classifier.classify(text, candidates)
        if (allowedContains(candidates, verdict.specialist)) {
          let confidence = verdict.confidence
          if (confidence <= 0 || confidence > 1) {
            // Modelo que devolve confiança fora da faixa não derruba o turno;
            // só não merece que se acredite no número dele.
            confidence = MIN_CONFIDENCE
          }
          return this.decorate(this.blank(verdict.specialist, previous, 'model', confidence))
        }
      } catch {
        // Sem rede/sem resposta: cai no padrão logo abaixo.
      }
    }

    let fallback = DEFAULT_ID
    if (!allowedContains(candidates, fallback)) {
      fallback = (candidates[0] as Definition).id
    }
    return this.decorate(this.blank(fallback, previous, 'fallback', FALLBACK_CONFIDENCE))
  }

  /* --------------------------- orquestração ------------------------------ */

  /**
   * O degrau de orquestração (spec §8): decisões incrementais sobre o Goal e
   * o Task Board. A saída do modelo é entrada NÃO CONFIÁVEL: inválida ganha
   * UM retry e depois vira fallback controlado (`ask_owner`) — nunca propaga
   * crua, e nunca vira erro ao usuário.
   */
  async orchestrate(query: OrchestratorQuery): Promise<OrchestratorDecision> {
    const executorExists = (id: string): boolean => id !== MASTER_ID && this.registry.exists(id)
    if (this.needle === undefined || !this.needle.ready()) {
      return this.fallbackDecision('o modelo orquestrador local não está disponível nesta estação')
    }
    let lastProblems: string[] = []
    for (let attempt = 1; attempt <= ORCHESTRATE_MAX_ATTEMPTS; attempt++) {
      let raw: unknown
      try {
        raw = await this.needle.orchestrate(query)
      } catch (error) {
        lastProblems = [`o modelo orquestrador falhou: ${(error as Error).message}`]
        break
      }
      const verdict = validateDecision(raw, executorExists)
      if (verdict.ok) return verdict.decision
      lastProblems = verdict.problems
    }
    return this.fallbackDecision(`a saída do orquestrador não passou no contrato: ${lastProblems.join('; ')}`)
  }

  private fallbackDecision(reason: string): OrchestratorDecision {
    return {
      decisionId: randomUUID(),
      mode: 'ask_owner',
      ownerRequest: {
        reason,
        expectedAction: 'reformule o objetivo ou escolha o especialista manualmente',
      },
      confidence: 0,
      rationaleSummary: 'fallback controlado do orquestrador — nenhuma saída de modelo foi propagada crua',
    }
  }

  /* ------------------------------ apoio ----------------------------------- */

  private blank(specialist: string, previous: string, reason: RouteReason, confidence: number): Route {
    return { specialist, previous, reason, confidence, surface: '', signals: [], standby: [] }
  }

  /** Preenche o que a tela precisa junto com a decisão. */
  private decorate(route: Route): Route {
    const definition = this.registry.getOrDefault(route.specialist)
    route.specialist = definition.id
    route.surface = definition.surface
    return route
  }

  private score(text: string, candidates: readonly Definition[]): Scored[] {
    return this.scoreFn(text, candidates, (raw) => this.cache.normalized.get(raw) ?? normalize(raw))
  }

  private rebuildCache(): void {
    const candidates = this.registry.all()
    const normalized = new Map<string, string>()
    for (const definition of candidates) {
      for (const trigger of definition.triggers) {
        if (normalized.has(trigger)) continue
        normalized.set(trigger, normalize(trigger))
      }
    }
    this.cache = { candidates, normalized }
  }

  private candidatesFor(allowed: readonly string[] | undefined): readonly Definition[] {
    const catalog = this.cache.candidates
    if (allowed === undefined || allowed.length === 0) return catalog
    const permitted = new Set(allowed)
    return catalog.filter((definition) => permitted.has(definition.id))
  }
}

function allowedContains(candidates: readonly Definition[], id: string): boolean {
  return candidates.some((definition) => definition.id === id)
}

/**
 * Os `limit` melhores segundo o fast router, completando com o resto do
 * catálogo quando o léxico não pontuou o bastante. Completar importa: se o
 * texto não casou com radical nenhum, o Needle receberia ZERO ferramentas —
 * decidindo nada, sempre. Sem pontuação sobra a ordem do catálogo, que é
 * fixa: o mesmo pedido não declara ferramentas diferentes a cada execução.
 */
export function shortlistFor(
  scores: readonly Scored[],
  candidates: readonly Definition[],
  limit: number,
): Definition[] {
  if (limit <= 0 || limit >= candidates.length) return [...candidates]
  const byID = new Map(candidates.map((definition) => [definition.id, definition]))

  const out: Definition[] = []
  const taken = new Set<string>()
  for (const scored of scores) {
    if (out.length >= limit) break
    const definition = byID.get(scored.id)
    if (definition !== undefined && !taken.has(scored.id)) {
      out.push(definition)
      taken.add(scored.id)
    }
  }
  for (const definition of candidates) {
    if (out.length >= limit) break
    if (!taken.has(definition.id)) {
      out.push(definition)
      taken.add(definition.id)
    }
  }
  return out
}
