/**
 * O aceite da Onda 6, em três provas:
 *
 *  1. A MESMA suíte da cerca (§25) passa com o backend PUTER injetado — a cerca
 *     não muda uma linha (fenceContract, reusada de domain-workspace).
 *  2. materialize baixa Puter→disco; promote sobe o promovido para o Puter e o
 *     descartável do container NUNCA sobe (snapshot em duas camadas).
 *  3. quando a cerca RECUSA (época velha), NADA vai para o Puter — o
 *     não-promovido nunca aparece.
 *
 * Sem conta nem rede real (pendência declarada): o Puter é o FakePuterFs,
 * fiel ao contrato. O disco local é um tmp real (o container trabalha no disco).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { StaleWorkspaceError, WorkspaceManager, type Leases } from '@aibot2/domain-workspace'
import { fenceContract, CommandedLeases } from '@aibot2/domain-workspace/fence-contract'
import {
  FakePuterFs,
  goalArtifactsAttempt,
  goalHistoryEntry,
  goalWorkspace,
} from '@aibot2/plugin-puter-workspace'

import { PuterWorkspaceBackend } from './backend.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

/** Um backend puter novo, com um Puter falso e um workRoot em disco de verdade. */
function newBackend(): { backend: PuterWorkspaceBackend; fs: FakePuterFs; workRoot: string } {
  const fs = new FakePuterFs()
  const workRoot = mkdtempSync(join(tmpdir(), 'aibot2-puter-'))
  cleanups.push(() => rmSync(workRoot, { recursive: true, force: true }))
  return { backend: new PuterWorkspaceBackend({ fs, workRoot }), fs, workRoot }
}

// PROVA 1 — a cerca é a mesma. A suíte compartilhada roda com o backend puter.
fenceContract(
  'puter',
  (leases: Leases) => new WorkspaceManager({ backend: newBackend().backend, leases }),
)

describe('materialize baixa Puter → disco local', () => {
  it('o workspace do Goal vira pasta no disco e o staging da tentativa nasce', async () => {
    const { backend, fs } = newBackend()
    // O Puter já tem o projeto do Goal (o container vai editá-lo no disco).
    await fs.writeFile(
      `${goalWorkspace('goal-s1')}/src/app.ts`,
      new TextEncoder().encode('export const x = 1'),
    )

    const manager = new WorkspaceManager({ backend })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
    expect(plan.source.provider).toBe('puter')

    const exec = await manager.materialize(plan)
    // Baixou: o arquivo do Puter existe no disco local do worker.
    expect(readFileSync(join(exec.localRoot, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1')
    // E a área de espera desta tentativa foi preparada no disco.
    expect(exec.localStaging).toBeDefined()
  })
})

describe('promote sobe o promovido, NUNCA o descartável (snapshot em duas camadas)', () => {
  it('o resultado aparece nos artifacts do Puter; node_modules fica no disco', async () => {
    const { backend, fs } = newBackend()
    const manager = new WorkspaceManager({ backend }) // leases local/1 (dono atual)
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
    const exec = await manager.materialize(plan)
    const staging = exec.localStaging as string

    // O container produz: um RESULTADO e um descartável (node_modules).
    writeFileSync(join(staging, 'relatorio.md'), 'RESULTADO')
    mkdirSync(join(staging, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(staging, 'node_modules', 'pkg', 'index.js'), 'descartavel')

    await manager.promote(plan, { stagingUri: plan.staging.uri })

    const artifacts = goalArtifactsAttempt('goal-s1', 't2', 1)
    // Camada 1: o resultado promovido está no Puter.
    expect(await fs.exists(`${artifacts}/relatorio.md`)).toBe(true)
    expect(fs.text(`${artifacts}/relatorio.md`)).toBe('RESULTADO')
    // Camada 2: o descartável NUNCA subiu — em endereço nenhum do Puter.
    expect(fs.paths().some((p) => p.includes('node_modules'))).toBe(false)
    // E o metadado subiu, listando SÓ o que foi promovido.
    const meta = JSON.parse(fs.text(goalHistoryEntry('goal-s1', 't2', 1))) as {
      artifacts: string[]
    }
    expect(meta.artifacts).toEqual(['relatorio.md'])
  })

  it('subpastas promovidas preservam a estrutura; só o descartável é podado', async () => {
    const { backend, fs } = newBackend()
    const manager = new WorkspaceManager({ backend })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
    const exec = await manager.materialize(plan)
    const staging = exec.localStaging as string

    mkdirSync(join(staging, 'docs'), { recursive: true })
    writeFileSync(join(staging, 'docs', 'guia.md'), '# guia')
    mkdirSync(join(staging, 'docs', 'node_modules'), { recursive: true }) // aninhado
    writeFileSync(join(staging, 'docs', 'node_modules', 'lixo.js'), 'x')

    await manager.promote(plan, { stagingUri: plan.staging.uri })

    const artifacts = goalArtifactsAttempt('goal-s1', 't2', 1)
    expect(await fs.exists(`${artifacts}/docs/guia.md`)).toBe(true)
    // node_modules aninhado também é descartável — não sobe.
    expect(fs.paths().some((p) => p.includes('node_modules'))).toBe(false)
  })
})

describe('a cerca recusa: o não-promovido NUNCA aparece no Puter', () => {
  it('época velha volta do limbo → StaleWorkspaceError e Puter sem artifact nem history', async () => {
    const { backend, fs } = newBackend()
    // PC-02 congela na época 4...
    const leases = new CommandedLeases({ workerId: 'pc-02', epoch: 4 })
    const manager = new WorkspaceManager({ backend, leases })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
    const exec = await manager.materialize(plan)
    // ...o worker até produziu o resultado no staging local...
    writeFileSync(join(exec.localStaging as string, 'relatorio.md'), 'RESULTADO')

    // ...mas o mundo andou: o PC-03 assumiu na época 5.
    leases.switchTo('pc-03', 5)

    await expect(manager.promote(plan, { stagingUri: plan.staging.uri })).rejects.toThrow(
      StaleWorkspaceError,
    )
    // A cerca barrou ANTES do upload: o Puter não tem NADA deste Goal.
    expect(fs.paths().some((p) => p.startsWith('/Goals/goal-s1/artifacts'))).toBe(false)
    expect(fs.paths().some((p) => p.startsWith('/Goals/goal-s1/history'))).toBe(false)
  })

  it('promover um staging que não é o do plano é recusado (espelho do "staging desconhecido")', async () => {
    const { backend } = newBackend()
    const manager = new WorkspaceManager({ backend })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
    await expect(
      manager.promote(plan, { stagingUri: 'puter:///Goals/goal-s1/staging/OUTRA/epoch-1' }),
    ).rejects.toThrow(/só promove o staging deste plano/)
  })
})
