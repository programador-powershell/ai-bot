/**
 * Bateria do workspace — porte do workspace_test.go do oráculo mais os
 * aceites E7: Validate exige CADA campo; o plano persistente não carrega
 * caminho físico; e a cerca do Promote com o cenário §25 (PC-02 época 4
 * volta do limbo e é recusado; PC-03 época 5 promove).
 *
 * A cerca (§25) agora vem da suíte REUTILIZÁVEL fence-contract, rodada aqui
 * com o backend LOCAL — a MESMA suíte roda em providers/puter com o backend
 * puter e passa igual (aceite da Onda 6). O que é específico do local (constatar
 * o inplace, recusar staging desconhecido) fica neste arquivo.
 */

import { describe, expect, it } from 'vitest'
import {
  LOCAL_WORKER,
  NoExecutionError,
  WorkspaceManager,
  localPath,
  localUri,
  planToString,
  requireMaterialized,
  stagingUri,
  validatePlan,
  type Leases,
  type WorkspacePlan,
} from './index.js'
import { fenceContract } from './fence-contract.js'

function fullPlan(): WorkspacePlan {
  return {
    id: 'wp-1',
    userId: 'paim',
    goalId: 'goal-crm',
    sessionId: 's1',
    taskId: 't7',
    botId: 'code',
    attempt: 1,
    workerId: 'pc-02',
    leaseEpoch: 17,
    source: { provider: 'puter', uri: 'puter:///Bots/code/ws', revision: 'r1' },
    runtime: { snapshotDigest: 'node-24/19f810' },
    staging: { uri: 'puter:///Goals/goal-crm/staging/t7/epoch-17' },
    baseline: { revision: 'r1', manifestDigest: 'abc123' },
  }
}

describe('validatePlan exige cada campo (porte 1:1 do Validate do oráculo)', () => {
  const mutations: Record<string, (plan: WorkspacePlan) => void> = {
    id: (plan) => {
      plan.id = ' '
    },
    userId: (plan) => {
      plan.userId = ''
    },
    goalId: (plan) => {
      plan.goalId = ''
    },
    taskId: (plan) => {
      plan.taskId = ''
    },
    botId: (plan) => {
      plan.botId = ''
    },
    attempt: (plan) => {
      plan.attempt = 0
    },
    workerId: (plan) => {
      plan.workerId = ''
    },
    leaseEpoch: (plan) => {
      plan.leaseEpoch = 0
    },
    'source provider': (plan) => {
      plan.source.provider = ''
    },
    'source uri': (plan) => {
      plan.source.uri = ''
    },
    'source revision': (plan) => {
      plan.source.revision = ''
    },
    'runtime snapshot': (plan) => {
      plan.runtime.snapshotDigest = ''
    },
    'staging uri': (plan) => {
      plan.staging.uri = ''
    },
    baseline: (plan) => {
      plan.baseline.manifestDigest = ''
    },
  }

  it('plano completo passa', () => {
    expect(() => validatePlan(fullPlan())).not.toThrow()
  })

  for (const [field, mutate] of Object.entries(mutations)) {
    it(`recusa plano sem ${field}`, () => {
      const plan = fullPlan()
      mutate(plan)
      expect(() => validatePlan(plan)).toThrow(/workspace plan/)
    })
  }
})

describe('o plano persistente não carrega caminho físico (spec §21)', () => {
  it('o manager congela URI, nunca a pasta crua — e a execução local resolve de volta', async () => {
    const manager = new WorkspaceManager({ roots: () => 'C:\\projetos\\crm' })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't1', botId: 'code' })

    // O plano viaja como URI de provider; o caminho físico não aparece cru.
    expect(plan.source.uri).toBe('local://C:/projetos/crm')
    expect(JSON.stringify(plan)).not.toContain('\\\\')

    // O caminho local só existe DEPOIS de materializar, dentro do worker.
    const execution = await manager.materialize(plan)
    expect(execution.localRoot).toBe('C:/projetos/crm')
  })

  it('id do plano é determinístico: mesmo pedido, mesmo id (replay e comparação)', async () => {
    const manager = new WorkspaceManager({ roots: () => 'C:/p' })
    const primeiro = await manager.plan({ sessionId: 's1', taskId: 't1', attempt: 2 })
    const segundo = await manager.plan({ sessionId: 's1', taskId: 't1', attempt: 2 })
    expect(primeiro.id).toBe(segundo.id)
    expect(primeiro.id).toBe('wp-s1-t1-2')
  })

  it('sessão sem pasta gera plano VÁLIDO cuja materialização produz root vazio', async () => {
    const manager = new WorkspaceManager()
    const plan = await manager.plan({ sessionId: 's1' })
    expect(plan.source.uri).toBe('local://sem-pasta')
    const execution = await manager.materialize(plan)
    expect(execution.localRoot).toBe('')
    // E a ferramenta que exige workspace recusa com motivo, não cai no cwd.
    expect(() => requireMaterialized(execution)).toThrow(/não foi materializado/)
    expect(() => requireMaterialized(undefined)).toThrow(NoExecutionError)
  })

  it('a v1 congela o worker local na época 1', async () => {
    const manager = new WorkspaceManager({ roots: () => 'C:/p' })
    const plan = await manager.plan({ sessionId: 's1' })
    expect(plan.workerId).toBe(LOCAL_WORKER)
    expect(plan.leaseEpoch).toBe(1)
    expect(planToString(plan)).toContain('epoch=1')
  })
})

// A cerca §25, backend-agnóstica, vem da suíte compartilhada — aqui com o
// backend LOCAL (padrão do gerente). É a MESMA suíte que providers/puter roda.
fenceContract('local', (leases: Leases) => new WorkspaceManager({ roots: () => 'C:/p', leases }))

describe('Promote — o que é específico do backend LOCAL', () => {
  it('staging desconhecido não promove nem com lease válido — v1 só sabe constatar o inplace', async () => {
    const manager = new WorkspaceManager({ roots: () => 'C:/p' })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2' })
    await expect(manager.promote(plan, { stagingUri: stagingUri('t2', 1) })).rejects.toThrow(
      /não sabe promover/,
    )
  })
})

describe('URIs locais', () => {
  it('localUri/localPath são inversas e normalizam a barra do Windows', () => {
    expect(localUri('C:\\a\\b')).toBe('local://C:/a/b')
    expect(localPath('local://C:/a/b')).toBe('C:/a/b')
    expect(localPath(localUri(''))).toBe('')
    expect(localPath('puter:///x')).toBe('')
  })

  it('stagingUri carrega tarefa E época — duas publicações nunca se misturam', () => {
    expect(stagingUri('t7', 4)).toBe('staging://t7/epoch-4')
    expect(stagingUri('t7', 4)).not.toBe(stagingUri('t7', 5))
  })
})
