/**
 * A execução materializada — porte de internal/workspace/context.go.
 *
 * A WorkspaceExecution existe SOMENTE dentro do worker que materializou o
 * plano: o caminho físico (C:\..., /var/lib/...) nunca entra no plano
 * persistente. fs, git e proc da TaskRun usam o MESMO localRoot — a
 * alternativa (cada ferramenta resolver o workspace de novo) abre a janela
 * clássica: fs.read na época 17, a tarefa é reatribuída, fs.write na época 18
 * em outro worker.
 *
 * No Go o veículo era o context.Context; aqui a execução viaja EXPLÍCITA no
 * argumento — o TS não tem contexto implícito e um singleton de módulo seria
 * pior (vazaria entre tarefas paralelas).
 */

import type { WorkspacePlan } from './plan.js'

/** Nenhum workspace de execução associado — porte de ErrNoExecution. */
export class NoExecutionError extends Error {
  override name = 'NoExecutionError'
  constructor() {
    super('nenhum workspace de execução associado à tarefa')
  }
}

/** O plano MATERIALIZADO nesta máquina. */
export interface WorkspaceExecution {
  plan: WorkspacePlan
  /**
   * Existe SOMENTE dentro do worker. Vazio = a sessão não tem pasta de
   * projeto (as ferramentas de arquivo recusam, como sempre recusaram).
   */
  localRoot: string
  /** O lugar para preparar a publicação. Vazio na v1 (escreve direto). */
  localStaging?: string
  /** O git sombra de baseline/checkpoints. Vazio até o shadow-git entrar. */
  shadowGitDir?: string
}

/**
 * Devolve a execução ou o motivo de não haver uma — para a ferramenta que não
 * funciona sem workspace: o erro diz o que falta em vez de cair na pasta do
 * processo (que seria o binário do orquestrador).
 */
export function requireMaterialized(
  execution: WorkspaceExecution | undefined,
): WorkspaceExecution {
  if (execution === undefined) {
    throw new NoExecutionError()
  }
  if (execution.localRoot === '') {
    throw new Error('workspace ainda não foi materializado')
  }
  return execution
}
