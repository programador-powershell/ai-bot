/**
 * O ELENCO do primeiro input: quem atende e quem fica em espera.
 *
 * Duas fontes se complementam: as COMPANHIAS declaradas no catálogo (regra de
 * ofício, escrita como dado) e o que o LÉXICO viu no pedido (quem pontuou
 * forte e não ganhou provavelmente tem trabalho ali). O que este módulo NÃO
 * faz: executar. Ele monta a intenção; quem despacha é a equipe, e quem
 * confirma é a pessoa — um elenco que já saísse rodando transformaria "crie
 * uma aplicação" em cinco modelos gastando dinheiro sem ninguém ter pedido.
 */

import type { Definition } from '@aibot2/specialist-registry'
import { CAST_LEXICAL_MIN, MAX_STANDBY } from './constants.js'
import type { Scored } from './score.js'
import { normalize } from './text.js'

/** Um especialista de apoio, e QUANDO ele entra. */
export interface Standby {
  specialist: string
  /** "parallel" (junto do dono) ou "after" (sobre o que o dono produziu). */
  when: string
  /** A frase que a tela mostra, escrita para a pessoa ler. */
  why: string
}

/**
 * Monta o elenco de apoio para um pedido já roteado. `allowed` são os ids que
 * a política desta sessão libera — um bot em espera que a sessão não pode
 * usar seria uma promessa que o portão vai quebrar depois.
 */
export function cast(
  prompt: string,
  owner: string,
  scores: readonly Scored[],
  allowed: readonly Definition[],
  getOrDefault: (id: string) => Definition,
): Standby[] {
  const normalized = normalize(prompt)
  const permitted = new Set(allowed.map((candidate) => candidate.id))

  // Ordem de inserção preservada: companhias declaradas primeiro (regra de
  // ofício), o léxico completa o que sobrou.
  const chosen: Standby[] = []
  const seen = new Set<string>([owner])

  const add = (id: string, when: string, why: string): void => {
    if (seen.has(id) || !permitted.has(id) || chosen.length >= MAX_STANDBY) return
    seen.add(id)
    chosen.push({ specialist: id, when, why })
  }

  for (const companion of getOrDefault(owner).companions) {
    if (!requirementsMet(normalized, companion.requires)) continue
    add(companion.specialist, companion.when, companion.why)
  }

  // Ordenado por pontuação para o mais provável entrar primeiro quando o teto
  // apertar. Sort do JS é estável por spec — a ordem de entrada segura o empate.
  const byScore = [...scores].sort((a, b) => b.confidence - a.confidence)
  for (const item of byScore) {
    if (item.id === owner || item.confidence < CAST_LEXICAL_MIN) continue
    add(
      item.id,
      defaultRelation(item.id),
      `o pedido tem sinal de ${getOrDefault(item.id).name} (${item.signals.join(', ')})`,
    )
  }

  return chosen
}

/** Lista vazia significa "sem condição" — o companheiro entra sempre. */
function requirementsMet(normalized: string, requires: readonly string[]): boolean {
  if (requires.length === 0) return true
  for (const radical of requires) {
    if (normalized.includes(normalize(radical))) return true
  }
  return false
}

/**
 * Série ou paralelo para quem entrou pelo LÉXICO, sem companhia declarada
 * dizendo quando. A regra é a dependência de ARTEFATO: quem revisa ou
 * documenta precisa que o trabalho exista. Errar para "depois" é o erro
 * barato — serializar demais custa tempo, paralelizar quem depende produz um
 * parecer sobre o vazio.
 */
function defaultRelation(companion: string): string {
  switch (companion) {
    case 'security':
    case 'office':
      return 'after'
    default:
      return 'parallel'
  }
}
