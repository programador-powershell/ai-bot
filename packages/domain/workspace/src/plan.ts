/**
 * O plano de workspace: ONDE uma execução trabalha, congelado ANTES de ela
 * começar — porte de internal/workspace/plan.go do oráculo Go, na forma da
 * spec §21.
 *
 * A ferramenta nunca recebe nem calcula um diretório: ela recebe uma execução
 * cujo workspace já foi decidido. O plano congela junto QUEM executa (worker)
 * e em que ÉPOCA de lease, e é essa tríade que a cerca confere na promoção —
 * um worker que perdeu o lease pode até terminar o trabalho, mas não consegue
 * transformá-lo em verdade.
 *
 * PERSISTENTE e serializável: nada aqui dentro é caminho físico de uma
 * máquina — o caminho local vive na WorkspaceExecution, que existe somente
 * dentro do worker que materializou. O orquestrador não precisa (e não deve)
 * saber onde cada PC monta as coisas.
 */

/** Backend v1: o workspace é uma pasta desta máquina. */
export const LOCAL_PROVIDER = 'local'
/** O único worker da v1: este processo. */
export const LOCAL_WORKER = 'local'
/** Workspace VIVO, sem endereçamento por conteúdo (o resolver substitui). */
export const LIVE_REVISION = 'live'
/** Runtime "a máquina como está", sem snapshot resolvido por digest. */
export const HOST_SNAPSHOT = 'host'
/** A v1 escreve DIRETO no workspace, sem área de espera separada. */
export const INPLACE_STAGING = 'local://inplace'

/** De onde a execução materializa. O worker nunca promove direto para cá. */
export interface WorkspaceSource {
  provider: string
  uri: string
  revision: string
}

/** O que a tarefa EXIGE da máquina — o espelho de execução do RuntimeRequirements. */
export interface WorkspaceRuntime {
  profile?: string
  snapshotDigest: string
  arch?: string
  minRamBytes?: number
  capabilities?: string[]
}

/** Onde o worker publica ANTES da promoção. */
export interface WorkspaceStaging {
  uri: string
}

/** O estado inicial da tentativa — o diff e o shadow-git medem contra ele. */
export interface WorkspaceBaseline {
  revision: string
  manifestDigest: string
}

/** O contrato completo de uma execução (spec §21). IMUTÁVEL por TaskRun. */
export interface WorkspacePlan {
  id: string
  userId: string
  goalId: string
  sessionId?: string
  taskId: string
  botId: string
  /**
   * Conta as tentativas da MESMA tarefa: a segunda tentativa não pode
   * reaproveitar o staging da primeira.
   */
  attempt: number
  /**
   * O PC registrado que vai executar — não o processo lógico de uma onda
   * (esse é o TaskRunID do despacho).
   */
  workerId: string
  /**
   * A época do lease no momento do congelamento. A cerca compara worker+época
   * na promoção: worker velho com época velha não publica.
   */
  leaseEpoch: number
  source: WorkspaceSource
  runtime: WorkspaceRuntime
  staging: WorkspaceStaging
  baseline: WorkspaceBaseline
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

/**
 * Confere o plano campo a campo. Um plano incompleto não descreve uma
 * execução — descreve uma esperança — e o erro diz exatamente o que falta.
 * As mensagens são o porte 1:1 do Validate() do oráculo.
 */
export function validatePlan(plan: WorkspacePlan): void {
  if (blank(plan.id)) throw new Error('workspace plan sem id')
  if (blank(plan.userId)) throw new Error('workspace plan sem userId')
  if (blank(plan.goalId)) throw new Error('workspace plan sem goalId')
  if (blank(plan.taskId)) throw new Error('workspace plan sem taskId')
  if (blank(plan.botId)) throw new Error('workspace plan sem botId')
  if (plan.attempt === 0 || plan.attempt < 0) throw new Error('workspace plan com attempt zero')
  if (blank(plan.workerId)) throw new Error('workspace plan sem workerId')
  if (plan.leaseEpoch === 0 || plan.leaseEpoch < 0) throw new Error('workspace plan sem leaseEpoch')
  if (blank(plan.source.provider)) throw new Error('workspace plan sem source provider')
  if (blank(plan.source.uri)) throw new Error('workspace plan sem source uri')
  if (blank(plan.source.revision)) throw new Error('workspace plan sem source revision')
  if (blank(plan.runtime.snapshotDigest)) throw new Error('workspace plan sem runtime snapshot')
  if (blank(plan.staging.uri)) throw new Error('workspace plan sem staging uri')
  if (blank(plan.baseline.manifestDigest)) throw new Error('workspace plan sem baseline')
}

/** Resumo legível para log — a forma do String() do oráculo. */
export function planToString(plan: WorkspacePlan): string {
  return `${plan.id} task=${plan.taskId} bot=${plan.botId} worker=${plan.workerId} attempt=${plan.attempt} epoch=${plan.leaseEpoch}`
}

/**
 * A área de espera de uma tentativa: `staging/<task>/<época>` do desenho do
 * cluster. Duas publicações da mesma tarefa nunca se misturam porque estão em
 * lugares DIFERENTES — a época faz parte do endereço.
 */
export function stagingUri(taskId: string, epoch: number): string {
  return `staging://${taskId}/epoch-${epoch}`
}

/* -------------------------------- URIs ----------------------------------- */

/**
 * Codifica a pasta como URI do provider local. Vazio vira "local://sem-pasta"
 * — um plano VÁLIDO cuja materialização produz root vazio, e aí as
 * ferramentas de arquivo recusam com o motivo de sempre.
 */
export function localUri(root: string): string {
  if (root === '') return 'local://sem-pasta'
  return 'local://' + root.replaceAll('\\', '/')
}

/** Desfaz localUri. É a ÚNICA tradução URI→caminho da v1. */
export function localPath(uri: string): string {
  if (!uri.startsWith('local://')) return ''
  const rest = uri.slice('local://'.length)
  return rest === 'sem-pasta' ? '' : rest
}
