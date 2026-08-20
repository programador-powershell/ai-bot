/**
 * O vocabulário fechado de intents (E4): efeito, não mecanismo. Os casos que
 * mais importam são os fail-closed — MCP sem efeito anunciado é WRITE e
 * ferramenta nativa desconhecida é EXECUTE.
 */

import { describe, expect, it } from 'vitest'
import { ACTIVATING_KEYS, normalizeIntent, type Intent } from './intents.js'

describe('normalizeIntent', () => {
  it('MCP fecha para escrita: read é READ, write é EXTERNAL_WRITE, desconhecido é WRITE', () => {
    expect(normalizeIntent({ tool: 'mcp.call', mcp: { server: 'jira', tool: 'getIssue', effect: 'read' } }))
      .toBe('READ')
    expect(normalizeIntent({ tool: 'mcp.call', mcp: { server: 'jira', tool: 'editIssue', effect: 'write' } }))
      .toBe('EXTERNAL_WRITE')
    // A regra do E4: MCP desconhecido = WRITE — nada que não seja
    // positivamente uma leitura passa como leitura.
    expect(normalizeIntent({ tool: 'mcp.call', mcp: { server: 'jira', tool: 'algoNovo' } })).toBe('WRITE')
    expect(normalizeIntent({ tool: 'mcp.call' })).toBe('WRITE')
  })

  it('Enter e Espaço ATIVAM; letra digita — a regra sobre ativação cobre tecla e clique', () => {
    expect(normalizeIntent({ tool: 'computer_click' })).toBe('ACTIVATE')
    for (const key of ACTIVATING_KEYS) {
      expect(normalizeIntent({ tool: 'computer_key', key }), key).toBe('ACTIVATE')
    }
    expect(normalizeIntent({ tool: 'computer_key', key: 'a' })).toBe('WRITE')
    expect(normalizeIntent({ tool: 'computer_key' })).toBe('WRITE')
  })

  it('navegador por efeito: digitar é WRITE, navegar é NETWORK, olhar é READ', () => {
    expect(normalizeIntent({ tool: 'computer_type' })).toBe('WRITE')
    expect(normalizeIntent({ tool: 'computer_navigate' })).toBe('NETWORK')
    for (const tool of ['computer_read', 'computer_snapshot', 'computer_screenshot', 'computer_scroll']) {
      expect(normalizeIntent({ tool }), tool).toBe('READ')
    }
    expect(normalizeIntent({ tool: 'computer_read_file' })).toBe('READ')
    expect(normalizeIntent({ tool: 'computer_write_file' })).toBe('WRITE')
  })

  it('webhook.post é PUBLISH — mais que tráfego: chega a uma audiência em nosso nome', () => {
    expect(normalizeIntent({ tool: 'webhook.post' })).toBe('PUBLISH')
  })

  it('as ferramentas nativas herdam da tabela de risco', () => {
    const cases: [string, Intent][] = [
      ['fs.read', 'READ'],
      ['fs.write', 'WRITE'],
      ['proc.run', 'EXECUTE'],
      ['osv.query', 'NETWORK'],
      ['secrets.scan', 'SECRET_USE'],
    ]
    for (const [tool, want] of cases) {
      expect(normalizeIntent({ tool }), tool).toBe(want)
    }
  })

  it('ferramenta nativa desconhecida cai em EXECUTE — o mesmo fail-closed do riskOf', () => {
    expect(normalizeIntent({ tool: 'ferramenta.nova' })).toBe('EXECUTE')
    expect(normalizeIntent({ tool: '' })).toBe('EXECUTE')
  })
})
