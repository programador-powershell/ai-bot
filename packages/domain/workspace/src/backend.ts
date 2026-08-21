/**
 * O SEAM do backend do WorkspaceManager (Onda 6): o gerente decide QUEM
 * executa e em que época (a cerca), o backend decide ONDE os bytes vivem e
 * COMO materializar/promover. Um é autoridade, o outro é I/O — e a cerca fica
 * SEMPRE no gerente, nunca no backend.
 *
 * Foi assim que o desenho prometeu desde a v1: "o Puter troca o backend depois
 * sem mudar a cerca". Este arquivo é o ponto onde essa troca acontece. O
 * backend local (esta máquina, pasta viva) mora aqui porque é puro — resolve
 * URI, constata inplace, zero disco. O backend puter mora em `providers/puter`
 * porque anda no disco e na rede.
 */

import type { WorkspaceExecution } from './execution.js'
import {
  INPLACE_STAGING,
  LIVE_REVISION,
  LOCAL_PROVIDER,
  localPath,
  localUri,
  type WorkspacePlan,
  type WorkspaceSource,
  type WorkspaceStaging,
} from './plan.js'

/** O que o worker publicou no staging e quer ver promovido. */
export interface Publication {
  stagingUri: string
}

/**
 * O que o gerente JÁ resolveu quando pergunta ao backend por source/staging:
 * ids, tentativa, worker/época congelados e a pasta da sessão (o backend local
 * usa; os demais ignoram). É o suficiente para o backend endereçar sem
 * recalcular nada que a cerca dependa.
 */
export interface PlanContext {
  sessionId: string
  goalId: string
  taskId: string
  botId: string
  attempt: number
  workerId: string
  leaseEpoch: number
  /** Pasta resolvida da sessão (a função `roots`). Vazia = sessão sem projeto. */
  root: string
}

/**
 * O contrato que todo backend do workspace cumpre. O gerente injeta UM; a
 * suíte da cerca passa igual com qualquer um (é o aceite da Onda 6).
 *
 * `source`/`staging` são PUROS (só endereçam) — rodam dentro do plan() antes de
 * qualquer I/O. `materialize`/`promote` fazem o trabalho de verdade e por isso
 * são assíncronos. O gerente confere a cerca ANTES de chamar `promote`; o
 * backend nunca reimplementa essa checagem.
 */
export interface WorkspaceBackend {
  /** O nome gravado em `plan.source.provider`. */
  readonly provider: string
  /** ONDE a execução materializa desta sessão. */
  source(ctx: PlanContext): WorkspaceSource
  /** A área de espera DESTA tentativa (a época faz parte do endereço). */
  staging(ctx: PlanContext): WorkspaceStaging
  /**
   * Traz o plano para ESTA máquina. Local: resolve a URI de volta para a
   * pasta. Puter: baixa o snapshot para o disco e prepara o staging local.
   */
  materialize(plan: WorkspacePlan): Promise<WorkspaceExecution>
  /**
   * DEPOIS da cerca (o gerente já confirmou worker+época): efetiva a
   * publicação. Local: constata o inplace. Puter: sobe o staging (menos o
   * descartável) para o backend durável.
   */
  promote(plan: WorkspacePlan, result: Publication): Promise<void>
}

/**
 * O backend v1: o workspace é uma pasta desta máquina, o staging é o próprio
 * workspace (inplace) e promover é constatar. É o comportamento que o oráculo
 * Go tinha e que a suíte original fixa — extraído para trás do seam sem mudar
 * uma vírgula do que ele faz.
 */
export class LocalWorkspaceBackend implements WorkspaceBackend {
  readonly provider = LOCAL_PROVIDER

  source(ctx: PlanContext): WorkspaceSource {
    return { provider: LOCAL_PROVIDER, uri: localUri(ctx.root), revision: LIVE_REVISION }
  }

  staging(_ctx: PlanContext): WorkspaceStaging {
    // A v1 escreve DIRETO no workspace — não há área de espera separada.
    return { uri: INPLACE_STAGING }
  }

  async materialize(plan: WorkspacePlan): Promise<WorkspaceExecution> {
    if (plan.source.provider !== LOCAL_PROVIDER) {
      throw new Error(`esta máquina não sabe materializar o provider "${plan.source.provider}"`)
    }
    return { plan, localRoot: localPath(plan.source.uri) }
  }

  async promote(_plan: WorkspacePlan, result: Publication): Promise<void> {
    if (result.stagingUri === INPLACE_STAGING) {
      // O trabalho já está no workspace — promover é constatar.
      return
    }
    throw new Error(`esta máquina não sabe promover "${result.stagingUri}"`)
  }
}
