/**
 * A borda do protocolo: o que entra malformado morre AQUI, com nome, e não
 * três camadas adiante num default silencioso. Os casos espelham o Validate()
 * do oráculo — nem mais rígido (recusaria log que o Go gravou), nem mais
 * frouxo (deixaria passar o que o Go recusava).
 */

import { describe, expect, it } from 'vitest'

import {
  InvalidEnvelopeError,
  KINDS,
  VERSION,
  isValidKind,
  validateEnvelope,
} from './protocol.js'

/** Um envelope mínimo válido, na forma que o oráculo grava. */
function valid(): Record<string, unknown> {
  return {
    v: VERSION,
    id: 'e-1',
    ts: '2026-08-20T10:16:19.746287Z',
    seq: 1,
    session: 's1',
    kind: 'message',
    from: { kind: 'user' },
    payload: { role: 'user', text: 'oi' },
  }
}

describe('validateEnvelope', () => {
  it('aceita a forma que o oráculo grava e devolve o valor tipado', () => {
    const envelope = validateEnvelope(valid())
    expect(envelope.kind).toBe('message')
    expect(envelope.seq).toBe(1)
  })

  it('recusa o que não é objeto', () => {
    expect(() => validateEnvelope(null)).toThrow(InvalidEnvelopeError)
    expect(() => validateEnvelope('texto')).toThrow(InvalidEnvelopeError)
    expect(() => validateEnvelope([valid()])).toThrow(InvalidEnvelopeError)
  })

  it('recusa versão diferente — versão sobe quando o SIGNIFICADO muda', () => {
    expect(() => validateEnvelope({ ...valid(), v: 2 })).toThrow(/versão 2/)
    expect(() => validateEnvelope({ ...valid(), v: undefined })).toThrow(InvalidEnvelopeError)
  })

  it('recusa sessão vazia', () => {
    expect(() => validateEnvelope({ ...valid(), session: '' })).toThrow(/sessão vazia/)
  })

  it('recusa verbo desconhecido — a lista é fechada de propósito', () => {
    expect(() => validateEnvelope({ ...valid(), kind: 'banana' })).toThrow(/verbo desconhecido/)
  })

  it('recusa remetente sem tipo', () => {
    expect(() => validateEnvelope({ ...valid(), from: {} })).toThrow(/remetente sem tipo/)
    expect(() => validateEnvelope({ ...valid(), from: { kind: '' } })).toThrow(
      /remetente sem tipo/,
    )
  })

  it('NÃO recusa o que o oráculo também não recusa (id/ts/seq ausentes)', () => {
    // Ser "mais rígido" aqui quebraria o replay de logs que o Go aceitou.
    const semExtras = { v: VERSION, session: 's1', kind: 'done', from: { kind: 'supervisor' } }
    expect(() => validateEnvelope(semExtras)).not.toThrow()
  })
})

describe('kinds', () => {
  it('a lista é a do protocolo Go: 23 verbos, fechados', () => {
    expect(KINDS).toHaveLength(23)
    for (const kind of KINDS) {
      expect(isValidKind(kind)).toBe(true)
    }
    expect(isValidKind('prompt')).toBe(true)
    expect(isValidKind('tool.call')).toBe(true)
    expect(isValidKind('banana')).toBe(false)
    expect(isValidKind('')).toBe(false)
  })
})
