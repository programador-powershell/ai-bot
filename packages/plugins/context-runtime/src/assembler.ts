/**
 * O Context Assembler: o working set que vai ao modelo.
 *
 * working set = system + cápsula + cauda recente verbatim + retrieved +
 * projeções de tool output. NUNCA o histórico bruto completo — o integral vive
 * no log e a cápsula é o destilado do que a janela não alcança.
 *
 * Duas regras carregam o desenho (as mesmas do fitToContext do oráculo, agora
 * com o fit ladder da spec E6 por cima):
 *
 *  1. mensagem `system` NUNCA é descartada — ela é a política do admin e os
 *     contratos; jogá-la fora para caber seria a saída barata da política;
 *  2. grupos ATÔMICOS nunca quebram: tool_call+tool_result (uma mensagem por
 *     construção), command+saída+exitCode (idem) e o par da delegação
 *     (groupId). Se não cabem, o GRUPO inteiro sai — e sai APENAS quando a
 *     cápsula já guarda a representação (itens ainda não dobrados voltam em
 *     `droppedUnabsorbed` para o chamador dobrar e remontar).
 *
 * O fit ladder degrada NA ORDEM da spec, do corte mais barato ao mais caro:
 * verbatim relevante → histórico absorvido → truncar projeções → passos
 * redundantes → retrieved → item recente menos importante → emergência
 * (NOTE_1). Cada degrau só roda se o anterior não bastou.
 */

import {
  approxTokens,
  truncateForContext,
  FLOOR_TOKENS,
  MIN_KEPT_MESSAGES,
  NOTE1_MAX_CHARS,
  type BudgetManager,
} from './budget.js'
import type { Capsule } from './capsule.js'
import type { ChatMessage, TailItem } from './history.js'

/* --------------------------------- degraus --------------------------------- */

export type LadderStep =
  | 'verbatim-relevante'
  | 'historico-absorvido'
  | 'truncar-projecoes'
  | 'passos-redundantes'
  | 'retrieved'
  | 'item-recente-menos-importante'
  | 'emergencia'

/** A ordem é CONTRATO (spec E6) — os testes a fixam. */
export const LADDER_ORDER: readonly LadderStep[] = [
  'verbatim-relevante',
  'historico-absorvido',
  'truncar-projecoes',
  'passos-redundantes',
  'retrieved',
  'item-recente-menos-importante',
  'emergencia',
]

/** Quanto sobra de cada projeção no degrau truncar-projecoes. */
export const PROJECTION_FIT_TOKENS = 200

/* --------------------------------- entrada --------------------------------- */

export interface AssemblyInput {
  /** Instruções fixas — nunca caem (política, contratos). */
  system: readonly string[]
  /** A cápsula da sessão — o render entra como system; ela é o para-quedas. */
  capsule: Capsule
  /** A cauda recente verbatim, já capada por tailFromEnvelopes. */
  tail: readonly TailItem[]
  /**
   * Contexto recuperado (memória, busca), em ordem de relevância DECRESCENTE
   * — o degrau `retrieved` descarta do fim (o menos relevante primeiro).
   */
  retrieved?: readonly string[]
  /** Injeções efêmeras do inbox (inject) — contexto do processo, uma vez só. */
  notes?: readonly string[]
  /**
   * Itens com seq > este valor são o TURNO ATUAL — relevantes por definição.
   * O degrau verbatim-relevante nunca os toca.
   */
  relevantFromSeq?: number
}

export interface Assembly {
  messages: ChatMessage[]
  /** Tokens estimados do prompt inteiro (CHARS_PER_TOKEN=4). */
  usedTokens: number
  /** Tokens do working set VARIÁVEL depois do fit (tudo menos os system fixos). */
  variableTokens: number
  /**
   * A DEMANDA variável ANTES do fit ladder — a régua da pressão do Budget
   * Manager. Medir o pós-fit esconderia o problema: o ladder sempre espreme
   * até caber, e a compactação preventiva existe para disparar ANTES de a
   * qualidade degradar por truncamento, não depois.
   */
  demandTokens: number
  /** Os degraus que efetivamente cortaram algo, na ordem em que rodaram. */
  stepsApplied: LadderStep[]
  /**
   * Seqs de grupos descartados que a cápsula ainda NÃO dobrou (seq > cursor).
   * Contrato: o chamador dobra a cápsula até cobri-los e remonta — é o que
   * garante "o grupo sai E a cápsula guarda a representação".
   */
  droppedUnabsorbed: number[]
  /** true = o degrau de emergência rodou (NOTE_1 no lugar do variável). */
  emergency: boolean
}

/* ---------------------------------- unidades -------------------------------- */

/** Um grupo atômico da cauda: entra e sai da janela INTEIRO. */
interface Unit {
  items: TailItem[]
  minSeq: number
  maxSeq: number
}

function buildUnits(tail: readonly TailItem[]): Unit[] {
  const units: Unit[] = []
  const byGroup = new Map<string, Unit>()
  for (const item of tail) {
    if (item.groupId === undefined) {
      units.push({ items: [item], minSeq: item.seq, maxSeq: item.seq })
      continue
    }
    const existing = byGroup.get(item.groupId)
    if (existing === undefined) {
      const unit: Unit = { items: [item], minSeq: item.seq, maxSeq: item.seq }
      byGroup.set(item.groupId, unit)
      units.push(unit)
      continue
    }
    existing.items.push(item)
    existing.minSeq = Math.min(existing.minSeq, item.seq)
    existing.maxSeq = Math.max(existing.maxSeq, item.seq)
  }
  // A ordem cronológica é a do minSeq: o grupo ancora onde começou.
  units.sort((a, b) => a.minSeq - b.minSeq)
  return units
}

function unitCost(unit: Unit): number {
  let cost = 0
  for (const item of unit.items) cost += approxTokens(item.content)
  return cost
}

/* --------------------------------- montagem -------------------------------- */

export function assemble(input: AssemblyInput, budget: BudgetManager): Assembly {
  const steps: LadderStep[] = []
  const droppedUnabsorbed: number[] = []
  const cursor = input.capsule.cursor
  const relevantFrom = input.relevantFromSeq ?? Number.MAX_SAFE_INTEGER

  const systems = input.system.filter((text) => text.trim() !== '')
  const systemsCost = systems.reduce((sum, text) => sum + approxTokens(text), 0)

  let capsuleText = input.capsule.render()
  const notes = [...(input.notes ?? [])].filter((text) => text.trim() !== '')
  let retrieved = [...(input.retrieved ?? [])].filter((text) => text.trim() !== '')
  let units = buildUnits(input.tail)
  let emergency = false

  const variableCost = (): number =>
    approxTokens(capsuleText) +
    notes.reduce((sum, text) => sum + approxTokens(text), 0) +
    retrieved.reduce((sum, text) => sum + approxTokens(text), 0) +
    units.reduce((sum, unit) => sum + unitCost(unit), 0)

  const fits = (): boolean => systemsCost + variableCost() <= budget.fitBudget

  // A demanda crua, medida ANTES de qualquer degrau — é ela que o Budget
  // Manager compara com soft/prefire/hard.
  const demandTokens = variableCost()

  /**
   * Descarta unidades que o predicado aceitar, da mais antiga à mais nova,
   * até caber — SEMPRE preservando as últimas MIN_KEPT_MESSAGES unidades (o
   * piso do fitToContext: sem ele uma colagem enorme engoliria a pergunta
   * atual). Grupo descartado ainda não dobrado vai para droppedUnabsorbed.
   */
  const dropWhile = (accept: (unit: Unit) => boolean): boolean => {
    let dropped = false
    while (!fits() && units.length > MIN_KEPT_MESSAGES) {
      const protectedFrom = units.length - MIN_KEPT_MESSAGES
      let index = -1
      for (let i = 0; i < protectedFrom; i++) {
        if (accept(units[i]!)) {
          index = i
          break
        }
      }
      if (index < 0) break
      const [unit] = units.splice(index, 1)
      if (unit!.maxSeq > cursor) droppedUnabsorbed.push(unit!.maxSeq)
      dropped = true
    }
    return dropped
  }

  /* degrau 1 — verbatim relevante: a cauda encolhe para o subconjunto
     relevante; o resto está no log (e, dobrado, na cápsula). */
  if (!fits()) {
    if (dropWhile((unit) => unit.maxSeq < relevantFrom)) steps.push('verbatim-relevante')
  }

  /* degrau 2 — histórico absorvido: o que a cápsula já dobrou não precisa
     viajar verbatim; reenviá-lo seria pagar duas vezes pela mesma memória. */
  if (!fits()) {
    if (dropWhile((unit) => unit.maxSeq <= cursor)) steps.push('historico-absorvido')
  }

  /* degrau 3 — truncar projeções: a evidência de ferramenta encolhe para
     head+fim com marca (o integral está no Artifact Store). Maiores primeiro:
     é onde cada corte rende mais. */
  if (!fits()) {
    const projections = units
      .flatMap((unit) => unit.items)
      .filter((item) => item.source === 'evidence')
      .sort((a, b) => b.content.length - a.content.length)
    let truncated = false
    for (const item of projections) {
      if (fits()) break
      const cut = truncateForContext(item.content, PROJECTION_FIT_TOKENS)
      if (cut.length < item.content.length) {
        item.content = cut
        truncated = true
      }
    }
    if (truncated) steps.push('truncar-projecoes')
  }

  /* degrau 4 — passos redundantes: evidência de uma ferramenta SUPERADA por
     evidência posterior da mesma ferramenta (o padrão rodou-de-novo). Só a
     última versão fica; as anteriores são história, e história mora no log. */
  if (!fits()) {
    const lastByTool = new Map<string, number>()
    for (const unit of units) {
      for (const item of unit.items) {
        if (item.source === 'evidence' && item.tool !== undefined) {
          lastByTool.set(item.tool, Math.max(lastByTool.get(item.tool) ?? 0, unit.maxSeq))
        }
      }
    }
    const redundant = (unit: Unit): boolean =>
      unit.items.some(
        (item) =>
          item.source === 'evidence' &&
          item.tool !== undefined &&
          (lastByTool.get(item.tool) ?? 0) > unit.maxSeq,
      )
    if (dropWhile(redundant)) steps.push('passos-redundantes')
  }

  /* degrau 5 — retrieved: o recuperado é sugestão, não estado; cai do menos
     relevante (o fim da lista) para o mais. */
  if (!fits() && retrieved.length > 0) {
    let droppedRetrieved = false
    while (!fits() && retrieved.length > 0) {
      retrieved.pop()
      droppedRetrieved = true
    }
    if (droppedRetrieved) steps.push('retrieved')
  }

  /* degrau 6 — item recente menos importante: o menos importante do que
     sobrou é o MAIS ANTIGO (o fim da conversa é a pergunta atual). Depois do
     piso, as unidades protegidas entram TRUNCADAS em vez de derrubar o turno
     — com FLOOR_TOKENS de garantia para a pergunta atual. */
  if (!fits()) {
    const droppedAny = dropWhile(() => true)
    let truncatedAny = false
    if (!fits() && units.length > 0) {
      const room = budget.fitBudget -
        systemsCost -
        approxTokens(capsuleText) -
        notes.reduce((sum, text) => sum + approxTokens(text), 0)
      const share = Math.max(Math.floor(room / units.length), FLOOR_TOKENS)
      // Duas passadas: a fatia proporcional e, se a marca do corte e o
      // arredondamento do medidor ainda estourarem (o corte ACRESCENTA a
      // marca ao texto), o piso — que é a garantia real do fitToContext.
      for (const target of share > FLOOR_TOKENS ? [share, FLOOR_TOKENS] : [FLOOR_TOKENS]) {
        for (const unit of units) {
          for (const item of unit.items) {
            const cut = truncateForContext(item.content, target)
            if (cut.length < item.content.length) {
              item.content = cut
              truncatedAny = true
            }
          }
        }
        if (fits()) break
      }
    }
    if (droppedAny || truncatedAny) steps.push('item-recente-menos-importante')
  }

  /* degrau 7 — emergência: nem o mínimo coube (system + cápsula grandes numa
     janela pequena). Tudo que é variável vira a NOTE_1 + a pergunta atual.
     system continua inteiro — system nunca cai. */
  if (!fits()) {
    emergency = true
    steps.push('emergencia')
    const question = lastUserQuestion(input.tail)
    for (const unit of units) {
      if (unit.maxSeq > cursor) droppedUnabsorbed.push(unit.maxSeq)
    }
    notes.length = 0
    retrieved = []
    const note = buildEmergencyNote(input.capsule, question)
    const room = Math.max(budget.fitBudget - systemsCost - approxTokens(note), FLOOR_TOKENS)
    units = question === ''
      ? []
      : [{
          items: [{ role: 'user', content: truncateForContext(question, room), seq: 0, source: 'message' }],
          minSeq: 0,
          maxSeq: 0,
        }]
    // A NOTE_1 assume o lugar do render da cápsula: mesmo estado, forma mínima.
    capsuleText = note
  }

  /* ------------------------------- remontagem ------------------------------ */

  const messages: ChatMessage[] = []
  for (const text of systems) messages.push({ role: 'system', content: text })
  if (capsuleText !== '') messages.push({ role: 'system', content: capsuleText })
  for (const text of notes) messages.push({ role: 'system', content: text })
  for (const text of retrieved) {
    messages.push({ role: 'system', content: 'Contexto recuperado (use se ajudar; ignore se não):\n' + text })
  }
  for (const unit of units) {
    for (const item of unit.items) messages.push({ role: item.role, content: item.content })
  }

  const usedTokens = messages.reduce((sum, message) => sum + approxTokens(message.content), 0)
  return {
    messages,
    usedTokens,
    variableTokens: usedTokens - systemsCost,
    demandTokens,
    stepsApplied: steps,
    droppedUnabsorbed: [...new Set(droppedUnabsorbed)].sort((a, b) => a - b),
    emergency,
  }
}

/* -------------------------------- emergência ------------------------------- */

/**
 * A NOTE_1: a nota de emergência (~12k chars) que substitui o working set
 * variável quando nem o fit ladder bastou. Carrega o que um agente sucessor
 * precisaria: objetivo, restrições, decisões, tarefas pendentes, arquivos,
 * erros, trabalho atual e próxima ação — a MESMA lista de estado crítico que
 * a validação da cápsula protege, porque é o mesmo estado.
 */
export function buildEmergencyNote(capsule: Capsule, currentQuestion: string): string {
  const out: string[] = []
  out.push(
    'NOTA DE EMERGÊNCIA (a janela do modelo estourou; este é o estado mínimo — ' +
      'o histórico integral vive no log e nos artefatos):',
  )
  if (capsule.goal !== '') out.push('OBJETIVO: ' + capsule.goal)
  if (capsule.constraints.length > 0) {
    out.push('RESTRIÇÕES (nunca violar):')
    for (const constraint of capsule.constraints) out.push('- ' + constraint)
  }
  if (capsule.decisions.length > 0) {
    out.push('DECISÕES:')
    for (const decision of capsule.decisions) {
      out.push('- ' + decision.decision + (decision.irreversible === true ? ' [irreversível]' : ''))
    }
  }
  if (capsule.pending.length > 0) {
    out.push('TAREFAS/PENDÊNCIAS:')
    for (const pending of capsule.pending) out.push('- ' + pending)
  }
  if (capsule.files.length > 0) {
    out.push('ARQUIVOS:')
    for (const file of capsule.files) out.push(`- ${file.path} (${file.status})`)
  }
  const open = capsule.errors.filter((failure) => failure.status === 'open')
  if (open.length > 0) {
    out.push('ERROS ABERTOS:')
    for (const failure of open) out.push('- ' + failure.symptom)
  }
  if (capsule.artifacts.length > 0) {
    out.push('ARTEFATOS:')
    for (const artifact of capsule.artifacts) out.push(`- ${artifact.ref} — ${artifact.description}`)
  }
  if (capsule.currentWork !== '') out.push('TRABALHO ATUAL: ' + capsule.currentWork)
  if (capsule.nextAction !== '') out.push('PRÓXIMA AÇÃO: ' + capsule.nextAction)
  if (currentQuestion !== '') out.push('PERGUNTA ATUAL: ' + currentQuestion.slice(0, 500))
  const note = out.join('\n')
  if (note.length <= NOTE1_MAX_CHARS) return note
  // O corte da nota é pelo FIM com marca: o topo carrega objetivo e
  // restrições, que são o que menos pode faltar.
  return note.slice(0, NOTE1_MAX_CHARS) + '\n[…nota de emergência cortada no teto…]'
}

function lastUserQuestion(tail: readonly TailItem[]): string {
  for (let index = tail.length - 1; index >= 0; index--) {
    const item = tail[index]!
    if (item.source === 'message' && item.role === 'user') return item.content
  }
  return ''
}
