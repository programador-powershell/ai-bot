/**
 * Readiness DINÂMICA: uma Task fica READY quando os INPUTS reais obrigatórios
 * existem — não por posição numa esteira imposta.
 *
 * O caso que motiva (aceite E7): Security não precisa esperar Build se o que
 * ela audita é o FONTE, que já existe. Impor Code→Build→Security
 * artificialmente serializa trabalho independente; deixar só o dependsOn
 * obriga o modelo a acertar arestas que ele não tem como conhecer. A regra
 * junta as duas fontes:
 *
 *   READY = todas as arestas dependsOn concluídas  E  todos os `needs` presentes
 *
 * dependsOn continua sendo a aresta DURA (ordem que alguém pediu); `needs` é
 * o requisito REAL (o insumo existe?). Uma tarefa sem `needs` declarado só
 * responde às arestas — o comportamento do oráculo, inalterado.
 */

import type { TaskSpec } from './task.js'

export class ReadinessTracker {
  readonly #tasks: readonly TaskSpec[]
  readonly #done = new Set<string>()
  readonly #inputs = new Set<string>()
  readonly #dispatched = new Set<string>()

  /**
   * `seedInputs` são os insumos que JÁ existem antes de qualquer tarefa rodar
   * (o fonte do repositório, um dataset baixado). Sem eles, toda tarefa com
   * `needs` nasceria bloqueada por definição.
   */
  constructor(tasks: readonly TaskSpec[], seedInputs: readonly string[] = []) {
    this.#tasks = tasks
    for (const input of seedInputs) {
      this.#inputs.add(input)
    }
  }

  /** Um insumo passou a existir (publicado, promovido, baixado). */
  provide(input: string): void {
    this.#inputs.add(input)
  }

  /** Marca a tarefa como despachada — sai da lista de prontas sem estar concluída. */
  markDispatched(taskId: string): void {
    this.#dispatched.add(taskId)
  }

  /**
   * Tarefa concluída COM verdade promovida: os `produces` dela passam a
   * existir para as demais. Concluir é o único caminho que publica outputs —
   * uma tarefa que falhou não entrega insumo nenhum.
   */
  complete(taskId: string): void {
    this.#done.add(taskId)
    this.#dispatched.delete(taskId)
    const task = this.#tasks.find((candidate) => candidate.id === taskId)
    for (const output of task?.produces ?? []) {
      this.#inputs.add(output)
    }
  }

  /** Falhou/retry: volta a ser elegível quando alguém re-despachar. */
  release(taskId: string): void {
    this.#dispatched.delete(taskId)
  }

  isDone(taskId: string): boolean {
    return this.#done.has(taskId)
  }

  hasInput(input: string): boolean {
    return this.#inputs.has(input)
  }

  /** A tarefa está pronta AGORA? (arestas concluídas E insumos presentes) */
  isReady(taskId: string): boolean {
    const task = this.#tasks.find((candidate) => candidate.id === taskId)
    if (task === undefined || this.#done.has(taskId) || this.#dispatched.has(taskId)) {
      return false
    }
    for (const dependency of task.dependsOn ?? []) {
      if (!this.#done.has(dependency)) return false
    }
    for (const need of task.needs ?? []) {
      if (!this.#inputs.has(need)) return false
    }
    return true
  }

  /** As prontas, na ORDEM DE DECLARAÇÃO — estável entre execuções, como o DAG. */
  ready(): string[] {
    return this.#tasks.filter((task) => this.isReady(task.id)).map((task) => task.id)
  }

  /**
   * As que nunca vão ficar prontas com o que há (insumo que ninguém produz) —
   * o diagnóstico honesto em vez de espera infinita: fila com MOTIVO.
   */
  starved(): Array<{ taskId: string; missing: string[] }> {
    const producible = new Set(this.#inputs)
    for (const task of this.#tasks) {
      for (const output of task.produces ?? []) {
        producible.add(output)
      }
    }
    const result: Array<{ taskId: string; missing: string[] }> = []
    for (const task of this.#tasks) {
      if (this.#done.has(task.id)) continue
      const missing = (task.needs ?? []).filter((need) => !producible.has(need))
      if (missing.length > 0) {
        result.push({ taskId: task.id, missing })
      }
    }
    return result
  }
}
