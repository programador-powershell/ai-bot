/**
 * O fast router: pontuação léxica pura, offline, ~microssegundos — o degrau 1
 * da cascata. Um erro aqui não quebra nada visivelmente, só manda a conversa
 * para o especialista errado de vez em quando — o tipo de defeito que
 * sobrevive anos; por isso os golden tests comparam este módulo byte a byte
 * com o oráculo.
 */

import type { Definition } from '@aibot2/specialist-registry'
import {
  BUILD_VERBS,
  DELIVERABLE_BONUS,
  DELIVERABLE_WINDOW,
  SATURATION,
  WHOLE_WORD_WEIGHT,
  WORD_START_WEIGHT,
} from './constants.js'
import { isWholeWord, isWordStart, normalize, utf8 } from './text.js'

/** A pontuação de um especialista para um texto. */
export interface Scored {
  id: string
  confidence: number
  signals: string[]
  /**
   * Marca quem entrega A COISA PEDIDA — o substantivo logo depois do verbo de
   * construção. É REGRA, não peso: ver soleDeliverable.
   */
  deliverable: boolean
}

/** Dobra um radical, com cache opcional (o cache é do catálogo ativo). */
export type TriggerLookup = (raw: string) => string

/**
 * Pontua cada candidato contra o texto, do maior para o menor. Ordem estável:
 * confiança desc, depois id asc — sem o desempate por id, dois empatados
 * trocariam de lugar entre execuções e a margem viraria sorteio.
 */
export function score(
  text: string,
  candidates: readonly Definition[],
  triggerLookup?: TriggerLookup,
): Scored[] {
  const normalized = normalize(text)
  if (normalized === '') return []
  const bytes = utf8(normalized)
  const lookup = triggerLookup ?? normalize

  const out: Scored[] = []
  for (const definition of candidates) {
    let raw = 0
    let signals: string[] | undefined
    for (const trigger of definition.triggers) {
      const needle = lookup(trigger)
      if (needle === '') continue
      const needleBytes = utf8(needle)
      // SÓ a primeira ocorrência opina — igual ao oráculo: uma segunda
      // ocorrência por palavra inteira não resgata um primeiro casamento fraco.
      const position = bytes.indexOf(needleBytes)
      if (position < 0) continue
      // Radical específico vale mais que genérico: o comprimento É o peso.
      let weight = needleBytes.length
      if (isWholeWord(bytes, position, needleBytes.length)) {
        // PALAVRA INTEIRA é o sinal mais forte deste degrau: "sql", "erd",
        // "css" têm três letras e não são ambíguos em nada.
        weight *= WHOLE_WORD_WEIGHT
      } else if (isWordStart(bytes, position)) {
        weight *= WORD_START_WEIGHT
      }
      raw += weight
      ;(signals ??= []).push(trigger)
    }

    // O ENTREGÁVEL manda mais que a contagem de radicais: "crie uma api …
    // com banco postgres" pontua mais em Dados e mesmo assim o dono é o
    // Código — a API é o que foi PEDIDO, o banco é o que ela usa.
    const deliverable = deliverableAfterVerb(bytes, definition.deliverables)
    if (deliverable) {
      raw += DELIVERABLE_BONUS
      ;(signals ??= []).push('entregável do pedido')
    }

    if (raw === 0) continue
    let confidence = raw / SATURATION
    if (confidence > 1) confidence = 1
    out.push({ id: definition.id, confidence, signals: signals ?? [], deliverable })
  }

  out.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return out
}

/**
 * Diz se algum entregável deste especialista aparece na janela de bytes logo
 * depois de um verbo de construção.
 */
export function deliverableAfterVerb(bytes: Buffer, deliverables: readonly string[]): boolean {
  if (deliverables.length === 0) return false
  for (const verb of BUILD_VERBS) {
    const verbBytes = utf8(verb)
    let start = 0
    for (;;) {
      const at = bytes.indexOf(verbBytes, start)
      if (at < 0) break
      start = at + verbBytes.length
      if (!isWordStart(bytes, at)) continue
      const window = bytes.subarray(at, Math.min(bytes.length, at + DELIVERABLE_WINDOW))
      for (const noun of deliverables) {
        if (window.indexOf(utf8(noun)) >= 0) return true
      }
    }
  }
  return false
}

/**
 * Devolve o ÚNICO especialista que entrega o que foi pedido. "Único" é a
 * condição inteira: dois entregáveis no mesmo pedido ("crie o app e o banco")
 * são um empate de verdade, e empate sobe a cascata em vez de ser resolvido
 * no grito.
 */
export function soleDeliverable(scores: readonly Scored[]): Scored | undefined {
  let found: Scored | undefined
  let count = 0
  for (const item of scores) {
    if (!item.deliverable) continue
    count++
    if (count > 1) return undefined
    found = item
  }
  return count === 1 ? found : undefined
}
