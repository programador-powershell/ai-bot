/**
 * Bateria do Take the Wheel — a máquina de estados sem browser. O aceite E8
 * central: humano no controle ⇒ ação do bot RECUSADA (exceção nomeada), nunca
 * enfileirada — não existe fila para afirmar, e é essa a garantia.
 */

import { describe, expect, it } from 'vitest'
import { ControlError, ControlRequestError, createControl } from './control.js'

describe('Take the Wheel', () => {
  it('nasce com o bot no volante e o bot pode agir', () => {
    const control = createControl()
    expect(control.get().holder).toBe('bot')
    expect(() => control.assertBotMayAct()).not.toThrow()
    expect(control.humanMayDrive()).toBe(false)
  })

  it('humano assume ⇒ ação do bot é RECUSADA com erro nomeado', () => {
    const control = createControl()
    control.take()
    expect(() => control.assertBotMayAct()).toThrow(ControlError)
    expect(control.humanMayDrive()).toBe(true)
  })

  it('devolver o volante libera o bot de novo', () => {
    const control = createControl()
    control.take()
    control.release()
    expect(() => control.assertBotMayAct()).not.toThrow()
    expect(control.get().holder).toBe('bot')
  })

  it('pedido de ajuda não toma o controle: só marca requested + motivo', () => {
    const control = createControl()
    const state = control.requestHelp('parede de login no portal')
    expect(state.holder).toBe('bot')
    expect(state.requested).toBe(true)
    expect(state.reason).toBe('parede de login no portal')
    // O bot ainda age — quem decide assumir é a pessoa.
    expect(() => control.assertBotMayAct()).not.toThrow()
  })

  it('take preserva o motivo (é o que pediram à pessoa); release o descarta', () => {
    const control = createControl()
    control.requestHelp('preencher o captcha')
    expect(control.take().reason).toBe('preencher o captcha')
    expect(control.release().reason).toBeUndefined()
  })

  it('pedido de segredo sem ref é recusado — segredo nunca vai para "o campo com foco"', () => {
    const control = createControl()
    expect(() => control.requestSecret({ label: 'senha' })).toThrow(ControlRequestError)
    expect(control.pendingSecret()).toBeNull()
  })

  it('pedido de segredo guarda SÓ rótulo e ref; entregar limpa o pedido', () => {
    const control = createControl()
    control.requestSecret({ label: 'senha do portal', ref: 'e7', snapshotId: 3 })
    expect(control.pendingSecret()).toEqual({ ref: 'e7', snapshotId: 3 })
    expect(control.get().secretWanted).toBe('senha do portal')
    control.secretSupplied()
    expect(control.pendingSecret()).toBeNull()
  })

  it('take limpa segredo pendente: quem tem o browser inteiro digita na página', () => {
    const control = createControl()
    control.requestSecret({ ref: 'e7' })
    control.take()
    expect(control.pendingSecret()).toBeNull()
  })

  it('o estado devolvido é cópia — mutar por fora não move a máquina', () => {
    const control = createControl(() => '2026-08-20T00:00:00.000Z')
    const state = control.get()
    state.holder = 'human'
    expect(control.get().holder).toBe('bot')
    expect(control.get().since).toBe('2026-08-20T00:00:00.000Z')
  })
})
