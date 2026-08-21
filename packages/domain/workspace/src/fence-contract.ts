/**
 * A CERCA como suíte REUTILIZÁVEL — o cenário §25 da spec, escrito uma vez e
 * rodado contra QUALQUER backend. É a prova em código da promessa do v1: "o
 * Puter troca o backend sem mudar a cerca". O backend local roda esta suíte em
 * workspace.test.ts; o provider puter roda a MESMA em providers/puter — e as
 * duas passam com as mesmíssimas asserções.
 *
 * Só entra aqui o que é INDIFERENTE ao backend (a decisão de época na porta da
 * promoção). O que é específico — o local constatar o inplace, o puter subir os
 * bytes — fica na suíte de cada backend.
 *
 * Não é um arquivo `*.test.ts`: o vitest não o coleta sozinho. Ele é
 * IMPORTADO por quem tem um backend para provar (por isso importa do vitest —
 * o mesmo padrão dos test doubles exportados, ex.: scriptedNeedle).
 */

import { describe, expect, it } from 'vitest'
import { StaleWorkspaceError, WorkspaceManager, type CurrentLease, type Leases } from './manager.js'

/**
 * Lease comandável — encena a perda do lease NO MEIO da execução: o plano
 * congela numa época e o mundo "anda" antes da promoção.
 */
export class CommandedLeases implements Leases {
  constructor(private lease: CurrentLease) {}
  switchTo(workerId: string, epoch: number): void {
    this.lease = { workerId, epoch }
  }
  async currentLease(): Promise<CurrentLease> {
    return this.lease
  }
}

/** Como construir o gerente sob teste com os leases da vez (o backend é do chamador). */
export type MakeManager = (leases: Leases) => WorkspaceManager

/**
 * Registra o bloco §25 para um backend. `label` distingue os describes quando
 * dois backends rodam na mesma execução; `makeManager` injeta o backend que se
 * quer provar.
 */
export function fenceContract(label: string, makeManager: MakeManager): void {
  describe(`Promote com cerca worker+época — o cenário §25 [${label}]`, () => {
    it('PC-03 na época 5 (dona atual) PROMOVE', async () => {
      const leases = new CommandedLeases({ workerId: 'pc-03', epoch: 5 })
      const manager = makeManager(leases)
      const plan = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
      expect(plan.workerId).toBe('pc-03')
      expect(plan.leaseEpoch).toBe(5)

      await expect(manager.promote(plan, { stagingUri: plan.staging.uri })).resolves.toBeUndefined()
    })

    it('PC-02 época 4 volta do limbo e é RECUSADO — stale epoch nunca promove', async () => {
      // PC-02 congelou o plano na época 4...
      const leases = new CommandedLeases({ workerId: 'pc-02', epoch: 4 })
      const manager = makeManager(leases)
      const planVelho = await manager.plan({ sessionId: 's1', taskId: 't2', botId: 'code' })
      expect(planVelho.leaseEpoch).toBe(4)

      // ...ficou 40s sem rede, o lease venceu e o PC-03 assumiu na época 5.
      leases.switchTo('pc-03', 5)

      // PC-02 termina o trabalho e tenta transformá-lo em verdade: a cerca barra.
      await expect(
        manager.promote(planVelho, { stagingUri: planVelho.staging.uri }),
      ).rejects.toThrow(StaleWorkspaceError)
    })

    it('mesma época em OUTRO worker também é stale — a cerca compara a tríade, não só o número', async () => {
      const leases = new CommandedLeases({ workerId: 'pc-02', epoch: 5 })
      const manager = makeManager(leases)
      const plan = await manager.plan({ sessionId: 's1', taskId: 't2' })

      leases.switchTo('pc-03', 5)
      await expect(manager.promote(plan, { stagingUri: plan.staging.uri })).rejects.toThrow(
        StaleWorkspaceError,
      )
    })
  })
}
