/**
 * O backend PUTER do WorkspaceManager (Onda 6): o mesmo seam do backend local,
 * agora com os bytes indo e voltando de uma conta Puter. A cerca (worker+época)
 * NÃO está aqui — ela fica no gerente e este backend só é chamado DEPOIS que
 * ela passou. Por isso a mesma suíte da cerca passa com este backend injetado.
 *
 * O contrato prático:
 *   - materialize: Puter → disco local. O container trabalha no DISCO, como
 *     sempre; o Puter é só de onde veio e para onde vai.
 *   - promote: disco local → Puter, em DUAS camadas (spec §23):
 *       sobe o resultado promovido (para /Goals/<id>/artifacts/<task>/época/)
 *       e o metadado (para /Goals/<id>/history/…json);
 *       NUNCA sobe o descartável do container (node_modules etc. — a lista
 *       isDisposable do domain).
 *
 * O disco local espelha a árvore do Puter sob um workRoot: `<workRoot>/Goals/
 * <id>/workspace` e `…/staging/<task>/epoch-<n>`. Como o endereço é
 * determinístico a partir do plano, o promote reencontra o staging que o
 * materialize preparou sem precisar de estado carregado entre as chamadas.
 */

import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LIVE_REVISION,
  isDisposable,
  type PlanContext,
  type Publication,
  type WorkspaceBackend,
  type WorkspaceExecution,
  type WorkspacePlan,
  type WorkspaceSource,
  type WorkspaceStaging,
} from '@aibot2/domain-workspace'
import {
  goalArtifactsAttempt,
  goalHistoryEntry,
  goalStagingAttempt,
  goalWorkspace,
  puterPath,
  puterUri,
  type PuterFs,
} from '@aibot2/plugin-puter-workspace'

/** O provider que este backend anuncia em `plan.source.provider`. */
export const PUTER_PROVIDER = 'puter'

export interface PuterWorkspaceBackendOptions {
  /** O filesystem do Puter (o fake nos testes; o HttpPuterFs numa conta real). */
  fs: PuterFs
  /**
   * A raiz LOCAL onde a árvore do Puter é espelhada nesta máquina. O container
   * trabalha aqui; nada disso é fonte de verdade (é o "disco descartável").
   */
  workRoot: string
}

/** Um arquivo local candidato a subir: o caminho relativo (à raiz) e o absoluto. */
interface Promotable {
  rel: string
  abs: string
}

export class PuterWorkspaceBackend implements WorkspaceBackend {
  readonly provider = PUTER_PROVIDER
  readonly #puter: PuterFs
  readonly #workRoot: string

  constructor(options: PuterWorkspaceBackendOptions) {
    this.#puter = options.fs
    this.#workRoot = options.workRoot
  }

  source(ctx: PlanContext): WorkspaceSource {
    // A source é o WORKSPACE do Goal — compartilhado, nunca duplicado por bot.
    return {
      provider: PUTER_PROVIDER,
      uri: puterUri(goalWorkspace(ctx.goalId)),
      revision: LIVE_REVISION,
    }
  }

  staging(ctx: PlanContext): WorkspaceStaging {
    // A área de espera DESTA tentativa: a época faz parte do endereço.
    return {
      uri: puterUri(goalStagingAttempt(ctx.goalId, ctx.taskId, ctx.leaseEpoch)),
    }
  }

  async materialize(plan: WorkspacePlan): Promise<WorkspaceExecution> {
    if (plan.source.provider !== PUTER_PROVIDER) {
      throw new Error(`o backend puter não materializa o provider "${plan.source.provider}"`)
    }
    const sourcePath = puterPath(plan.source.uri)
    const localRoot = this.#mirror(sourcePath)
    // Baixa Puter → disco. Goal novo (workspace ainda inexistente) materializa
    // vazio — é estado válido, não erro (a primeira tarefa cria o projeto).
    await this.#download(sourcePath, localRoot)

    const localStaging = this.#mirror(puterPath(plan.staging.uri))
    await mkdir(localStaging, { recursive: true })

    return { plan, localRoot, localStaging }
  }

  async promote(plan: WorkspacePlan, result: Publication): Promise<void> {
    // A cerca já passou no gerente. Aqui só se promove o staging QUE ESTE PLANO
    // declarou — promover outro endereço seria aceitar trabalho de outra
    // tentativa (o espelho puter da recusa de "staging desconhecido" do local).
    if (result.stagingUri !== plan.staging.uri) {
      throw new Error(
        `o backend puter só promove o staging deste plano (${plan.staging.uri}), não "${result.stagingUri}"`,
      )
    }

    const localStaging = this.#mirror(puterPath(plan.staging.uri))
    const promotable = await this.#collectPromotable(localStaging)

    // Camada 1 — o RESULTADO promovido, arquivo a arquivo, sob os artifacts do
    // Goal. Só o que sobreviveu à exclusão do descartável chega aqui.
    const artifactsBase = goalArtifactsAttempt(plan.goalId, plan.taskId, plan.leaseEpoch)
    for (const file of promotable) {
      const bytes = await readFile(file.abs)
      await this.#puter.writeFile(`${artifactsBase}/${file.rel}`, bytes)
    }

    // Camada 2 — o METADADO da promoção. Determinístico de propósito (sem
    // relógio): o mesmo plano promovido produz o mesmo registro, e o replay não
    // vê um history que "mudou sozinho".
    const meta = {
      workspacePlanId: plan.id,
      goalId: plan.goalId,
      taskId: plan.taskId,
      botId: plan.botId,
      attempt: plan.attempt,
      workerId: plan.workerId,
      leaseEpoch: plan.leaseEpoch,
      artifacts: promotable.map((file) => file.rel).sort(),
    }
    await this.#puter.writeFile(
      goalHistoryEntry(plan.goalId, plan.taskId, plan.leaseEpoch),
      new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`),
    )
  }

  /* ------------------------------ internos ------------------------------- */

  /** Espelha um caminho da conta Puter para o disco local sob o workRoot. */
  #mirror(accountPath: string): string {
    const segments = accountPath.split('/').filter((s) => s !== '')
    return join(this.#workRoot, ...segments)
  }

  /** Copia recursivamente uma pasta do Puter para o disco local. */
  async #download(puterDir: string, localDir: string): Promise<void> {
    await mkdir(localDir, { recursive: true })
    if (!(await this.#puter.exists(puterDir))) {
      return // fonte ainda não existe: workspace vazio, materializa vazio.
    }
    for (const entry of await this.#puter.readdir(puterDir)) {
      const childPuter = `${puterDir}/${entry.name}`
      const childLocal = join(localDir, entry.name)
      if (entry.isDirectory) {
        await this.#download(childPuter, childLocal)
      } else {
        const bytes = await this.#puter.readFile(childPuter)
        await writeFile(childLocal, bytes)
      }
    }
  }

  /**
   * Anda o staging local e devolve o que SOBE — podando o descartável já na
   * descida (não desce em node_modules et al.: é a diferença entre subir um
   * arquivo e varrer 10 mil). Staging inexistente = nada a promover (é o caso
   * do teste da cerca, que promove sem ter materializado).
   */
  async #collectPromotable(root: string): Promise<Promotable[]> {
    if (!(await this.#isDir(root))) return []
    const out: Promotable[] = []
    const walk = async (absDir: string, relDir: string): Promise<void> => {
      for (const entry of await readdir(absDir, { withFileTypes: true })) {
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
        if (isDisposable(rel)) continue // o descartável não sobe — nunca.
        const abs = join(absDir, entry.name)
        if (entry.isDirectory()) {
          await walk(abs, rel)
        } else if (entry.isFile()) {
          out.push({ rel, abs })
        }
      }
    }
    await walk(root, '')
    return out
  }

  async #isDir(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }
}
