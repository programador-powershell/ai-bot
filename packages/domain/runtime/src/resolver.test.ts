/**
 * Bateria do RuntimeResolver — o fechamento da dívida 6 (aceite E7, Onda 5):
 * "fs/git e proc.run resolvem no MESMO lugar quando o Runtime da tarefa não é
 * local". O teste central é a INVARIANTE: para todo runtime (host|docker|wsl|
 * vps), a raiz que fs/git usam é EXATAMENTE o workdir onde proc roda — nunca
 * dois lugares. E as bordas: admissão do tipo de runtime (a extensão §28) e a
 * leitura do runtime da tarefa (requirements.docker força; ambiente inválido
 * morre nomeado; máquina nomeada pelo modelo nem chega aqui).
 */

import { describe, expect, it } from 'vitest'
import {
  RUNTIME_KINDS,
  RuntimeResolver,
  admitRuntime,
  parseRequirements,
  resolveRuntimeBinding,
  resolveRuntimeTarget,
  runtimeExec,
  runtimeWorkdir,
  type RuntimeKind,
} from './index.js'

describe('resolveRuntimeTarget', () => {
  it('default é host quando nada exige outra coisa', () => {
    expect(resolveRuntimeTarget({})).toEqual({ kind: 'host' })
  })

  it('requirements.docker=true FORÇA docker, mesmo sem ambiente escolhido', () => {
    expect(resolveRuntimeTarget({ docker: true })).toEqual({ kind: 'docker' })
    // E vence um ambiente que diria outra coisa — o requisito de admissão manda.
    expect(resolveRuntimeTarget({ docker: true }, 'wsl')).toEqual({ kind: 'docker' })
  })

  it('o ambiente escolhido vence, e `local` normaliza para host', () => {
    expect(resolveRuntimeTarget({}, 'local')).toEqual({ kind: 'host' })
    expect(resolveRuntimeTarget({}, 'WSL')).toEqual({ kind: 'wsl' })
    expect(resolveRuntimeTarget({}, 'vps', 'deploy@1.2.3.4')).toEqual({
      kind: 'vps',
      ref: 'deploy@1.2.3.4',
    })
  })

  it('ambiente fora do vocabulário morre NOMEADO — não vira host mudo (nem `cloud`)', () => {
    expect(() => resolveRuntimeTarget({}, 'cloud')).toThrow(/host\|docker\|wsl\|vps/)
    expect(() => resolveRuntimeTarget({}, 'lixo')).toThrow(/não é um runtime/)
  })

  it('máquina nomeada pelo modelo não atravessa: o resolver lê o que o parse deixou', () => {
    // parseRequirements descarta workerId/machine; o resolver nem tem por onde vê-los.
    const requirements = parseRequirements({
      docker: true,
      workerId: 'pc-02',
      machine: 'pc-02',
    } as Record<string, unknown>)
    const target = resolveRuntimeTarget(requirements)
    expect(target).toEqual({ kind: 'docker' })
    expect(JSON.stringify(target)).not.toContain('pc-02')
  })
})

describe('admitRuntime (a extensão §28 para o TIPO de runtime)', () => {
  it('host cabe em qualquer máquina', () => {
    expect(admitRuntime({ kind: 'host' }, {})).toEqual({ ok: true })
  })

  it('docker exige a capacidade docker; sem ela, recusa com o motivo', () => {
    expect(admitRuntime({ kind: 'docker' }, { docker: true })).toEqual({ ok: true })
    const negado = admitRuntime({ kind: 'docker' }, { docker: false })
    expect(negado).toMatchObject({ ok: false })
    expect((negado as { reason: string }).reason).toContain('docker')
  })

  it('wsl/vps exigem a capacidade nomeada correspondente', () => {
    expect(admitRuntime({ kind: 'wsl' }, { capabilities: ['wsl'] })).toEqual({ ok: true })
    expect(admitRuntime({ kind: 'vps' }, { capabilities: ['vps'] })).toEqual({ ok: true })
    const semWsl = admitRuntime({ kind: 'wsl' }, { capabilities: [] })
    expect(semWsl).toMatchObject({ ok: false })
    expect((semWsl as { reason: string }).reason).toContain('wsl')
  })
})

describe('a dívida 6: fs/git/proc no MESMO lugar, para TODO runtime', () => {
  const localRoot = '/work/runs/wp-crm-t1-1'

  it.each(RUNTIME_KINDS)(
    'runtime %s: a raiz de fs/git é EXATAMENTE o workdir onde proc roda',
    (kind: RuntimeKind) => {
      // wsl/vps/docker precisam de ref (o alvo do runtime); host não.
      const ref = kind === 'host' ? undefined : `ref-${kind}`
      const binding = resolveRuntimeBinding({ kind, ...(ref !== undefined ? { ref } : {}) }, localRoot)

      const fsRoot = runtimeWorkdir(binding)
      const gitRoot = runtimeWorkdir(binding)
      const proc = runtimeExec(binding, ['make', 'build'])

      // O coração do fechamento: os três derivam do MESMO binding, então a raiz
      // de fs, a de git e o workdir de proc são o MESMO valor — impossível
      // editar num lugar e compilar noutro.
      expect(fsRoot).toBe(localRoot)
      expect(gitRoot).toBe(fsRoot)
      expect(proc.workdir).toBe(fsRoot)
      // E o comando é SEMPRE vetor (nunca string de shell).
      expect(Array.isArray(proc.argv)).toBe(true)
      expect(proc.argv).toContain('make')
      expect(proc.argv).toContain('build')
    },
  )

  it('host: proc é o próprio comando; local=true', () => {
    const binding = resolveRuntimeBinding({ kind: 'host' }, localRoot)
    expect(binding.local).toBe(true)
    expect(runtimeExec(binding, ['npm', 'test']).argv).toEqual(['npm', 'test'])
  })

  it('docker: proc entra com `docker exec -w <workdir> <ref>` — o MESMO workdir do binding', () => {
    const binding = resolveRuntimeBinding({ kind: 'docker', ref: 'aibot2-run-1' }, localRoot)
    expect(binding.local).toBe(false)
    expect(runtimeExec(binding, ['npm', 'test']).argv).toEqual([
      'docker',
      'exec',
      '-w',
      localRoot,
      'aibot2-run-1',
      'npm',
      'test',
    ])
  })

  it('wsl: proc entra com `wsl -d <distro> --cd <workdir> --`', () => {
    const binding = resolveRuntimeBinding({ kind: 'wsl', ref: 'Ubuntu' }, localRoot)
    expect(runtimeExec(binding, ['ls']).argv).toEqual([
      'wsl',
      '-d',
      'Ubuntu',
      '--cd',
      localRoot,
      '--',
      'ls',
    ])
  })

  it('docker/wsl/vps SEM ref é erro nomeado — resolver proc sem alvo cairia no host por engano', () => {
    for (const kind of ['docker', 'wsl', 'vps'] as const) {
      const binding = resolveRuntimeBinding({ kind }, localRoot)
      expect(() => runtimeExec(binding, ['x'])).toThrow(/proc não pode resolver o alvo/)
    }
  })
})

describe('RuntimeResolver (fachada)', () => {
  it('compõe target → admissão → binding sem estado', () => {
    const resolver = new RuntimeResolver()
    const target = resolver.resolveTarget(parseRequirements({ docker: true }))
    expect(target.kind).toBe('docker')
    expect(resolver.admit(target, { docker: true })).toEqual({ ok: true })
    const binding = resolver.bind({ kind: 'docker', ref: 'c1' }, '/work')
    expect(runtimeWorkdir(binding)).toBe('/work')
  })
})
