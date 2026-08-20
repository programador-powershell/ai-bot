/**
 * Bateria do DAG — porte caso a caso do dag_test.go do oráculo, mais os
 * aceites E7: sort topológico ESTÁVEL (mesmo pedido, mesmas ondas), ciclo
 * detectado com a lista dos presos, caminho crítico e tetos de sanidade.
 */

import { describe, expect, it } from 'vitest'
import { planTasks, waveOf, type TaskSpec } from './index.js'

function task(id: string, dependsOn: string[] = [], over: Partial<TaskSpec> = {}): TaskSpec {
  return { id, title: `tarefa ${id}`, specialist: 'code', goal: `objetivo ${id}`, dependsOn, ...over }
}

describe('planTasks — ondas determinísticas', () => {
  it('monta as ondas por dependência, na ordem de declaração', () => {
    const plan = planTasks([task('a'), task('b'), task('c', ['a', 'b']), task('d', ['c'])], 4)
    expect(plan.waves).toEqual([['a', 'b'], ['c'], ['d']])
    expect(plan.maxParallelism).toBe(2)
    expect(waveOf(plan, 'c')).toBe(1)
    expect(waveOf(plan, 'inexistente')).toBe(-1)
  })

  it('é ESTÁVEL: o mesmo pedido gera exatamente o mesmo plano, sempre', () => {
    const tasks = [task('z'), task('m', ['z']), task('a'), task('k', ['a', 'z'])]
    const primeiro = planTasks(tasks, 2)
    for (let round = 0; round < 20; round++) {
      expect(planTasks(tasks, 2)).toEqual(primeiro)
    }
    // A ordem dentro da onda é a de DECLARAÇÃO (índice), não alfabética.
    expect(primeiro.waves[0]).toEqual(['z', 'a'])
  })

  it('a concorrência limita a onda e o excedente disputa a seguinte', () => {
    const plan = planTasks([task('a'), task('b'), task('c')], 2)
    expect(plan.waves).toEqual([['a', 'b'], ['c']])
    expect(plan.warnings.join(' ')).toContain('3 tarefas iniciais serão enfileiradas')
  })

  it('caminho crítico é a corrente mais longa; empate fica com o índice menor', () => {
    const plan = planTasks(
      [task('a'), task('b', ['a']), task('c', ['b']), task('x'), task('y', ['x'])],
      4,
    )
    expect(plan.criticalPath).toEqual(['a', 'b', 'c'])
  })
})

describe('planTasks — validação (a mensagem é o contrato)', () => {
  it('ciclo de dependências lista QUEM está preso, em ordem de declaração', () => {
    expect(() =>
      planTasks([task('a', ['c']), task('b', ['a']), task('c', ['b']), task('livre')], 4),
    ).toThrow('ciclo de dependências entre: a, b, c')
  })

  it('dependência de si mesma é ciclo nomeado na hora', () => {
    expect(() => planTasks([task('a', ['a'])], 4)).toThrow('depende de si mesma')
  })

  it('dependência repetida é erro, não deduplicação silenciosa', () => {
    expect(() => planTasks([task('a'), task('b', ['a', 'a'])], 4)).toThrow(
      'repete a dependência',
    )
  })

  it('dependência inexistente diz o nome que falta', () => {
    expect(() => planTasks([task('a', ['fantasma'])], 4)).toThrow(
      'depende de "fantasma", que não existe no plano',
    )
  })

  it('id vazio, título vazio, id repetido e especialista vazio recusam', () => {
    expect(() => planTasks([task('  ')], 4)).toThrow('está sem id')
    expect(() => planTasks([{ ...task('a'), title: ' ' }], 4)).toThrow('está sem título')
    expect(() => planTasks([task('a'), task('a')], 4)).toThrow('id de tarefa repetido')
    expect(() => planTasks([{ ...task('a'), specialist: ' ' }], 4)).toThrow('está sem especialista')
  })

  it('tetos de sanidade: 0 tarefas, 129 tarefas, concorrência fora de 1..32', () => {
    expect(() => planTasks([], 4)).toThrow('pelo menos uma tarefa')
    const demais = Array.from({ length: 129 }, (_, index) => task(`t${index}`))
    expect(() => planTasks(demais, 4)).toThrow('no máximo 128 tarefas')
    expect(() => planTasks([task('a')], 0)).toThrow('entre 1 e 32')
    expect(() => planTasks([task('a')], 33)).toThrow('entre 1 e 32')
  })

  it('mais de 32 dependências recusa com a contagem', () => {
    const parents = Array.from({ length: 33 }, (_, index) => task(`p${index}`))
    const child = task('filho', parents.map((parent) => parent.id))
    expect(() => planTasks([...parents, child], 4)).toThrow('o limite é 32')
  })

  it('master e especialista inexistente recusam quando o seam está ligado (regra da E5)', () => {
    const options = {
      masterId: 'master',
      specialistExists: (id: string) => id === 'code',
    }
    expect(() => planTasks([task('a', [], { specialist: 'master' })], 4, options)).toThrow(
      'pede o master',
    )
    expect(() => planTasks([task('a', [], { specialist: 'ghost' })], 4, options)).toThrow(
      'que não existe',
    )
  })

  it('avisa quando duas tarefas que escrevem não pedem cópia isolada', () => {
    const plan = planTasks([task('a'), task('b')], 4, { allowsWrite: () => true })
    expect(plan.warnings.join(' ')).toContain('disputar os mesmos arquivos')
    const isolado = planTasks([task('a', [], { worktree: true }), task('b')], 4, {
      allowsWrite: () => true,
    })
    expect(isolado.warnings.join(' ')).not.toContain('disputar')
  })
})
