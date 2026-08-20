/**
 * Os seams da cascata. O consumidor (este plugin) define o contrato; o
 * provider concreto (providers/needle, um stub de teste, um modelo grande via
 * rede) o implementa — a lição do harness: consumer depende do seam, nunca do
 * provider.
 *
 * As DUAS interfaces existem de propósito, ainda que a forma dos vereditos
 * seja igual: são degraus diferentes da cascata, com limiares diferentes, e
 * um pode existir sem o outro. Amarrar os dois no mesmo tipo faria "sem
 * Needle" e "sem rede" virarem a mesma configuração.
 */

import type { Definition } from '@aibot2/specialist-registry'
import type { Intent } from './intent.js'

export interface ModelHealth {
  ok: boolean
  detail?: string
}

/** O que o degrau local recebe: prompt, intenção lida e a shortlist. */
export interface RouteQuery {
  prompt: string
  /**
   * A intenção léxica viaja junto para o modelo não ter de deduzi-la sozinho
   * — a leitura semântica ("dúvida ou pedido disfarçado?") é trabalho dele.
   */
  intent: Intent
  /**
   * Candidatos JÁ encurtados ao orçamento (5): acima disso o Needle liga a
   * recuperação por embedding e escolhe sozinho, com menos informação.
   */
  candidates: readonly Definition[]
}

/** O veredito de um classificador — o formato é o mesmo, o preço não. */
export interface RouteVerdict {
  specialist: string
  confidence: number
  why?: string
}

/** O pedido de orquestração (spec §8): decisões incrementais, nunca re-rotear tudo. */
export interface OrchestratorQuery {
  goal: string
  /** State Capsule compactada — memória real vive fora do modelo. */
  stateCapsule?: unknown
  /** Task Board atual, para decisões `continue`/`replan`. */
  taskBoard?: unknown
  /** Os ids de especialista que a política libera como executores. */
  specialists: readonly string[]
}

/**
 * O seam do modelo orquestrador local (spec §9). `ready()` é síncrono e
 * NUNCA lança: é o portão que degrada a cascata quando o serviço não está de
 * pé — indisponível é degradação, não falha.
 *
 * `orchestrate()` devolve `unknown` de propósito: a validação do contrato
 * FECHADO (OrchestratorDecision) é do plugin, não do provider — processo de
 * terceiro não escolhe o que a política não liberou.
 */
export interface OrchestratorModel {
  ready(): boolean
  health(): Promise<ModelHealth>
  route(query: RouteQuery): Promise<RouteVerdict>
  orchestrate(query: OrchestratorQuery): Promise<unknown>
}

/** O degrau do modelo GRANDE — atrás de seam para o roteador testar sem rede. */
export interface Classifier {
  classify(prompt: string, candidates: readonly Definition[]): Promise<RouteVerdict>
}
