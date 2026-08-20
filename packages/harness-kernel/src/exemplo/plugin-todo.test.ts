/**
 * Aceite E1 — o plugin-exemplo compila e RODA contra um serviço fake
 * (m1-plano §5). O fake implementa só o seam — é exatamente assim que os
 * plugins reais devem ser testados: sem provider concreto, sem processo de pé.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '../context.js'
import * as pluginTodo from './plugin-todo.js'
import type { Ferramenta, RegistroDeFerramentas, Tarefa } from './plugin-todo.js'

class RegistroFake implements RegistroDeFerramentas {
  readonly registradas = new Map<string, Ferramenta>()

  register(ferramenta: Ferramenta): void {
    this.registradas.set(ferramenta.name, ferramenta)
  }

  unregister(name: string): void {
    this.registradas.delete(name)
  }
}

interface ResultadoTodoWrite {
  tarefas: Tarefa[]
  contagem: { pendentes: number; emAndamento: number; concluidas: number }
}

function montar(config: pluginTodo.Config) {
  const ctx = new Context()
  const registro = new RegistroFake()
  ctx.plugin((c: Context) => {
    c.provide('tools', registro)
  })
  const handle = ctx.plugin(pluginTodo, config)
  return { ctx, registro, handle }
}

describe('plugin-exemplo (molde do tool-todo)', () => {
  it('monta pelo namespace do módulo (forma objeto) e registra a ferramenta no seam', () => {
    const { registro } = montar({ permitirParalelo: false })
    expect(registro.registradas.has('todo_write')).toBe(true)
  })

  it('execute substitui a lista inteira, canoniza e conta por status', () => {
    const { registro } = montar({ permitirParalelo: false })
    const ferramenta = registro.registradas.get('todo_write')!
    const resultado = ferramenta.execute({
      tarefas: [
        { conteudo: '  portar o kernel  ', status: 'concluida' },
        { conteudo: 'escrever os testes', status: 'em_andamento' },
        { conteudo: 'rodar a suíte', status: 'pendente' },
      ],
    }) as ResultadoTodoWrite
    expect(resultado.tarefas[0]!.conteudo).toBe('portar o kernel')
    expect(resultado.contagem).toEqual({ pendentes: 1, emAndamento: 1, concluidas: 1 })
  })

  it('emite o evento tipado a cada substituição bem-sucedida', () => {
    const { ctx, registro } = montar({ permitirParalelo: false })
    const listas: (readonly Tarefa[])[] = []
    ctx.on('exemplo-todo/atualizada', (tarefas) => {
      listas.push(tarefas)
    })
    const ferramenta = registro.registradas.get('todo_write')!
    ferramenta.execute({ tarefas: [{ conteudo: 'única', status: 'pendente' }] })
    expect(listas).toHaveLength(1)
    expect(listas[0]![0]!.conteudo).toBe('única')
  })

  it('disciplina de uma ativa: duas em_andamento com permitirParalelo=false é recusa', () => {
    const { registro } = montar({ permitirParalelo: false })
    const ferramenta = registro.registradas.get('todo_write')!
    expect(() =>
      ferramenta.execute({
        tarefas: [
          { conteudo: 'a', status: 'em_andamento' },
          { conteudo: 'b', status: 'em_andamento' },
        ],
      }),
    ).toThrow('no máximo uma tarefa em_andamento')
  })

  it('permitirParalelo=true aceita várias em_andamento — a política é do deploy', () => {
    const { registro } = montar({ permitirParalelo: true })
    const ferramenta = registro.registradas.get('todo_write')!
    const resultado = ferramenta.execute({
      tarefas: [
        { conteudo: 'a', status: 'em_andamento' },
        { conteudo: 'b', status: 'em_andamento' },
      ],
    }) as ResultadoTodoWrite
    expect(resultado.contagem.emAndamento).toBe(2)
  })

  it('conteúdo vazio, duplicado ou status fora do conjunto fechado são recusa', () => {
    const { registro } = montar({ permitirParalelo: false })
    const ferramenta = registro.registradas.get('todo_write')!
    expect(() =>
      ferramenta.execute({ tarefas: [{ conteudo: '   ', status: 'pendente' }] }),
    ).toThrow('não-vazio')
    expect(() =>
      ferramenta.execute({
        tarefas: [
          { conteudo: 'igual', status: 'pendente' },
          { conteudo: 'igual', status: 'concluida' },
        ],
      }),
    ).toThrow('duplicada')
    expect(() =>
      ferramenta.execute({ tarefas: [{ conteudo: 'ok', status: 'fazendo' }] }),
    ).toThrow('status inválido')
    expect(() => ferramenta.execute({})).toThrow('lista INTEIRA')
  })

  it('unload remove a ferramenta do seam — nada vaza', async () => {
    const { registro, handle } = montar({ permitirParalelo: false })
    expect(registro.registradas.has('todo_write')).toBe(true)
    await handle.dispose()
    expect(registro.registradas.has('todo_write')).toBe(false)
  })

  it('sem o serviço tools a montagem falha na hora — o apply nem roda', () => {
    const ctx = new Context()
    expect(() => ctx.plugin(pluginTodo, { permitirParalelo: false })).toThrow('tools')
  })
})
