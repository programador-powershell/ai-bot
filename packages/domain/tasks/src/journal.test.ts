/**
 * O journal e o orçamento — os aceites E7 de durabilidade:
 * - estados task.* persistidos via StorageDriver (sqlite REAL, sem mock);
 * - transição ilegal morre barulhenta, não vira registro plausível;
 * - reinício do servidor no meio de uma onda NÃO zera o débito;
 * - o teto de 24 atravessa sub-equipes: o "ponteiro lógico" é a MESMA sessão
 *   de controle do Goal no store, provada por identidade e por contagem.
 */

import { describe, expect, it } from 'vitest'
import { SqliteEventStore } from '@aibot2/domain-events'
import { DEFAULT_CEILINGS, goalControlSessionId } from '@aibot2/domain-goals'
import { GoalBudget, TaskJournal, makeTaskRunId } from './index.js'

function memoryStore(): SqliteEventStore {
  return SqliteEventStore.open(':memory:')
}

describe('TaskJournal — estados persistidos via StorageDriver', () => {
  it('grava o ciclo created→ready→dispatched→started→done e o replay o reconstrói', async () => {
    const store = memoryStore()
    const journal = new TaskJournal(store, 'crm')
    const runId = makeTaskRunId('t1', 1)

    await journal.record({ state: 'task.created', taskId: 't1' })
    await journal.record({ state: 'task.ready', taskId: 't1' })
    await journal.record({
      state: 'task.dispatched',
      taskId: 't1',
      taskRunId: runId,
      attempt: 1,
      wave: 1,
      workerId: 'pc-02',
      leaseEpoch: 4,
      workspacePlanId: 'wp-1',
    })
    await journal.record({ state: 'task.started', taskId: 't1', taskRunId: runId })
    await journal.record({ state: 'task.progress', taskId: 't1', taskRunId: runId, detail: 'rodada 1' })
    await journal.record({ state: 'task.done', taskId: 't1', taskRunId: runId })

    const snapshot = await journal.replay()
    expect(snapshot.taskStates.get('t1')).toBe('task.done')
    expect(snapshot.dispatched).toBe(1)
    const run = snapshot.runs.get(runId)
    expect(run).toMatchObject({
      taskId: 't1',
      attempt: 1,
      state: 'task.done',
      workerId: 'pc-02',
      leaseEpoch: 4,
    })
    await store.close()
  })

  it('failed→retried→dispatched (attempt 2) registra a refação sem apagar a tentativa 1', async () => {
    const store = memoryStore()
    const journal = new TaskJournal(store, 'crm')

    await journal.record({ state: 'task.created', taskId: 't1' })
    await journal.record({ state: 'task.ready', taskId: 't1' })
    await journal.record({ state: 'task.dispatched', taskId: 't1', taskRunId: makeTaskRunId('t1', 1), attempt: 1 })
    await journal.record({ state: 'task.failed', taskId: 't1', taskRunId: makeTaskRunId('t1', 1), detail: 'estourou' })
    await journal.record({ state: 'task.retried', taskId: 't1' })
    await journal.record({ state: 'task.dispatched', taskId: 't1', taskRunId: makeTaskRunId('t1', 2), attempt: 2 })

    const snapshot = await journal.replay()
    expect(snapshot.dispatched).toBe(2)
    expect(snapshot.runs.get('run-t1-a1')?.state).toBe('task.failed')
    expect(snapshot.runs.get('run-t1-a2')?.state).toBe('task.dispatched')
    await store.close()
  })

  it('conflict (a cerca recusou a publicação) é desfecho durável e reabre via retried', async () => {
    const store = memoryStore()
    const journal = new TaskJournal(store, 'crm')
    await journal.record({ state: 'task.created', taskId: 't1' })
    await journal.record({ state: 'task.ready', taskId: 't1' })
    await journal.record({ state: 'task.dispatched', taskId: 't1', taskRunId: 'run-t1-a1', attempt: 1 })
    await journal.record({
      state: 'task.conflict',
      taskId: 't1',
      taskRunId: 'run-t1-a1',
      detail: 'época 4 tentou promover; a dona é a 5',
    })
    expect(journal.stateOf('t1')).toBe('task.conflict')
    await journal.record({ state: 'task.retried', taskId: 't1' })
    await store.close()
  })

  it('transição ilegal morre barulhenta — done não nasce de created', async () => {
    const store = memoryStore()
    const journal = new TaskJournal(store, 'crm')
    await journal.record({ state: 'task.created', taskId: 't1' })
    await expect(
      journal.record({ state: 'task.done', taskId: 't1', taskRunId: 'run-t1-a1' }),
    ).rejects.toThrow(/transição ilegal.*task\.created → task\.done/)
    // Primeira transição de uma tarefa só pode ser created.
    await expect(journal.record({ state: 'task.started', taskId: 't2' })).rejects.toThrow(
      /transição ilegal/,
    )
    await store.close()
  })

  it('o reinício reidrata a máquina de estados do log — não recomeça do zero', async () => {
    const store = memoryStore()
    const antes = new TaskJournal(store, 'crm')
    await antes.record({ state: 'task.created', taskId: 't1' })
    await antes.record({ state: 'task.ready', taskId: 't1' })

    // "Reinício": outra instância sobre o MESMO store.
    const depois = new TaskJournal(store, 'crm')
    await depois.open()
    expect(depois.stateOf('t1')).toBe('task.ready')
    // E a máquina continua de onde parou: created de novo seria ilegal.
    await expect(depois.record({ state: 'task.created', taskId: 't1' })).rejects.toThrow(
      /transição ilegal/,
    )
    await store.close()
  })
})

describe('GoalBudget — o teto durável por Goal (D6)', () => {
  it('reinício do servidor no meio de uma onda NÃO zera o débito', async () => {
    const store = memoryStore()
    const journal = new TaskJournal(store, 'crm')
    const budget = new GoalBudget(journal, { ...DEFAULT_CEILINGS, maxTotal: 5 })

    // A onda despachou 4 trabalhadores e o processo caiu.
    await budget.take(4)
    for (let index = 1; index <= 4; index++) {
      await journal.record({ state: 'task.created', taskId: `t${index}` })
      await journal.record({ state: 'task.ready', taskId: `t${index}` })
      await journal.record({
        state: 'task.dispatched',
        taskId: `t${index}`,
        taskRunId: makeTaskRunId(`t${index}`, 1),
        attempt: 1,
      })
      budget.confirmDispatch()
    }

    // "Reinício": journal e budget novos sobre o MESMO store.
    const budgetDepois = new GoalBudget(new TaskJournal(store, 'crm'), {
      ...DEFAULT_CEILINGS,
      maxTotal: 5,
    })
    expect(await budgetDepois.spent()).toBe(4)
    await expect(budgetDepois.take(2)).rejects.toThrow(/teto da política é 5/)
    await budgetDepois.take(1) // a última vaga continua sendo UMA
    await store.close()
  })

  it('o teto atravessa sub-equipes: mesmo goalId = mesma sessão de controle = mesmo débito', async () => {
    const store = memoryStore()
    // A equipe raiz e a sub-equipe montam instâncias PRÓPRIAS (processos ou
    // turnos diferentes) — o que as une é o goalId.
    const raiz = new TaskJournal(store, 'crm')
    const subEquipe = new TaskJournal(store, 'crm')
    expect(raiz.sessionId).toBe(subEquipe.sessionId)
    expect(raiz.sessionId).toBe(goalControlSessionId('crm'))

    const ceilings = { ...DEFAULT_CEILINGS, maxTotal: 3 }
    const budgetRaiz = new GoalBudget(raiz, ceilings)
    const budgetSub = new GoalBudget(subEquipe, ceilings)

    await budgetRaiz.take(2)
    await raiz.record({ state: 'task.created', taskId: 'a' })
    await raiz.record({ state: 'task.ready', taskId: 'a' })
    await raiz.record({ state: 'task.dispatched', taskId: 'a', taskRunId: 'run-a-a1', attempt: 1 })
    budgetRaiz.confirmDispatch()
    await raiz.record({ state: 'task.created', taskId: 'b' })
    await raiz.record({ state: 'task.ready', taskId: 'b' })
    await raiz.record({ state: 'task.dispatched', taskId: 'b', taskRunId: 'run-b-a1', attempt: 1 })
    budgetRaiz.confirmDispatch()

    // A sub-equipe NÃO ganha orçamento novo: só resta 1 vaga das 3.
    await expect(budgetSub.take(2)).rejects.toThrow(/já usou 2 trabalhador\(es\)/)
    await budgetSub.take(1)
    await store.close()
  })

  it('goal DIFERENTE tem orçamento próprio — o isolamento é por sessão de controle', async () => {
    const store = memoryStore()
    const crm = new TaskJournal(store, 'crm')
    await crm.record({ state: 'task.created', taskId: 'a' })
    await crm.record({ state: 'task.ready', taskId: 'a' })
    await crm.record({ state: 'task.dispatched', taskId: 'a', taskRunId: 'run-a-a1', attempt: 1 })

    const outro = new GoalBudget(new TaskJournal(store, 'site'), {
      ...DEFAULT_CEILINGS,
      maxTotal: 1,
    })
    expect(await outro.spent()).toBe(0)
    await outro.take(1)
    await store.close()
  })
})
