/**
 * A classificação de durabilidade é uma decisão de produto (o que a pessoa NÃO
 * pode perder paga fsync), e decisões de produto viram tabela em teste: mudar
 * um verbo de lado tem de quebrar algo visível, não passar num refactor.
 */

import { describe, expect, it } from 'vitest'

import { KINDS } from './protocol.js'
import { durableKind } from './storage.js'

describe('durableKind', () => {
  it('exatamente delta/thinking/task.progress/state são efêmeros', () => {
    const ephemeral = KINDS.filter((kind) => !durableKind(kind))
    expect(ephemeral.sort()).toEqual(['delta', 'state', 'task.progress', 'thinking'])
  })

  it('os verbos que carregam decisão ou conteúdo pagam fsync', () => {
    // A lista completa por extenso: o dia em que um verbo durável deixar de
    // pagar fsync, este teste conta QUAL.
    for (const kind of [
      'hello', 'ready', 'error', 'done',
      'prompt', 'route', 'message',
      'tool.call', 'tool.result',
      'approval.request', 'approval.decision',
      'task.dispatch', 'worker.done', 'escalate', 'ask', 'reply', 'gate',
      'delegate', 'notice',
    ] as const) {
      expect(durableKind(kind), kind).toBe(true)
    }
  })
})
