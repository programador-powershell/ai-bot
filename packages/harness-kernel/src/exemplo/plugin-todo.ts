/**
 * Plugin-exemplo: o gabarito de DX que os plugins reais copiam (aceite E1).
 * O molde é o do tool-todo do harness — a FORMA, nunca as linhas (clean-room):
 *
 *  1. exports nomeados `name` / `inject` / `apply`: o namespace do módulo é o
 *     plugin (forma objeto), então `ctx.plugin(import * as ...)` monta direto;
 *  2. config explícita e tipada: política de deploy não mora em default
 *     escondido dentro do plugin — quem monta declara o que quer;
 *  3. tudo que o plugin registra passa por ctx.effect/ctx.on: o unload desfaz
 *     o plugin INTEIRO sem lista manual de limpeza;
 *  4. o plugin depende do SEAM (RegistroDeFerramentas), nunca de um provider
 *     concreto — nos testes ele roda contra um fake, e é assim que os plugins
 *     reais nascem testáveis sem processo de pé.
 */

import type { Context } from '../context.js'

/** Uma ferramenta como o seam a enxerga: nome, descrição e execução. */
export interface Ferramenta {
  name: string
  description: string
  execute(args: unknown): unknown
}

/**
 * O seam que este plugin consome. O provider real chega nas etapas seguintes
 * do M1; o contrato mínimo (registrar/desregistrar) já basta para o gabarito.
 */
export interface RegistroDeFerramentas {
  register(ferramenta: Ferramenta): void
  unregister(name: string): void
}

declare module '../context.js' {
  interface Context {
    tools: RegistroDeFerramentas
  }
}

declare module '../events.js' {
  interface Events {
    /** Disparado a cada substituição bem-sucedida da lista. */
    'exemplo-todo/atualizada'(tarefas: readonly Tarefa[]): void
  }
}

export type StatusTarefa = 'pendente' | 'em_andamento' | 'concluida'

export interface Tarefa {
  conteudo: string
  status: StatusTarefa
}

/** Config do deploy — obrigatória e sem default, de propósito. */
export interface Config {
  /**
   * Se várias tarefas podem estar `em_andamento` ao mesmo tempo. É política
   * de quem monta (agente paralelo × disciplina de uma ativa), não do plugin.
   */
  permitirParalelo: boolean
}

export const name = 'exemplo-todo'
export const inject = ['tools'] as const

const STATUS_VALIDOS: ReadonlySet<string> = new Set([
  'pendente',
  'em_andamento',
  'concluida',
])

/**
 * Valida o que o schema de borda não expressa e devolve a lista canônica:
 * conteúdo não-vazio e único, status do conjunto fechado, e no máximo uma
 * tarefa ativa quando o deploy exige disciplina. A chamada substitui a lista
 * INTEIRA — não existem edições parciais, então a validação é tudo-ou-nada.
 */
function normalizarLista(bruto: unknown, permitirParalelo: boolean): Tarefa[] {
  if (!Array.isArray(bruto)) {
    throw new TypeError(
      'todo_write: envie a lista INTEIRA em `tarefas` — cada chamada substitui a anterior',
    )
  }
  const tarefas: Tarefa[] = []
  const vistos = new Set<string>()
  let ativas = 0
  for (const item of bruto as { conteudo?: unknown; status?: unknown }[]) {
    const conteudo = typeof item?.conteudo === 'string' ? item.conteudo.trim() : ''
    if (conteudo === '') {
      throw new Error('todo_write: `conteudo` precisa ser texto não-vazio')
    }
    if (vistos.has(conteudo)) {
      throw new Error(`todo_write: tarefa duplicada: ${JSON.stringify(conteudo)}`)
    }
    vistos.add(conteudo)
    const status = item.status
    if (typeof status !== 'string' || !STATUS_VALIDOS.has(status)) {
      throw new Error(
        `todo_write: status inválido ${JSON.stringify(status)} — use pendente | em_andamento | concluida`,
      )
    }
    if (status === 'em_andamento') ativas++
    tarefas.push({ conteudo, status: status as StatusTarefa })
  }
  if (!permitirParalelo && ativas > 1) {
    throw new Error(`todo_write: no máximo uma tarefa em_andamento (recebi ${ativas})`)
  }
  return tarefas
}

export function apply(ctx: Context, config: Config): void {
  const ferramenta: Ferramenta = {
    name: 'todo_write',
    description:
      'Registra a lista de tarefas do trabalho atual. Envie a lista INTEIRA a cada ' +
      'chamada — ela SUBSTITUI a anterior (não há edição parcial).',
    execute(args: unknown) {
      const { tarefas: bruto } = (args ?? {}) as { tarefas?: unknown }
      const tarefas = normalizarLista(bruto, config.permitirParalelo)
      // Quem quiser reagir à lista (projeção, presença) ouve o evento — a
      // ferramenta não conhece os interessados.
      ctx.emit('exemplo-todo/atualizada', tarefas)
      const contar = (status: StatusTarefa): number =>
        tarefas.filter((tarefa) => tarefa.status === status).length
      return {
        tarefas,
        contagem: {
          pendentes: contar('pendente'),
          emAndamento: contar('em_andamento'),
          concluidas: contar('concluida'),
        },
      }
    },
  }
  // O registro é um efeito: montar registra, unload desregistra — nada vaza.
  ctx.effect(() => {
    ctx.tools.register(ferramenta)
    return () => ctx.tools.unregister(ferramenta.name)
  }, 'exemplo-todo:tool')
}
