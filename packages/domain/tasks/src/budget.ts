/**
 * O orçamento da equipe, DURÁVEL e por GOAL — porte do crewBudget do crew.go
 * com a residência trocada (D6): sai do context.Context de processo, entra no
 * store.
 *
 * O débito É derivado do log: cada unidade tomada corresponde a exatamente um
 * despacho de TaskRun, e o TaskJournal conta os despachos no replay. Por isso:
 *
 *   - reinício do servidor no meio de uma onda NÃO zera o débito (os
 *     despachos estão no log, o replay os reconta);
 *   - sub-equipe herda o MESMO orçamento por herdar o MESMO goalId — a
 *     "asserção de ponteiro lógico" do aceite é a identidade da sessão de
 *     controle, não um ponteiro de memória.
 *
 * A janela entre reservar e despachar fica em memória (reserved): reserva que
 * morre com o processo é reserva de uma onda que morreu junto — re-executar a
 * onda re-reserva, e o que JÁ foi despachado continua contado pelo log.
 */

import type { CrewCeilings } from '@aibot2/domain-goals'
import type { TaskJournal } from './journal.js'

export class GoalBudget {
  readonly #journal: TaskJournal
  readonly #ceilings: CrewCeilings
  #reserved = 0

  constructor(journal: TaskJournal, ceilings: CrewCeilings) {
    this.#journal = journal
    this.#ceilings = ceilings
  }

  /** Quanto o Goal já gastou DE VERDADE (despachos no log). */
  async spent(): Promise<number> {
    const snapshot = await this.#journal.replay()
    return snapshot.dispatched
  }

  /**
   * Reserva `count` trabalhadores contra o teto. O erro é TEXTO para o modelo
   * ler e corrigir o plano — a mesma frase do oráculo, com o turno trocado
   * pelo goal (a residência nova).
   */
  async take(count: number): Promise<void> {
    const limit = this.#ceilings.maxTotal
    if (limit <= 0) {
      this.#reserved += count
      return
    }
    const spent = await this.spent()
    if (spent + this.#reserved + count > limit) {
      throw new Error(
        `este goal já usou ${spent + this.#reserved} trabalhador(es) e o teto da política é ${limit} — ` +
          'junte tarefas ou resolva o que falta sem montar outra equipe',
      )
    }
    this.#reserved += count
  }

  /**
   * Converte uma reserva em gasto real: chamada quando o despacho foi
   * REGISTRADO no journal (que é quem passa a contá-lo). Sem isto a unidade
   * seria contada duas vezes — uma na reserva, outra no replay.
   */
  confirmDispatch(): void {
    if (this.#reserved > 0) {
      this.#reserved--
    }
  }

  /** Devolve reservas de uma onda que não vai mais despachar (plano abortado). */
  releaseReservation(count: number): void {
    this.#reserved = Math.max(0, this.#reserved - count)
  }
}
