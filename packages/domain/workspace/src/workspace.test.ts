/**
 * Bateria do workspace — porte do workspace_test.go do oráculo mais os
 * aceites E7: Validate exige CADA campo; o plano persistente não carrega
 * caminho físico; e a cerca do Promote com o cenário §25 (PC-02 época 4
 * volta do limbo e é recusado; PC-03 época 5 promove).
 */

import { describe, expect, it } from 'vitest'
import {
  INPLACE_STAGING,
  LOCAL_WORKER,
  NoExecutionError,
  StaleWorkspaceError,
  WorkspaceManager,
  localPath,
  localUri,
  planToString,
  requireMaterialized,
  stagingUri,
  validatePlan,
  type CurrentLease,
  type Leases,
  type WorkspacePlan,
} from './index.js'

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

/** Lease comandável — encena a perda do lease NO MEIO da execução. */
class CommandedLeases implements Leases {
  constructor(private lease: CurrentLease) {}
  switchTo(workerId: string, epoch: number): void {
    this.lease = { workerId, epoch }
  }
  async currentLease(): Promise<CurrentLease> {
    return this.lease
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

describe('Promote com cerca worker+época — o cenário §25', () => {
  it('PC-03 na época 5 (dona atual) PROMOVE', async () => {
    const leases = new CommandedLeases({ workerId: 'pc-03', epoch: 5 })
    const manager = new WorkspaceManager({ roots: () => 'C:/p', leases })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
    expect(plan.workerId).toBe('pc-03')
    expect(plan.leaseEpoch).toBe(5)

    await expect(manager.promote(plan, { stagingUri: INPLACE_STAGING })).resolves.toBeUndefined()
  })

  it('PC-02 época 4 volta do limbo e é RECUSADO — stale epoch nunca promove', async () => {
    // PC-02 congelou o plano na época 4...
    const leases = new CommandedLeases({ workerId: 'pc-02', epoch: 4 })
    const manager = new WorkspaceManager({ roots: () => 'C:/p', leases })
    const planVelho = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
    expect(planVelho.leaseEpoch).toBe(4)

    // ...ficou 40s sem rede, o lease venceu e o PC-03 assumiu na época 5.
    leases.switchTo('pc-03', 5)

    // PC-02 termina o trabalho e tenta transformá-lo em verdade: a cerca barra.
    await expect(manager.promote(planVelho, { stagingUri: INPLACE_STAGING })).rejects.toThrow(
      StaleWorkspaceError,
    )
  })

  it('mesma época em OUTRO worker também é stale — a cerca compara a tríade, não só o número', async () => {
    const leases = new CommandedLeases({ workerId: 'pc-02', epoch: 5 })
    const manager = new WorkspaceManager({ roots: () => 'C:/p', leases })
    const plan = await manager.plan({ sessionId: 's1', taskId: 't2' })

    leases.switchTo('pc-03', 5)
    await expect(manager.promote(plan, { stagingUri: INPLACE_STAGING })).rejects.toThrow(
      StaleWorkspaceError,
    )
  })

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
