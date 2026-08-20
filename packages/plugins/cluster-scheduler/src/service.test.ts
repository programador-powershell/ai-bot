/**
 * A montagem do scheduler no kernel: ctx.cluster registrado como Service, o
 * unload desregistra (o efeito reversível do harness) e o atalho run()
 * executa um Goal de ponta a ponta.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { SqliteEventStore } from '@aibot2/domain-events'
import { Fleet, type WorkerRecord } from '@aibot2/domain-workers'
import { WorkspaceManager } from '@aibot2/domain-workspace'
import { ClusterScheduler, type ClusterSchedulerConfig } from './index.js'

const NOW = Date.parse('2026-08-20T10:00:00Z')

function pc(id: string): WorkerRecord {
  return {
    id,
    hostname: id,
    capabilities: { cpus: 4, ramBytes: 8_000_000_000, arch: 'x64', runtimes: ['node'], slots: 4 },
    lastSeen: new Date(NOW).toISOString(),
  }
}

async function config(): Promise<{ config: ClusterSchedulerConfig; store: SqliteEventStore }> {
  const store = SqliteEventStore.open(':memory:')
  const fleet = new Fleet({ now: () => NOW })
  await fleet.register(pc('pc-01'))
  const workspaces = new WorkspaceManager({
    roots: () => 'C:/projeto',
    leases: { currentLease: (taskId) => fleet.currentLease(taskId) },
  })
  return {
    store,
    config: {
      store,
      fleet,
      workspaces,
      executor: { run: async (assignment) => `feito ${assignment.task.id}` },
      chooseOptions: { now: () => NOW },
    },
  }
}

describe('ClusterScheduler como Service', () => {
  it('montar expõe ctx.cluster; o unload desregistra', async () => {
    const ctx = new Context()
    const { config: cfg, store } = await config()
    const scope = ctx.plugin(ClusterScheduler, cfg)
    await scope

    expect(ctx.cluster).toBeInstanceOf(ClusterScheduler)

    const report = await ctx.cluster.run('crm', {
      sessionId: 's1',
      tasks: [{ id: 't1', title: 'tarefa', specialist: 'code', goal: 'fazer' }],
    })
    expect(report.results['t1']).toBe('feito t1')

    await scope.dispose()
    expect(ctx.get('cluster')).toBeUndefined()
    await store.close()
  })

  it('choose expõe a decisão §28 sem precisar de motor', async () => {
    const ctx = new Context()
    const { config: cfg, store } = await config()
    await ctx.plugin(ClusterScheduler, cfg)

    const choice = ctx.cluster.choose({ runtimes: ['node'] }, [pc('pc-01'), pc('pc-02')], {
      now: () => NOW,
    })
    expect(choice).toMatchObject({ chosen: { id: 'pc-01' } })
    await store.close()
  })
})
