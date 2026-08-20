/**
 * O contrato OrchestratorDecision (spec §7): schema FECHADO, enums fechados,
 * especialista validado contra o registro, ciclo detectado — e saída inválida
 * virando retry/fallback controlado no orchestrate(), nunca propagada crua.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { SpecialistRegistry } from '@aibot2/specialist-registry'
import { ORCHESTRATE_MAX_ATTEMPTS } from './constants.js'
import { validateDecision, type OrchestratorDecision } from './decision.js'
import { RouterService } from './router.js'
import type { OrchestratorModel } from './seams.js'

const KNOWN = new Set(['chat', 'code', 'data', 'security'])
const executorExists = (id: string): boolean => KNOWN.has(id)

/** Uma decisão de plano VÁLIDA — a base que os testes deformam. */
function validPlan(): Record<string, unknown> {
  return {
    decisionId: 'd-1',
    mode: 'plan',
    confidence: 0.9,
    tasks: [
      { id: 't1', title: 'Especificar', specialist: 'code', objective: 'spec', dependsOn: [], requirements: {} },
      { id: 't2', title: 'Implementar', specialist: 'code', objective: 'impl', dependsOn: ['t1'], requirements: {} },
      { id: 't3', title: 'Revisar segurança', specialist: 'security', objective: 'rev', dependsOn: ['t2'], requirements: {} },
    ],
  }
}

function problemsOf(raw: unknown): string[] {
  const verdict = validateDecision(raw, executorExists)
  expect(verdict.ok).toBe(false)
  return verdict.ok ? [] : verdict.problems
}

describe('validateDecision', () => {
  it('aceita um plano bem formado, com DAG legítimo', () => {
    const verdict = validateDecision(validPlan(), executorExists)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.decision.mode).toBe('plan')
      expect(verdict.decision.tasks?.length).toBe(3)
    }
  })

  it('aceita os modos sem carga extra (direct/continue/finish)', () => {
    for (const mode of ['direct', 'continue', 'finish']) {
      const verdict = validateDecision({ decisionId: 'd', mode, confidence: 0.5 }, executorExists)
      expect(verdict.ok, `modo ${mode}`).toBe(true)
    }
  })

  it('enum estranho é INVÁLIDO — nunca "o modo mais parecido"', () => {
    const problems = problemsOf({ ...validPlan(), mode: 'planejar' })
    expect(problems.some((p) => p.includes('`mode` "planejar" fora do conjunto'))).toBe(true)
  })

  it('schema FECHADO: campo desconhecido em qualquer nível é recusa', () => {
    expect(problemsOf({ ...validPlan(), workerId: 'pc-do-daniel' })
      .some((p) => p.includes('campo desconhecido "workerId"'))).toBe(true)

    const plan = validPlan()
    ;(plan.tasks as Record<string, unknown>[])[0]!.dockerImage = 'ubuntu'
    expect(problemsOf(plan).some((p) => p.includes('campo desconhecido "dockerImage"'))).toBe(true)
  })

  it('especialista fora do registro é recusado — o modelo não inventa executor', () => {
    const plan = validPlan()
    ;(plan.tasks as Record<string, unknown>[])[1]!.specialist = 'hacker'
    expect(problemsOf(plan).some((p) => p.includes('especialista "hacker" não existe no registro'))).toBe(true)
  })

  it('dependsOn com id desconhecido e CICLO são recusados, com o caminho no erro', () => {
    const dangling = validPlan()
    ;(dangling.tasks as Record<string, unknown>[])[1]!.dependsOn = ['t9']
    expect(problemsOf(dangling).some((p) => p.includes('aponta para "t9"'))).toBe(true)

    const cyclic = validPlan()
    ;(cyclic.tasks as Record<string, unknown>[])[0]!.dependsOn = ['t3']
    expect(problemsOf(cyclic).some((p) => p.includes('ciclo em dependsOn'))).toBe(true)

    // Auto-ciclo também é ciclo.
    const self = validPlan()
    ;(self.tasks as Record<string, unknown>[])[0]!.dependsOn = ['t1']
    expect(problemsOf(self).some((p) => p.includes('ciclo em dependsOn'))).toBe(true)
  })

  it('coerência modo × carga: plan sem tasks, delegate sem calls, ask_owner sem pedido', () => {
    expect(problemsOf({ decisionId: 'd', mode: 'plan', confidence: 0.5 })
      .some((p) => p.includes('modo plan sem `tasks`'))).toBe(true)
    expect(problemsOf({ decisionId: 'd', mode: 'delegate', confidence: 0.5 })
      .some((p) => p.includes('modo delegate sem `calls`'))).toBe(true)
    expect(problemsOf({ decisionId: 'd', mode: 'ask_owner', confidence: 0.5 })
      .some((p) => p.includes('modo ask_owner sem `ownerRequest`'))).toBe(true)
  })

  it('confidence fora de 0..1, decisionId vazio e não-objeto são recusados', () => {
    expect(problemsOf({ decisionId: 'd', mode: 'finish', confidence: 1.2 })
      .some((p) => p.includes('fora de 0..1'))).toBe(true)
    expect(problemsOf({ decisionId: '  ', mode: 'finish', confidence: 0.5 })
      .some((p) => p.includes('sem `decisionId`'))).toBe(true)
    expect(problemsOf('mode: plan')).toEqual(['a decisão não é um objeto JSON'])
    expect(problemsOf([validPlan()])).toEqual(['a decisão não é um objeto JSON'])
  })

  it('todos os problemas vêm JUNTOS — depurar saída de modelo não é um erro por tentativa', () => {
    const problems = problemsOf({
      decisionId: '',
      mode: 'inventado',
      confidence: 7,
      tasks: [{ id: '', title: '', specialist: 'hacker', objective: '', dependsOn: 'nao-e-lista', requirements: 'nao-e-objeto' }],
    })
    expect(problems.length).toBeGreaterThanOrEqual(7)
  })
})

/* --------------------------- orchestrate() ------------------------------- */

function scriptedModel(outputs: unknown[], ready = true): OrchestratorModel & { calls: number } {
  return {
    calls: 0,
    ready: () => ready,
    health: async () => ({ ok: ready }),
    route: async () => ({ specialist: 'chat', confidence: 0 }),
    async orchestrate() {
      this.calls++
      const next = outputs.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

function mountRouter(model: OrchestratorModel): RouterService {
  const ctx = new Context()
  ctx.plugin(SpecialistRegistry, {})
  ctx.plugin(RouterService, { needle: model })
  return ctx.router
}

describe('orchestrate: retry/fallback controlado', () => {
  it('saída válida passa direto, com o specialist conferido contra o registro real', async () => {
    const model = scriptedModel([validPlan()])
    const decision = await mountRouter(model).orchestrate({ goal: 'criar api', specialists: ['code', 'security'] })
    expect(decision.mode).toBe('plan')
    expect(model.calls).toBe(1)
  })

  it('o master NÃO é executor: plano que o escala é inválido', async () => {
    const plan = validPlan()
    ;(plan.tasks as Record<string, unknown>[])[0]!.specialist = 'master'
    const model = scriptedModel([plan, plan])
    const decision = await mountRouter(model).orchestrate({ goal: 'x', specialists: [] })
    expect(decision.mode).toBe('ask_owner')
  })

  it('saída inválida ganha UM retry; persistindo, vira ask_owner — nunca propaga cru', async () => {
    const good = validPlan()
    const bad = { ...validPlan(), mode: 'panico' }

    // Inválida uma vez, válida na segunda: o retry salva o turno.
    const recovered = scriptedModel([bad, good])
    const decision = await mountRouter(recovered).orchestrate({ goal: 'x', specialists: [] })
    expect(decision.mode).toBe('plan')
    expect(recovered.calls).toBe(2)

    // Inválida sempre: fallback controlado, com o motivo legível. "Não
    // propaga cru" = a decisão devolvida NÃO é o objeto do modelo e não adota
    // estrutura dele (tasks/calls/owner) — o diagnóstico pode CITAR o valor
    // que reprovou (capado), porque é assim que se depura uma publicação.
    const stubborn = scriptedModel([bad, bad, bad])
    const fallback = await mountRouter(stubborn).orchestrate({ goal: 'x', specialists: [] })
    expect(stubborn.calls).toBe(ORCHESTRATE_MAX_ATTEMPTS)
    expect(fallback.mode).toBe('ask_owner')
    expect(fallback.confidence).toBe(0)
    expect(fallback.ownerRequest?.reason).toContain('não passou no contrato')
    expect(fallback.ownerRequest?.reason).toContain('fora do conjunto')
    expect(fallback.tasks).toBeUndefined()
    expect(fallback.calls).toBeUndefined()
    expect(fallback.owner).toBeUndefined()
  })

  it('exceção do modelo interrompe o retry e cai no fallback', async () => {
    const model = scriptedModel([new Error('conexão recusada')])
    const decision = await mountRouter(model).orchestrate({ goal: 'x', specialists: [] })
    expect(model.calls).toBe(1)
    expect(decision.mode).toBe('ask_owner')
    expect(decision.ownerRequest?.reason).toContain('conexão recusada')
  })

  it('modelo indisponível (ready falso) degrada sem chamar nada', async () => {
    const model = scriptedModel([validPlan()], false)
    const decision = await mountRouter(model).orchestrate({ goal: 'x', specialists: [] })
    expect(model.calls).toBe(0)
    expect(decision.mode).toBe('ask_owner')
  })

  it('a decisão do fallback também passa no próprio contrato', async () => {
    const model = scriptedModel([{}, {}])
    const decision = await mountRouter(model).orchestrate({ goal: 'x', specialists: [] })
    const verdict = validateDecision(decision as unknown as OrchestratorDecision, executorExists)
    expect(verdict.ok).toBe(true)
  })
})
