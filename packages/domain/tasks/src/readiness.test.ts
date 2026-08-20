/**
 * Readiness dinâmica — o aceite E7: Task READY quando os inputs reais
 * obrigatórios EXISTEM, sem impor Code→Build→Security artificialmente.
 */

import { describe, expect, it } from 'vitest'
import { ReadinessTracker, makeTaskRunId, canTransition, type TaskSpec } from './index.js'

const tasks: TaskSpec[] = [
  {
    id: 'code',
    title: 'implementar',
    specialist: 'code',
    goal: 'escrever o handler',
    needs: ['fonte'],
    produces: ['fonte-alterado'],
  },
  {
    id: 'build',
    title: 'compilar',
    specialist: 'code',
    goal: 'gerar o binário',
    needs: ['fonte-alterado'],
    produces: ['binario'],
  },
  {
    id: 'security',
    title: 'auditar o fonte',
    specialist: 'security',
    goal: 'revisar o código-fonte',
    // Security só precisa do FONTE, que já existe: não espera o Build.
    needs: ['fonte'],
  },
  {
    id: 'smoke',
    title: 'smoke test',
    specialist: 'code',
    goal: 'rodar o binário',
    needs: ['binario'],
  },
]

describe('ReadinessTracker', () => {
  it('não impõe Code→Build→Security: Security fica READY junto com Code, pelo insumo real', () => {
    const tracker = new ReadinessTracker(tasks, ['fonte'])
    // Build espera o fonte-alterado; smoke espera o binário.
    expect(tracker.ready()).toEqual(['code', 'security'])
  })

  it('o insumo passa a existir quando quem o produz CONCLUI — e destrava a jusante', () => {
    const tracker = new ReadinessTracker(tasks, ['fonte'])
    tracker.markDispatched('code')
    tracker.markDispatched('security')
    expect(tracker.ready()).toEqual([])

    tracker.complete('code') // publica fonte-alterado
    expect(tracker.ready()).toEqual(['build'])

    tracker.markDispatched('build')
    tracker.complete('build') // publica binario
    expect(tracker.ready()).toEqual(['smoke'])
  })

  it('tarefa que falhou é liberada e volta a ser elegível para a retentativa', () => {
    const tracker = new ReadinessTracker(tasks, ['fonte'])
    tracker.markDispatched('code')
    expect(tracker.isReady('code')).toBe(false)
    tracker.release('code')
    expect(tracker.isReady('code')).toBe(true)
  })

  it('dependsOn continua sendo aresta DURA além dos insumos', () => {
    const comAresta: TaskSpec[] = [
      { id: 'a', title: 'a', specialist: 'code', goal: 'g' },
      { id: 'b', title: 'b', specialist: 'code', goal: 'g', dependsOn: ['a'], needs: ['fonte'] },
    ]
    const tracker = new ReadinessTracker(comAresta, ['fonte'])
    expect(tracker.ready()).toEqual(['a']) // b tem o insumo, mas a aresta manda esperar
    tracker.complete('a')
    expect(tracker.ready()).toEqual(['b'])
  })

  it('insumo que NINGUÉM produz vira fila com motivo, não espera infinita', () => {
    const tracker = new ReadinessTracker(tasks, []) // nem o fonte existe
    const starved = tracker.starved()
    expect(starved).toContainEqual({ taskId: 'code', missing: ['fonte'] })
    expect(starved).toContainEqual({ taskId: 'security', missing: ['fonte'] })
    // build/smoke não entram: alguém DECLARA produzir o que eles precisam.
    expect(starved.map((entry) => entry.taskId)).not.toContain('build')
  })
})

describe('TaskRunID lógico', () => {
  it('é tarefa+tentativa e NUNCA contém máquina — a assinatura nem recebe worker', () => {
    expect(makeTaskRunId('t7', 1)).toBe('run-t7-a1')
    expect(makeTaskRunId('t7', 2)).toBe('run-t7-a2')
    expect(makeTaskRunId('t7', 2)).not.toContain('pc-')
  })

  it('recusa tarefa vazia e tentativa < 1', () => {
    expect(() => makeTaskRunId(' ', 1)).toThrow(/sem tarefa/)
    expect(() => makeTaskRunId('t1', 0)).toThrow(/tentativa/)
  })
})

describe('máquina de estados', () => {
  it('nascer só aceita task.created; done é terminal; failed reabre via retried', () => {
    expect(canTransition(undefined, 'task.created')).toBe(true)
    expect(canTransition(undefined, 'task.done')).toBe(false)
    expect(canTransition('task.done', 'task.retried')).toBe(false)
    expect(canTransition('task.failed', 'task.retried')).toBe(true)
    expect(canTransition('task.retried', 'task.dispatched')).toBe(true)
    expect(canTransition('task.conflict', 'task.retried')).toBe(true)
    expect(canTransition('task.created', 'task.done')).toBe(false)
  })
})
