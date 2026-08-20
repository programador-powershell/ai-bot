/**
 * history() — os pares atômicos como no oráculo (supervisor.go history()):
 * evidência de ferramenta é UMA mensagem user; a delegação dobra 2x por Done
 * (pedido e resultado, no MESMO grupo); só message/tool.result/delegate
 * entram; o corte pelo fim respeita grupos.
 */

import { describe, expect, it } from 'vitest'
import type { Envelope, Kind } from '@aibot2/domain-events'
import { MAX_HISTORY_MESSAGES, tailFromEnvelopes, toolEvidence } from './history.js'

function envelope(seq: number, kind: Kind, payload: unknown): Envelope {
  return {
    v: 1,
    id: `e-${seq}`,
    ts: new Date().toISOString(),
    seq,
    session: 's1',
    kind,
    from: { kind: 'supervisor' },
    payload,
  }
}

describe('pares atômicos como no oráculo', () => {
  it('ToolResult dobra como UMA mensagem user autodescritiva', () => {
    const tail = tailFromEnvelopes([
      envelope(1, 'message', { role: 'user', text: 'leia o arquivo' }),
      envelope(2, 'tool.call', { callId: 'c1', tool: 'fs.read', args: { path: 'a.txt' } }),
      envelope(3, 'tool.result', { callId: 'c1', tool: 'fs.read', ok: true, output: 'conteudo 42' }),
    ])
    // O tool.call NÃO vira mensagem própria: a evidência é UMA mensagem por
    // par — é isso que a torna impossível de partir pelo orçamento.
    expect(tail).toHaveLength(2)
    const evidence = tail[1]!
    expect(evidence.role).toBe('user')
    expect(evidence.source).toBe('evidence')
    expect(evidence.tool).toBe('fs.read')
    expect(evidence.content).toBe(toolEvidence('fs.read', 'conteudo 42'))
  })

  it('falha de ferramenta volta como evidência com o erro', () => {
    const tail = tailFromEnvelopes([
      envelope(1, 'tool.result', { callId: 'c1', tool: 'proc.run', ok: false, error: 'exit 1' }),
    ])
    expect(tail).toHaveLength(1)
    expect(tail[0]!.content).toContain('falhou: exit 1')
  })

  it('a delegação dobra 2x por Done, no MESMO grupo atômico', () => {
    const tail = tailFromEnvelopes([
      envelope(1, 'delegate', { from: 'code', to: 'data', goal: 'modele as tabelas', depth: 1 }),
      envelope(2, 'delegate', { from: 'code', to: 'data', goal: 'modele as tabelas', depth: 1, done: true, result: 'cobranca(id)' }),
    ])
    expect(tail).toHaveLength(2)
    expect(tail[0]!.role).toBe('assistant')
    expect(tail[0]!.content).toContain('Deleguei ao especialista data')
    expect(tail[1]!.role).toBe('user')
    expect(tail[1]!.content).toContain('Resultado do especialista data')
    // O par compartilha groupId: entra e sai da janela JUNTO.
    expect(tail[0]!.groupId).toBeDefined()
    expect(tail[0]!.groupId).toBe(tail[1]!.groupId)
  })

  it('delegação sem resultado (done sem texto) não vira mensagem vazia', () => {
    const tail = tailFromEnvelopes([
      envelope(1, 'delegate', { from: 'code', to: 'data', goal: 'x', depth: 1, done: true, result: '   ' }),
    ])
    expect(tail).toHaveLength(0)
  })

  it('verbos fora do trio não entram (aprovação vive na cápsula, não no prompt)', () => {
    const tail = tailFromEnvelopes([
      envelope(1, 'approval.request', { callId: 'c1', tool: 'fs.write', risk: 'write', summary: 'x' }),
      envelope(2, 'approval.decision', { callId: 'c1', allow: true }),
      envelope(3, 'state', { busy: false }),
      envelope(4, 'thinking', { label: 'pensando' }),
    ])
    expect(tail).toHaveLength(0)
  })

  it('o corte pelo fim preserva o teto e a mensagem mais recente', () => {
    const envelopes: Envelope[] = []
    for (let seq = 1; seq <= 100; seq++) {
      envelopes.push(envelope(seq, 'message', { role: seq % 2 === 0 ? 'assistant' : 'user', text: 'm' + String(seq) }))
    }
    const tail = tailFromEnvelopes(envelopes)
    expect(tail).toHaveLength(MAX_HISTORY_MESSAGES)
    expect(tail[tail.length - 1]!.content).toBe('m100')
    // Cortar pelo começo descartaria justamente a pergunta atual.
    expect(tail[0]!.content).toBe('m61')
  })

  it('o corte pelo fim não parte um grupo: a abertura da delegação volta', () => {
    const envelopes: Envelope[] = []
    // 40 mensagens de enchimento, depois o par de delegação posicionado para
    // que o corte ingênuo deixasse só o resultado.
    envelopes.push(envelope(1, 'delegate', { from: 'a', to: 'data', goal: 'g', depth: 1 }))
    for (let seq = 2; seq <= 41; seq++) {
      envelopes.push(envelope(seq, 'message', { role: 'user', text: 'm' + String(seq) }))
    }
    // Reordena: abre a delegação exatamente no limite do corte.
    const shifted: Envelope[] = []
    for (let seq = 1; seq <= 5; seq++) shifted.push(envelope(seq, 'message', { role: 'user', text: 'antes' + String(seq) }))
    shifted.push(envelope(6, 'delegate', { from: 'a', to: 'data', goal: 'g', depth: 1 }))
    shifted.push(envelope(7, 'delegate', { from: 'a', to: 'data', goal: 'g', depth: 1, done: true, result: 'ok' }))
    for (let seq = 8; seq <= 46; seq++) shifted.push(envelope(seq, 'message', { role: 'user', text: 'm' + String(seq) }))
    const tail = tailFromEnvelopes(shifted)
    const opens = tail.filter((item) => item.content.startsWith('Deleguei'))
    const results = tail.filter((item) => item.content.startsWith('Resultado do especialista'))
    // Ou o par inteiro está na janela, ou nenhum dos dois.
    expect(opens.length).toBe(results.length)
  })
})
