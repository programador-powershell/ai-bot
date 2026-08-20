/**
 * PERGUNTA ou PEDIDO: a distinção que o assunto sozinho não faz.
 *
 * "Qual a sintaxe correta de um for em python?" tem `python` no meio e iria
 * para o Código pelo léxico — errado: a pessoa tirou uma dúvida. O erro é
 * assimétrico: mandar PERGUNTA para o especialista errado estraga a conversa
 * toda (o modo é gravado e não se reavalia); mandar PEDIDO para a Conversa
 * custa uma frase. Na dúvida, portanto, pergunta.
 *
 * Este módulo é léxico de propósito — o degrau de microssegundos. A leitura
 * SEMÂNTICA é do degrau local, que recebe a intenção junto do prompt.
 */

import { ACTION_VERBS, QUESTION_MARKERS, QUESTION_OPENERS } from './constants.js'
import { goTrimSpace, isWordStart, utf8 } from './text.js'

export type Intent = 'request' | 'question'

export const INTENT_REQUEST: Intent = 'request'
export const INTENT_QUESTION: Intent = 'question'

/**
 * Lê a intenção do texto JÁ NORMALIZADO (minúsculo, sem acento). Devolve
 * pedido por padrão: a maioria do que chega é trabalho, e tratar tudo como
 * dúvida faria a Conversa engolir o produto.
 */
export function intentOf(normalized: string): Intent {
  const trimmed = goTrimSpace(normalized)
  if (trimmed === '') return INTENT_REQUEST

  // Verbo de ação vence tudo: quem manda fazer, mandou fazer — com ponto de
  // interrogação ou sem.
  if (hasActionVerb(trimmed)) return INTENT_REQUEST

  if (trimmed.includes('?')) return INTENT_QUESTION
  for (const marker of QUESTION_MARKERS) {
    if (trimmed.includes(marker)) return INTENT_QUESTION
  }
  for (const opener of QUESTION_OPENERS) {
    if (trimmed.startsWith(opener)) return INTENT_QUESTION
  }
  return INTENT_REQUEST
}

/**
 * Procura um radical de ação em COMEÇO de palavra. O começo importa: sem ele
 * "test" casaria em "contexto" — e falso positivo aqui transforma dúvida em
 * pedido, que é justamente o erro caro.
 */
export function hasActionVerb(normalized: string): boolean {
  const bytes = utf8(normalized)
  for (const verb of ACTION_VERBS) {
    const needle = utf8(verb)
    let start = 0
    for (;;) {
      const at = bytes.indexOf(needle, start)
      if (at < 0) break
      start = at + needle.length
      if (isWordStart(bytes, at)) return true
    }
  }
  return false
}
