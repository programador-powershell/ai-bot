/**
 * O EXECUTION TARGET — a cirurgia da spec §3 sobre o desenho do openbot.
 *
 * O openbot amarra botId→computador permanente: todo bot tem um browser que
 * sobrevive entre turnos. Aqui a chave de execução é OUTRA: a tríade do
 * despacho (taskRunId + workerId + leaseEpoch) mais o runtimeId da sessão de
 * browser — o browser é TASK-SCOPED (spec §32): nasce para a TaskRun que
 * declarou requirements.browser=true e morre com ela. Bot ocioso consome ZERO
 * navegadores.
 *
 * Este módulo é só o vocabulário + a validação: quem decide política é o
 * BrowserRuntimeService, e quem escolhe worker/época é o scheduler — o target
 * chega PRONTO do despacho, nunca é inventado aqui.
 */

/** A chave de execução que autoriza um browser: a tríade do despacho + a sessão. */
export interface ExecutionTarget {
  /** A tentativa LÓGICA (run-<task>-a<n>) — nunca o nome de uma máquina. */
  taskRunId: string
  /** O PC físico que detém o lease. */
  workerId: string
  /** A época do lease no congelamento — a cerca compara worker+época. */
  leaseEpoch: number
  /** A sessão de browser desta execução no agent-computer. */
  runtimeId: string
}

/** Recusa de política do browser task-scoped — SEMPRE com motivo legível. */
export class BrowserRefusalError extends Error {
  override name = 'BrowserRefusalError'
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

/**
 * Confere o target campo a campo — a mesma filosofia do validatePlan do
 * domain/workspace: um target incompleto não descreve uma execução, descreve
 * uma esperança, e o erro diz exatamente o que falta.
 */
export function validateTarget(target: ExecutionTarget): void {
  if (blank(target.taskRunId)) throw new BrowserRefusalError('execution target sem taskRunId')
  if (blank(target.workerId)) throw new BrowserRefusalError('execution target sem workerId')
  if (!Number.isInteger(target.leaseEpoch) || target.leaseEpoch < 1) {
    throw new BrowserRefusalError('execution target sem leaseEpoch válida (época ≥ 1)')
  }
  if (blank(target.runtimeId)) throw new BrowserRefusalError('execution target sem runtimeId')
}
