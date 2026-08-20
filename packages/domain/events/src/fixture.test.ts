/**
 * O importador é a ponte entre o oráculo Go e a suíte TS: se ele ler errado,
 * toda a compatibilidade "provada" adiante é ficção. Por isso os testes usam a
 * fixture REAL (test-fixtures/, gravada do gateway vivo) e cravam os valores
 * que o README dela documenta.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { FixtureImportError, importLogJsonl } from './fixture.js'

const FIXTURES = new URL('../../../../test-fixtures/', import.meta.url)

function readFixture(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, FIXTURES)), 'utf8')
}

describe('importLogJsonl', () => {
  it('lê o chat-simples do oráculo: 4 envelopes, seq 1..4, verbos na ordem gravada', () => {
    const envelopes = importLogJsonl(readFixture('sessions/chat-simples/log.jsonl'))

    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4])
    expect(envelopes.map((envelope) => envelope.kind)).toEqual([
      'message', 'route', 'message', 'done',
    ])
    // Todos da mesma sessão e do mesmo turno — é o agrupamento que a UI colapsa.
    const sessions = new Set(envelopes.map((envelope) => envelope.session))
    expect(sessions.size).toBe(1)
  })

  it('decodifica por VALOR: os escapes unicode do Go viram os caracteres reais', () => {
    const envelopes = importLogJsonl(readFixture('sessions/chat-simples/log.jsonl'))
    const assistant = envelopes[2]
    expect(assistant).toBeDefined()
    const payload = assistant?.payload as { text: string }
    // O Go gravou o blockquote como sequência unicode; o valor é '>'.
    expect(payload.text).toContain('> Explique em uma frase')
    // UTF-8 com acento e ideograma atravessa inteiro.
    expect(payload.text).toContain('ação, ünïcödé, 日本語')
  })

  it('lê a ferramenta-aprovada: o quadrilátero call→request→decision→result vem tipado', () => {
    const envelopes = importLogJsonl(readFixture('sessions/ferramenta-aprovada/log.jsonl'))
    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(envelopes.map((envelope) => envelope.kind)).toEqual([
      'message', 'route', 'message', 'tool.call', 'approval.request',
      'approval.decision', 'tool.result', 'message', 'done',
    ])
  })

  it('tolera a ÚLTIMA linha partida — queda de energia não apaga o histórico', () => {
    const whole = readFixture('sessions/chat-simples/log.jsonl')
    const broken = `${whole.trimEnd()}\n{"v":1,"id":"e-partido","ts":"2026-`
    const envelopes = importLogJsonl(broken)
    expect(envelopes).toHaveLength(4)
  })

  it('linha ilegível no MEIO é erro alto: fixture encolhida provaria compat de mentira', () => {
    const lines = readFixture('sessions/chat-simples/log.jsonl').trimEnd().split('\n')
    lines.splice(2, 0, '{parcial sem fechar')
    expect(() => importLogJsonl(lines.join('\n'))).toThrow(FixtureImportError)
  })

  it('envelope que decodifica mas é inválido também grita (verbo desconhecido)', () => {
    const forged = '{"v":1,"id":"x","seq":1,"session":"s1","kind":"banana","from":{"kind":"user"}}\n'
    expect(() => importLogJsonl(forged)).toThrow(FixtureImportError)
  })

  it('aceita CRLF: um checkout Windows sem .gitattributes não quebra a suíte', () => {
    const crlf = readFixture('sessions/chat-simples/log.jsonl').replace(/\n/g, '\r\n')
    expect(importLogJsonl(crlf)).toHaveLength(4)
  })

  it('vazio devolve vazio (sessão criada e nunca usada)', () => {
    expect(importLogJsonl('')).toEqual([])
    expect(importLogJsonl('\n\n')).toEqual([])
  })
})
