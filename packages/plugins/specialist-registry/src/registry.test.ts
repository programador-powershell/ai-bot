/**
 * Bateria do registro — porte caso a caso do overlay_test.go do oráculo, mais
 * os aceites E5: overlay inválido não aplica NADA e reporta todos os erros
 * JUNTOS; validação recusa id desconhecido/superfície inválida com mensagem
 * acionável; onChange roda depois de toda troca.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import {
  COMPILED_CATALOG,
  DEFAULT_ID,
  MASTER_ID,
  OVERLAY_SCHEMA_VERSION,
  OverlayError,
  SpecialistRegistry,
  type Definition,
  type RegistryConfig,
} from './index.js'

function mountRegistry(config?: RegistryConfig): SpecialistRegistry {
  const ctx = new Context()
  ctx.plugin(SpecialistRegistry, config ?? {})
  return ctx.specialists
}

/** Um especialista publicável mínimo e VÁLIDO — a base que os testes deformam. */
function validSpecialist(id: string, extra: Partial<Definition> = {}): Record<string, unknown> {
  return {
    id,
    name: `Especialista ${id}`,
    surface: 'conversation',
    rail: 'conversations',
    system: 'prompt de comportamento',
    avatar: { seed: 1, shape: 'orb', eyes: 'dot', mouth: 'none', accessory: 'none', motion: 'idle', hue: 100, saturation: 50 },
    ...extra,
  }
}

function overlayWith(specialists: unknown[], version = '0.2.0'): string {
  return JSON.stringify({ schemaVersion: OVERLAY_SCHEMA_VERSION, version, specialists })
}

function problemsOf(run: () => void): string[] {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(OverlayError)
    return [...(error as OverlayError).problems]
  }
  throw new Error('esperava OverlayError e a chamada passou')
}

describe('catálogo compilado', () => {
  it('serve os dez especialistas na ordem de exibição, com o master fora da lista', () => {
    const registry = mountRegistry()
    expect(registry.ids()).toEqual([
      'chat', 'code', 'office', 'design', 'data', 'work', 'security', 'agent', 'fluxo', 'tune',
    ])
    expect(registry.all().some((definition) => definition.id === MASTER_ID)).toBe(false)
    // ... mas o master EXISTE no índice: o transporte serve o avatar dele.
    expect(registry.exists(MASTER_ID)).toBe(true)
    expect(registry.get(MASTER_ID)?.name).toBe('AI-BOT')
    expect(registry.origin()).toBe('compilado')
  })

  it('getOrDefault cai no padrão para id desconhecido — nunca tela branca', () => {
    const registry = mountRegistry()
    expect(registry.getOrDefault('id-de-conversa-antiga').id).toBe(DEFAULT_ID)
    expect(registry.getOrDefault('code').id).toBe('code')
  })

  it('os radicais do catálogo já nascem normalizados (minúsculos, sem acento)', () => {
    // Um trigger com acento ou maiúscula nunca casaria: o texto é dobrado
    // pelo roteador e ele não.
    for (const definition of COMPILED_CATALOG) {
      for (const trigger of definition.triggers) {
        expect(trigger, `radical "${trigger}" de ${definition.id}`).toBe(trigger.toLowerCase())
        expect(trigger).not.toMatch(/[áàâãäéèêëíìîïóòôõöúùûüçñ]/)
      }
    }
  })

  it('allowsTool aceita a ferramenta do catálogo e a universal, e recusa o resto', () => {
    const registry = mountRegistry()
    expect(registry.allowsTool('office', 'office.edit')).toBe(true)
    // Universal: leitura do que a PRÓPRIA conversa produziu vale para todos.
    expect(registry.allowsTool('office', 'context.fetch')).toBe(true)
    // Documento que roda processo é execução com outro nome.
    expect(registry.allowsTool('office', 'proc.run')).toBe(false)
    expect(registry.allowsTool('nao-existe', 'fs.read')).toBe(false)
  })

  it('unload do plugin desregistra ctx.specialists (efeito reversível do kernel)', async () => {
    const ctx = new Context()
    const handle = ctx.plugin(SpecialistRegistry, {})
    expect(ctx.specialists).toBeDefined()
    await handle.dispose()
    expect(ctx.get('specialists')).toBeUndefined()
  })
})

describe('loadOverlay', () => {
  it('troca o catálogo e diz de onde ele veio', () => {
    const registry = mountRegistry()
    registry.loadOverlay(overlayWith([validSpecialist(DEFAULT_ID), validSpecialist('jurido')]))
    expect(registry.ids()).toEqual([DEFAULT_ID, 'jurido'])
    expect(registry.origin()).toBe('publicado v0.2.0')
    // O master continua respondendo — ele não vem do overlay de propósito:
    // o prompt dele é casado com o parser do classificador (código com cara
    // de dado).
    expect(registry.exists(MASTER_ID)).toBe(true)
  })

  it('normaliza o prefixo v da versão', () => {
    const registry = mountRegistry()
    registry.loadOverlay(overlayWith([validSpecialist(DEFAULT_ID)], 'v1.4.0'))
    expect(registry.origin()).toBe('publicado v1.4.0')
  })

  it('ACEITE E5: overlay com um especialista inválido é recusado INTEIRO e nada muda', () => {
    const registry = mountRegistry()
    const before = registry.ids()
    const problems = problemsOf(() =>
      registry.loadOverlay(overlayWith([
        validSpecialist(DEFAULT_ID),
        validSpecialist('quebrado', { surface: 'holograma' as never }),
      ])),
    )
    expect(problems.some((p) => p.includes('superfície "holograma" não existe'))).toBe(true)
    // NENHUMA mudança aplicada: catálogo e origem intactos.
    expect(registry.ids()).toEqual(before)
    expect(registry.origin()).toBe('compilado')
    expect(registry.exists('quebrado')).toBe(false)
  })

  it('ACEITE E5: todos os erros vêm JUNTOS, não um por publicação', () => {
    const registry = mountRegistry()
    const problems = problemsOf(() =>
      registry.loadOverlay(overlayWith([
        validSpecialist('', { name: '' }),
        validSpecialist('MAIUSCULO'),
        validSpecialist('sem-tela', { surface: 'xyz' as never, rail: 'abc' as never }),
      ])),
    )
    // Um problema por defeito, na mesma passada: id vazio, name vazio, id
    // fora do formato, superfície e trilho desconhecidos, e a falta do padrão.
    expect(problems.some((p) => p.includes('sem `id`'))).toBe(true)
    expect(problems.some((p) => p.includes('sem `name`'))).toBe(true)
    expect(problems.some((p) => p.includes('fora do formato'))).toBe(true)
    expect(problems.some((p) => p.includes('superfície "xyz"'))).toBe(true)
    expect(problems.some((p) => p.includes('trilho "abc"'))).toBe(true)
    expect(problems.some((p) => p.includes(`não tem "${DEFAULT_ID}"`))).toBe(true)
    expect(problems.length).toBeGreaterThanOrEqual(6)
  })

  it('recusa recusada preserva o OVERLAY anterior, não só o compilado', () => {
    const registry = mountRegistry()
    registry.loadOverlay(overlayWith([validSpecialist(DEFAULT_ID)], '0.1.0'))
    expect(registry.origin()).toBe('publicado v0.1.0')
    expect(() => registry.loadOverlay(overlayWith([], '0.2.0'))).toThrow(OverlayError)
    expect(registry.origin()).toBe('publicado v0.1.0')
    expect(registry.ids()).toEqual([DEFAULT_ID])
  })

  it('recusa catálogo sem o especialista padrão', () => {
    const registry = mountRegistry()
    const problems = problemsOf(() => registry.loadOverlay(overlayWith([validSpecialist('outro')])))
    expect(problems.some((p) => p.includes(`não tem "${DEFAULT_ID}"`))).toBe(true)
  })

  it('recusa id repetido, id master e avatar que o desenho não conhece', () => {
    const registry = mountRegistry()
    const problems = problemsOf(() =>
      registry.loadOverlay(overlayWith([
        validSpecialist(DEFAULT_ID),
        validSpecialist(DEFAULT_ID),
        validSpecialist(MASTER_ID),
        validSpecialist('torto', {
          avatar: { seed: 1, shape: 'cubo', eyes: 'dot', mouth: 'none', accessory: 'none', motion: 'idle', hue: 999, saturation: -2 },
        }),
      ])),
    )
    expect(problems.some((p) => p.includes('`id` repetido'))).toBe(true)
    expect(problems.some((p) => p.includes('reservado ao roteador'))).toBe(true)
    expect(problems.some((p) => p.includes('forma "cubo"'))).toBe(true)
    expect(problems.some((p) => p.includes('`avatar.hue` 999'))).toBe(true)
    expect(problems.some((p) => p.includes('`avatar.saturation` -2'))).toBe(true)
  })

  it('recusa documento vazio, JSON quebrado e esquema de outra versão (maior inclusive)', () => {
    const registry = mountRegistry()
    expect(() => registry.loadOverlay('{ nao é json')).toThrow(OverlayError)
    expect(() => registry.loadOverlay('[]')).toThrow(OverlayError)
    const older = problemsOf(() =>
      registry.loadOverlay(JSON.stringify({ schemaVersion: 0, version: '1', specialists: [validSpecialist(DEFAULT_ID)] })),
    )
    expect(older[0]).toContain('esquema 0')
    // Maior TAMBÉM recusa: registro antigo não adivinha catálogo novo.
    const newer = problemsOf(() =>
      registry.loadOverlay(JSON.stringify({ schemaVersion: OVERLAY_SCHEMA_VERSION + 1, version: '1', specialists: [validSpecialist(DEFAULT_ID)] })),
    )
    expect(newer[0]).toContain(`esquema ${OVERLAY_SCHEMA_VERSION + 1}`)
  })

  it('recusa ferramenta que não existe no registro do host, quando há verificador', () => {
    const known = new Set(['fs.read'])
    const registry = mountRegistry({ toolChecker: (name) => known.has(name) })
    const problems = problemsOf(() =>
      registry.loadOverlay(overlayWith([validSpecialist(DEFAULT_ID, { tools: ['fs.read', 'laser.fire'] })])),
    )
    expect(problems.some((p) => p.includes('"laser.fire" não existe neste registro'))).toBe(true)
    // Sem verificador a checagem é pulada (só teste monta assim).
    const lenient = mountRegistry()
    lenient.loadOverlay(overlayWith([validSpecialist(DEFAULT_ID, { tools: ['laser.fire'] })]))
    expect(lenient.origin()).toBe('publicado v0.2.0')
  })
})

describe('onChange e checkpoints', () => {
  it('roda depois de TODA troca — load, reset e restore — já vendo o catálogo novo', () => {
    const registry = mountRegistry()
    const seen: string[] = []
    registry.onChange(() => {
      seen.push(registry.origin())
    })

    registry.loadOverlay(overlayWith([validSpecialist(DEFAULT_ID)], '0.9.0'))
    const checkpoint = registry.capture()
    registry.resetOverlay()
    registry.restore(checkpoint)

    expect(seen).toEqual(['publicado v0.9.0', 'compilado', 'publicado v0.9.0'])
  })

  it('o disposer devolvido remove o gancho', () => {
    const registry = mountRegistry()
    let calls = 0
    const off = registry.onChange(() => {
      calls++
    })
    registry.resetOverlay()
    off()
    registry.resetOverlay()
    expect(calls).toBe(1)
  })

  it('gancho que tenta publicar durante o aviso estoura com o contrato nomeado', () => {
    const registry = mountRegistry()
    registry.onChange(() => {
      registry.resetOverlay()
    })
    expect(() => registry.resetOverlay()).toThrow(/gancho onChange/)
  })

  it('restore de estado ausente é ignorado (disposer parcial não apaga o catálogo)', () => {
    const registry = mountRegistry()
    registry.restore(undefined)
    expect(registry.origin()).toBe('compilado')
  })
})
