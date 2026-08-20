/**
 * A normalização de INTENTS — o que a ação FAZ, não qual ferramenta foi
 * chamada (a lição do policy.ts do openbot: operador pensa em efeito, e
 * mecanismo é um proxy pobre de efeito — um botão é ativado por clique OU por
 * Enter OU por Espaço, e uma regra que nomeia só o clique cobre um caminho de
 * três).
 *
 * O conjunto é FECHADO e derivado AQUI, nunca passado por quem chama: uma rota
 * nova de efeito não pode chegar sem intent e cair fora de toda regra escrita
 * em termos de um (o mesmo motivo do intentOf do openbot).
 */

import { riskOf, riskTableKnows } from './gate.js'

/** O vocabulário fechado de efeitos. */
export type Intent =
  | 'READ'
  | 'WRITE'
  | 'EXECUTE'
  | 'NETWORK'
  | 'ACTIVATE'
  | 'PUBLISH'
  | 'SECRET_USE'
  | 'EXTERNAL_WRITE'

/** O que o funil sabe sobre a chamada na hora de classificar. */
export interface IntentSubject {
  tool: string
  /**
   * A tecla de um pressionamento de navegador. Enter e Espaço APERTAM o que
   * tem foco — submissão de formulário acontece por tecla tanto quanto por
   * clique, então uma regra sobre ativação precisa cobrir os dois caminhos.
   */
  key?: string
  /**
   * A chamada MCP decomposta: servidor, ferramenta e efeito anunciado.
   * `effect` vem de catálogo REVISADO, nunca do nome da ferramenta — pedir ao
   * operador cirurgia de string contra `mcp__jira__editJiraIssue` garantiria
   * regras sutilmente erradas na primeira renomeação do fornecedor.
   */
  mcp?: {
    server: string
    tool: string
    effect?: 'read' | 'write'
  }
}

/** As teclas que ATIVAM (apertam o que tem foco) em vez de digitar. */
export const ACTIVATING_KEYS: ReadonlySet<string> = new Set(['Enter', 'NumpadEnter', 'Space', ' '])

/**
 * Ferramentas cujo efeito é tornar algo PÚBLICO/entregue a terceiros em nosso
 * nome — mais que tráfego de rede: o que sai por aqui chega a uma audiência.
 */
const PUBLISH_TOOLS: ReadonlySet<string> = new Set(['webhook.post'])

/** Gestos de navegador que apertam alguma coisa. */
const ACTIVATING_TOOLS: ReadonlySet<string> = new Set(['computer_click'])

/** O navegador do bot, classificado por efeito (porte do intentOf do openbot). */
const BROWSER_INTENTS: ReadonlyMap<string, Intent> = new Map<string, Intent>([
  // Digitar numa página de terceiro é escrita — o texto aterrissa lá.
  ['computer_type', 'WRITE'],
  ['computer_navigate', 'NETWORK'],
  ['computer_read', 'READ'],
  ['computer_snapshot', 'READ'],
  ['computer_screenshot', 'READ'],
  ['computer_scroll', 'READ'],
  ['computer_read_file', 'READ'],
  ['computer_list_files', 'READ'],
  ['computer_write_file', 'WRITE'],
])

/**
 * Deriva o intent da chamada.
 *
 * MCP fecha para ESCRITA: efeito anunciado `read` é READ, `write` é
 * EXTERNAL_WRITE (escrita no sistema de OUTRO — Jira, CRM…), e efeito
 * DESCONHECIDO é WRITE — nada que não seja positivamente uma leitura passa
 * como leitura (a regra do E4: MCP desconhecido = WRITE).
 *
 * Ferramenta nativa desconhecida cai em EXECUTE, o mais restritivo — o mesmo
 * fail-closed do riskOf.
 */
export function normalizeIntent(subject: IntentSubject): Intent {
  const tool = subject.tool.trim()

  if (subject.mcp || tool.toLowerCase() === 'mcp.call') {
    switch (subject.mcp?.effect) {
      case 'read':
        return 'READ'
      case 'write':
        return 'EXTERNAL_WRITE'
      default:
        return 'WRITE'
    }
  }

  if (ACTIVATING_TOOLS.has(tool)) return 'ACTIVATE'
  if (tool === 'computer_key') {
    return subject.key !== undefined && ACTIVATING_KEYS.has(subject.key) ? 'ACTIVATE' : 'WRITE'
  }
  const browser = BROWSER_INTENTS.get(tool)
  if (browser) return browser

  if (PUBLISH_TOOLS.has(tool.toLowerCase())) return 'PUBLISH'

  if (!riskTableKnows(tool)) return 'EXECUTE'
  switch (riskOf(tool)) {
    case 'read':
      return 'READ'
    case 'write':
      return 'WRITE'
    case 'execute':
      return 'EXECUTE'
    case 'network':
      return 'NETWORK'
    case 'secret':
      return 'SECRET_USE'
  }
}
