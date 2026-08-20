/**
 * Anexos como sinal de rota. Depois da escolha explícita, é o sinal mais
 * deliberado que existe: a pessoa ESCOLHEU um arquivo, enquanto radical é
 * coincidência de vocabulário. A garantia de "extensão vence radical" vem da
 * aritmética (a parcela de texto entra capada na saturação; o anexo pesa o
 * dobro dela), não de um if.
 */

import type { Definition } from '@aibot2/specialist-registry'
import { ATTACHMENT_WEIGHT, EXTENSION_OWNER, SATURATION } from './constants.js'
import type { Scored } from './score.js'

/** Extensão minúscula e sem o ponto; vazio quando não há — e aí não opina. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export interface CombinedScores {
  combined: Scored[]
  /**
   * O primeiro colocado é DECISIVO: estritamente à frente do segundo e com
   * pelo menos um anexo a seu favor. Empate EXATO não decide — segue para os
   * degraus seguintes com o ranking combinado.
   */
  decisive: boolean
}

/**
 * Soma o peso dos anexos à pontuação léxica do texto. Sem anexo reconhecido
 * (extensão desconhecida, ou dono barrado pela política) devolve as
 * pontuações INTACTAS: prompt sem anexo roteia exatamente como antes.
 */
export function combineAttachments(
  scores: readonly Scored[],
  names: readonly string[],
  candidates: readonly Definition[],
): CombinedScores {
  const allowed = new Set(candidates.map((definition) => definition.id))
  const attachRaw = new Map<string, number>()
  const attachSignals = new Map<string, string[]>()
  for (const name of names) {
    const extension = extensionOf(name)
    const owner = EXTENSION_OWNER.get(extension)
    // Dono fora da política não pontua: rotear para quem o admin barrou seria
    // usar o anexo como porta de trás da lista.
    if (owner === undefined || !allowed.has(owner)) continue
    attachRaw.set(owner, (attachRaw.get(owner) ?? 0) + ATTACHMENT_WEIGHT)
    const list = attachSignals.get(owner) ?? []
    // O sinal vai para a tela como um radical iria: quem passa o mouse na
    // rota precisa ver O QUE pesou — aqui, o arquivo.
    list.push(`anexo .${extension}`)
    attachSignals.set(owner, list)
  }
  if (attachRaw.size === 0) {
    return { combined: [...scores], decisive: false }
  }

  const raw = new Map<string, number>()
  const signals = new Map<string, string[]>()
  for (const scored of scores) {
    // Confidence × saturação É o bruto capado — nada a recalcular: a
    // confiança já satura ali, e acima disso o léxico não fica "mais certo".
    raw.set(scored.id, scored.confidence * SATURATION)
    signals.set(scored.id, scored.signals)
  }
  for (const [id, points] of attachRaw) {
    raw.set(id, (raw.get(id) ?? 0) + points)
    // Anexo na frente dos radicais: foi ele que decidiu, e a ordem dos sinais
    // é a ordem em que a explicação se lê.
    signals.set(id, [...(attachSignals.get(id) ?? []), ...(signals.get(id) ?? [])])
  }

  const combined: Scored[] = []
  for (const [id, value] of raw) {
    let confidence = value / SATURATION
    if (confidence > 1) confidence = 1
    combined.push({ id, confidence, signals: signals.get(id) ?? [], deliverable: false })
  }
  // O BRUTO ordena (a confiança capada empata em 1.0 justamente nos casos que
  // interessam) e o id desempata — empate não vira sorteio entre execuções.
  combined.sort((a, b) => {
    const rawA = raw.get(a.id) as number
    const rawB = raw.get(b.id) as number
    if (rawA !== rawB) return rawB - rawA
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const first = combined[0] as Scored
  const decisive =
    (attachRaw.get(first.id) ?? 0) > 0 &&
    (combined.length === 1 || (raw.get(first.id) as number) > (raw.get((combined[1] as Scored).id) as number))
  return { combined, decisive }
}
