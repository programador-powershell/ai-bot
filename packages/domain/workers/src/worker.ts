/**
 * Worker = PC FÍSICO. Não é o processo lógico de uma onda (esse é o TaskRunID
 * do despacho) nem o container (esse é execução efêmera). A confusão entre os
 * três é a cicatriz R6 do m0-inventario — o workerID sintético e o PC físico
 * dividiam nome de campo no crew.go — e este módulo existe para que ela não
 * volte: aqui só mora máquina.
 */

/**
 * O que a máquina TEM — as entradas de admissão e desempate do scheduler
 * (spec §28): runtime → cpu/ram/gpu → capacidade livre → browser/devices →
 * localidade de snapshot → carga.
 */
export interface WorkerCapabilities {
  cpus: number
  ramBytes: number
  arch: string
  /** Runtimes instalados por nome ("node", "python", "jvm"...). */
  runtimes: string[]
  gpu?: boolean
  docker?: boolean
  /** Navegador headless disponível. */
  browser?: boolean
  /** Capacidades nomeadas extras (devices). */
  capabilities?: string[]
  /** Chaves de snapshot (base/digest) já aquecidas no cache local. */
  snapshots?: string[]
  /** Quantas tarefas simultâneas a máquina aceita. */
  slots?: number
}

/** Um PC registrado no cluster. */
export interface WorkerRecord {
  /** `pc-<hostname>` — identidade de máquina de verdade, nunca gerada por onda. */
  id: string
  hostname: string
  capabilities: WorkerCapabilities
  /** Último batimento, ISO-8601. */
  lastSeen: string
  /** Tarefas em execução AGORA (a carga do desempate). */
  running?: number
}

/**
 * Prazo do heartbeat: sem batimento por este tempo o worker é considerado
 * MORTO para fins de escalonamento. 3× o intervalo de batimento do oráculo
 * (30s) — um pacote perdido não mata a máquina; três seguidos sim.
 */
export const HEARTBEAT_DEADLINE_MS = 90_000

/** O worker ainda vale como destino de despacho? */
export function workerAlive(
  worker: Pick<WorkerRecord, 'lastSeen'>,
  nowMs: number,
  deadlineMs: number = HEARTBEAT_DEADLINE_MS,
): boolean {
  const seen = Date.parse(worker.lastSeen)
  if (Number.isNaN(seen)) return false
  return nowMs - seen <= deadlineMs
}

/**
 * Deriva o id do worker a partir do hostname — porte do safeName do fleet.go:
 * minúsculas, [a-z0-9-] preservados, o resto vira `_`. O nome NUNCA é aceito
 * de fora pronto (a lição do supervisor do openbot: nomes derivados, não
 * recebidos).
 */
export function workerIdFromHostname(hostname: string): string {
  const safe = [...hostname.toLowerCase()]
    .map((ch) => (/[a-z0-9-]/.test(ch) ? ch : '_'))
    .join('')
  return `pc-${safe === '' ? 'local' : safe}`
}
