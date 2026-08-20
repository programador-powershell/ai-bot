/**
 * Planejador do DAG de tarefas — porte de internal/supervisor/dag.go do
 * oráculo Go, contrato e mensagens preservados.
 *
 * A razão de o planejamento ser uma função PURA, separada da execução: o
 * plano é CONGELADO quando o run nasce. Se o mesmo pedido gerasse um plano
 * diferente a cada chamada, o replay do run divergiria do que foi executado —
 * a pessoa veria um grafo que nunca aconteceu. Por isso toda ordem sai do
 * ÍNDICE original da tarefa (topological sort ESTÁVEL), nunca de iteração de
 * mapa.
 *
 * Sem dependência de terceiro: Kahn e a maior profundidade acumulada são
 * vinte linhas cada — um pacote de grafo custaria mais em homologação TI/SI
 * do que custa escrever.
 */

import type { TaskSpec } from './task.js'

// Tetos de SANIDADE, não de capacidade: um plano com mais que isso quase
// sempre é modelo alucinando lista, e o custo de descobrir rodando é alto
// (cada tarefa é um trabalhador).
export const MAX_TASKS = 128
export const MAX_DEPENDENCIES = 32

export const CONCURRENCY_FLOOR = 1
export const CONCURRENCY_CEIL = 32

/** A ferramenta que decide se a tarefa disputa arquivo com as outras. */
export const WRITE_TOOL = 'fs.write'

/** O resultado do planejamento — o formato que a tela desenha e o run guarda. */
export interface TaskPlan {
  valid: boolean
  waves: string[][]
  criticalPath: string[]
  maxParallelism: number
  warnings: string[]
}

export interface PlanOptions {
  /**
   * Valida o especialista da tarefa contra o catálogo (as MESMAS duas regras
   * da delegação: existir e não ser o master). Vem por seam porque o catálogo
   * mora no specialist-registry — o aceite "invalid specialist" é da E5; aqui
   * fica o gancho para o chamador ligá-lo.
   */
  specialistExists?: (id: string) => boolean
  masterId?: string
  /**
   * Diz se o especialista pode escrever (WRITE_TOOL) — alimenta o AVISO de
   * tarefas disputando os mesmos arquivos. Ausente = aviso desligado.
   */
  allowsWrite?: (specialistId: string) => boolean
}

/**
 * Valida a lista e devolve as ondas de execução.
 *
 * Os erros não embrulham causa porque não há causa embaixo: é validação de
 * dado, e a mensagem É o contrato — ela vai inteira para o modelo corrigir o
 * próprio plano.
 */
export function planTasks(
  tasks: readonly TaskSpec[],
  maxConcurrency: number,
  options: PlanOptions = {},
): TaskPlan {
  if (tasks.length === 0) {
    throw new Error('o plano precisa de pelo menos uma tarefa')
  }
  if (tasks.length > MAX_TASKS) {
    throw new Error('o plano aceita no máximo 128 tarefas')
  }
  if (maxConcurrency < CONCURRENCY_FLOOR || maxConcurrency > CONCURRENCY_CEIL) {
    throw new Error('a concorrência precisa estar entre 1 e 32')
  }

  // Primeira passada: identidade. Termina antes da segunda porque a checagem
  // de dependência inexistente depende do índice completo — senão "b depende
  // de c" acusaria falta de c só por c vir declarado depois.
  const indexByID = new Map<string, number>()
  tasks.forEach((task, index) => {
    // trim porque id só de espaço passa em `!== ''` e depois nunca casa com
    // dependência nenhuma: viraria tarefa órfã em vez de erro.
    if (task.id.trim() === '') {
      throw new Error(`a tarefa na posição ${index} está sem id`)
    }
    if (task.title.trim() === '') {
      throw new Error(`a tarefa "${task.id}" está sem título`)
    }
    if (indexByID.has(task.id)) {
      throw new Error(`id de tarefa repetido: "${task.id}"`)
    }
    const dependencies = task.dependsOn ?? []
    if (dependencies.length > MAX_DEPENDENCIES) {
      throw new Error(
        `a tarefa "${task.id}" depende de ${dependencies.length} outras; o limite é ${MAX_DEPENDENCIES}`,
      )
    }
    const requested = task.specialist.trim()
    if (requested === '') {
      throw new Error(`a tarefa "${task.id}" está sem especialista`)
    }
    if (options.masterId !== undefined && requested === options.masterId) {
      throw new Error(
        `a tarefa "${task.id}" pede o master, que só decide quem atende — escolha uma especialidade que execute`,
      )
    }
    if (options.specialistExists !== undefined && !options.specialistExists(requested)) {
      throw new Error(`a tarefa "${task.id}" pede o especialista "${requested}", que não existe`)
    }
    indexByID.set(task.id, index)
  })

  // Segunda passada: arestas. indegree conta quantas dependências faltam para
  // a tarefa poder rodar; outgoing lista quem ela libera ao terminar.
  const indegree = new Array<number>(tasks.length).fill(0)
  const outgoing: number[][] = tasks.map(() => [])
  tasks.forEach((task, index) => {
    const seen = new Set<string>()
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) {
        throw new Error(`a tarefa "${task.id}" depende de si mesma`)
      }
      // Dependência repetida é erro, não deduplicação silenciosa: somaria duas
      // vezes no indegree e a tarefa apareceria como "ciclo" — diagnóstico errado.
      if (seen.has(dependency)) {
        throw new Error(`a tarefa "${task.id}" repete a dependência "${dependency}"`)
      }
      seen.add(dependency)

      const parent = indexByID.get(dependency)
      if (parent === undefined) {
        throw new Error(`a tarefa "${task.id}" depende de "${dependency}", que não existe no plano`)
      }
      indegree[index] = indegree[index]! + 1
      outgoing[parent]!.push(index)
    }
  })

  // Kahn. `ready` guarda ÍNDICES em ordem crescente, nunca ids vindos de
  // estrutura sem ordem — sem ordem fixa o mesmo pedido geraria ondas
  // diferentes a cada execução, que a pessoa lê como defeito intermitente.
  let ready: number[] = []
  indegree.forEach((degree, index) => {
    if (degree === 0) ready.push(index)
  })
  const rootCount = ready.length

  // depth começa em 1: toda tarefa é caminho de tamanho 1 até ela mesma.
  const depth = new Array<number>(tasks.length).fill(1)
  const predecessor = new Array<number>(tasks.length).fill(-1)

  const waves: string[][] = []
  let processed = 0
  while (ready.length > 0) {
    const size = Math.min(ready.length, maxConcurrency)
    const selected = ready.slice(0, size)
    // O que sobrou da onda continua pronto e disputa a próxima com quem for
    // liberado agora.
    const remaining = ready.slice(size)

    waves.push(selected.map((index) => tasks[index]!.id))
    processed += size

    for (const parent of selected) {
      for (const child of outgoing[parent]!) {
        // Profundidade é do GRAFO, não do calendário: mede a corrente de
        // dependências e não muda quando a concorrência atrasa uma onda.
        if (depth[parent]! + 1 > depth[child]!) {
          depth[child] = depth[parent]! + 1
          predecessor[child] = parent
        }
        indegree[child] = indegree[child]! - 1
        if (indegree[child] === 0) {
          remaining.push(child)
        }
      }
    }

    remaining.sort((a, b) => a - b)
    ready = remaining
  }

  if (processed !== tasks.length) {
    // Quem sobrou com indegree > 0 está no ciclo ou preso atrás dele. Ordem de
    // declaração, que é estável entre execuções.
    const blocked: string[] = []
    indegree.forEach((degree, index) => {
      if (degree > 0) blocked.push(tasks[index]!.id)
    })
    throw new Error(`ciclo de dependências entre: ${blocked.join(', ')}`)
  }

  // Maior profundidade vence; empate fica com o menor índice original porque
  // o `>` estrito nunca troca o campeão por outro de mesma altura.
  let best = 0
  for (let index = 1; index < depth.length; index++) {
    if (depth[index]! > depth[best]!) {
      best = index
    }
  }
  const criticalPath: string[] = [tasks[best]!.id]
  for (let cursor = predecessor[best]!; cursor >= 0; cursor = predecessor[cursor]!) {
    criticalPath.push(tasks[cursor]!.id)
  }
  criticalPath.reverse()

  let maxParallelism = 0
  for (const wave of waves) {
    if (wave.length > maxParallelism) maxParallelism = wave.length
  }

  // Array sempre presente para o JSON sair como [] e não null: a tela itera direto.
  const warnings: string[] = []
  if (options.allowsWrite !== undefined) {
    let shared = 0
    for (const task of tasks) {
      if (task.worktree !== true && options.allowsWrite(task.specialist)) {
        shared++
      }
    }
    if (shared > 1) {
      // Duas tarefas que escrevem no mesmo checkout se sobrescrevem sem erro
      // nenhum: o git aceita, o build passa, e o trabalho de uma some.
      warnings.push(
        'nenhuma tarefa escreve em cópia isolada — tarefas que tocam o repositório vão disputar os mesmos arquivos',
      )
    }
  }
  if (rootCount > maxConcurrency) {
    warnings.push(
      `${rootCount} tarefas iniciais serão enfileiradas pela concorrência ${maxConcurrency}`,
    )
  }

  return { valid: true, waves, criticalPath, maxParallelism, warnings }
}

/**
 * O índice da onda da tarefa (a primeira é 0) ou -1 se ela não está no plano.
 * Busca linear de propósito: no máximo 128 ids, e um mapa duplicaria estado.
 */
export function waveOf(plan: TaskPlan, taskId: string): number {
  for (let index = 0; index < plan.waves.length; index++) {
    if (plan.waves[index]!.includes(taskId)) return index
  }
  return -1
}
