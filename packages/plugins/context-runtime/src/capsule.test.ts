/**
 * A bateria da cápsula: o porte caso a caso do capsule_test.go do oráculo
 * (dobra vira estado, idempotência por cursor, tetos, Load tolerante, render
 * vazio) mais os aceites NOVOS do E6 — a dobra em DUAS passadas que nunca
 * troca cápsula válida por candidata que perdeu estado crítico.
 */

import { describe, expect, it } from 'vitest'
import type { Envelope, Kind } from '@aibot2/domain-events'
import {
  Capsule,
  MAX_DECISIONS,
  MAX_CONSTRAINTS,
  auditCandidate,
  foldValidated,
  clip,
  MAX_FIELD_CHARS,
} from './capsule.js'

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

describe('a dobra transforma história em estado', () => {
  // O exemplo canônico da especificação: "rodei, deu erro, corrigi,
  // funcionou" vira um erro RESOLVIDO, não quatro mensagens.
  it('erro aberto é resolvido pelo sucesso posterior da mesma ferramenta', () => {
    const capsule = new Capsule()
    capsule.fold([
      envelope(1, 'message', { role: 'user', text: 'crie a API de cobrança' }),
      envelope(2, 'route', { specialist: 'code', reason: 'heuristic' }),
      envelope(3, 'tool.call', { callId: 'c1', tool: 'fs.write', args: { path: 'api/cobranca.go' } }),
      envelope(4, 'tool.result', { callId: 'c1', tool: 'fs.write', ok: false, error: 'pasta inexistente' }),
      envelope(5, 'tool.call', { callId: 'c2', tool: 'fs.write', args: { path: 'api/cobranca.go' } }),
      envelope(6, 'tool.result', { callId: 'c2', tool: 'fs.write', ok: true }),
      envelope(7, 'delegate', { from: 'code', to: 'data', goal: 'modele as tabelas' }),
      envelope(8, 'delegate', { from: 'code', to: 'data', goal: 'modele as tabelas', done: true, result: 'cobranca(id, valor)' }),
    ])

    expect(capsule.goal).toBe('crie a API de cobrança')
    expect(capsule.cursor).toBe(8)
    // O erro do fs.write foi RESOLVIDO pelo sucesso posterior da mesma ferramenta.
    for (const failure of capsule.errors) {
      expect(failure.status).not.toBe('open')
    }
    // O arquivo tocado aparece UMA vez, como modificado.
    expect(capsule.files).toHaveLength(1)
    expect(capsule.files[0]!.status).toBe('modified')
    // A delegação virou DUAS decisões: quem entrou e o que entregou.
    const texto = capsule.render()
    expect(texto).toContain('delegou a data')
    expect(texto).toContain('data entregou')
  })

  it('a dobra é incremental e idempotente por cursor', () => {
    const lote = [
      envelope(1, 'message', { role: 'user', text: 'oi' }),
      envelope(2, 'route', { specialist: 'chat', reason: 'heuristic' }),
    ]
    const capsule = new Capsule()
    capsule.fold(lote)
    const decisoes = capsule.decisions.length
    capsule.fold(lote)
    expect(capsule.decisions.length).toBe(decisoes)
    // As dobras contam mesmo vazias.
    expect(capsule.telemetry.folds).toBe(2)
  })

  it('os tetos valem: o excedente cai pelo mais antigo', () => {
    const capsule = new Capsule()
    const lote: Envelope[] = []
    for (let seq = 1; seq <= 40; seq++) {
      lote.push(envelope(seq, 'delegate', { from: 'a', to: 'b', goal: 'x'.repeat(10) + String(seq) }))
    }
    capsule.fold(lote)
    expect(capsule.decisions.length).toBeLessThanOrEqual(MAX_DECISIONS)
    // O mais RECENTE ficou.
    expect(capsule.decisions[capsule.decisions.length - 1]!.decision).toContain('40')
  })

  it('decisão irreversível não cai no teto enquanto houver reversível', () => {
    const capsule = new Capsule()
    capsule.decisions.push({ decision: 'apagou o banco de homologação', irreversible: true })
    const lote: Envelope[] = []
    for (let seq = 1; seq <= 30; seq++) {
      lote.push(envelope(seq, 'delegate', { from: 'a', to: 'b', goal: 'passo ' + String(seq) }))
    }
    capsule.fold(lote)
    expect(capsule.decisions.some((item) => item.irreversible === true)).toBe(true)
  })

  it('Load tolerante: corrompido e vazio viram cápsula nova', () => {
    expect(Capsule.load('{quebrado').cursor).toBe(0)
    expect(Capsule.load(null).cursor).toBe(0)
    expect(Capsule.load('').cursor).toBe(0)
  })

  it('render vazio para sessão sem nada dobrado', () => {
    expect(new Capsule().render()).toBe('')
  })

  it('mensagem nova do usuário limpa pendências e vira trabalho atual', () => {
    const capsule = new Capsule()
    capsule.fold([envelope(1, 'ask', { askId: 'a1', question: 'posso apagar?', blocking: true })])
    expect(capsule.pending).toHaveLength(1)
    expect(capsule.nextAction).toBe('aguardar resposta humana')
    capsule.fold([envelope(2, 'message', { role: 'user', text: 'pode, siga' })])
    expect(capsule.pending).toHaveLength(0)
    expect(capsule.currentWork).toBe('pode, siga')
  })

  it('clip normaliza espaço e corta sem partir caractere', () => {
    expect(clip('  a   b\n\nc  ')).toBe('a b c')
    const longo = 'é'.repeat(MAX_FIELD_CHARS + 50)
    const cortado = clip(longo)
    expect([...cortado].length).toBe(MAX_FIELD_CHARS + 1) // 240 pontos + '…'
    expect(cortado.endsWith('…')).toBe(true)
  })

  it('restrição declarada entra na cápsula e o teto recusa em vez de calar', () => {
    const capsule = new Capsule()
    capsule.addConstraint('nunca commitar')
    capsule.addConstraint('nunca commitar') // idempotente
    expect(capsule.constraints).toEqual(['nunca commitar'])
    for (let i = 1; i < MAX_CONSTRAINTS; i++) capsule.addConstraint('regra ' + String(i))
    expect(() => capsule.addConstraint('a que não cabe')).toThrow(/teto/)
  })
})

describe('a dobra em duas passadas (extração + validação)', () => {
  it('a dobra determinística é adotada e não muda a anterior em caso de reprova', () => {
    const previous = new Capsule()
    previous.fold([envelope(1, 'message', { role: 'user', text: 'objetivo X' })])
    const outcome = foldValidated(previous, [
      envelope(2, 'tool.call', { callId: 'c1', tool: 'fs.read', args: { path: 'a.txt' } }),
    ])
    expect(outcome.adopted).toBe(true)
    expect(outcome.capsule.cursor).toBe(2)
    // A anterior ficou intacta — a extração trabalhou num CLONE.
    expect(previous.cursor).toBe(1)
  })

  it('nunca trocar cápsula válida por candidata que perdeu o objetivo', () => {
    const previous = new Capsule()
    previous.fold([envelope(1, 'message', { role: 'user', text: 'objetivo X' })])
    const candidate = previous.clone()
    candidate.goal = '' // o "resumo" perdeu o objetivo
    candidate.cursor = 5
    const audit = auditCandidate(previous, candidate)
    expect(audit.ok).toBe(false)
    expect(audit.losses.join(' ')).toContain('objetivo')
  })

  it('candidata que perdeu pendência, restrição, erro aberto ou artefato reprova', () => {
    const previous = new Capsule()
    previous.addConstraint('nunca dar push')
    previous.fold([
      envelope(1, 'message', { role: 'user', text: 'objetivo X' }),
      envelope(2, 'tool.result', { callId: 'c9', tool: 'proc.run', ok: false, error: 'build quebrado' }),
      envelope(3, 'tool.result', { callId: 'c8', tool: 'fs.read', ok: true, artifactRef: 'artifact://fs.read/abc123' }),
      envelope(4, 'ask', { askId: 'a1', question: 'qual banco?', blocking: true }),
    ])
    const candidate = previous.clone()
    candidate.cursor = 9
    candidate.constraints = []
    candidate.pending = []
    candidate.errors = []
    candidate.artifacts = []
    const audit = auditCandidate(previous, candidate)
    expect(audit.ok).toBe(false)
    const losses = audit.losses.join('; ')
    expect(losses).toContain('restrição')
    expect(losses).toContain('pendência')
    expect(losses).toContain('erro aberto')
    expect(losses).toContain('artefato')
  })

  it('limpezas legítimas passam: reply fecha pendência, done zera nextAction', () => {
    const previous = new Capsule()
    previous.fold([
      envelope(1, 'message', { role: 'user', text: 'objetivo X' }),
      envelope(2, 'ask', { askId: 'a1', question: 'qual banco?', blocking: true }),
    ])
    const withReply = foldValidated(previous, [envelope(3, 'reply', { askId: 'a1', answer: 'postgres' })])
    expect(withReply.adopted).toBe(true)
    expect(withReply.capsule.pending).toHaveLength(0)

    const withDone = foldValidated(withReply.capsule, [envelope(4, 'done', { turn: 't1' })])
    expect(withDone.adopted).toBe(true)
    expect(withDone.capsule.nextAction).toBe('')
  })

  it('cursor que regride reprova — resumo não pode desdobrar o tempo', () => {
    const previous = new Capsule()
    previous.fold([envelope(5, 'message', { role: 'user', text: 'objetivo X' })])
    const candidate = previous.clone()
    candidate.cursor = 2
    expect(auditCandidate(previous, candidate).ok).toBe(false)
  })

  it('decisão irreversível perdida reprova a candidata', () => {
    const previous = new Capsule()
    previous.fold([envelope(1, 'message', { role: 'user', text: 'objetivo X' })])
    previous.decisions.push({ decision: 'derrubou a tabela clientes', irreversible: true })
    const candidate = previous.clone()
    candidate.decisions = candidate.decisions.filter((item) => item.irreversible !== true)
    const audit = auditCandidate(previous, candidate)
    expect(audit.ok).toBe(false)
    expect(audit.losses.join(' ')).toContain('irreversível')
  })
})
