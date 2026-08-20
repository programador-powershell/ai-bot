/**
 * A escolha de máquina — a ordem de decisão da spec §28, na letra:
 *
 *   1. requirements (o que a Needle DECLAROU — lidos pelo domain/runtime, que
 *      descarta qualquer máquina nomeada pelo modelo)
 *   2. compatibilidade de runtime (admissão: node/python/jvm presentes? arch?)
 *   3. cpu / ram / gpu (admissão: cabe?)
 *   4. capacidade livre (admissão: tem slot?)
 *   5. browser / devices (admissão: o bot de Design precisa de navegador)
 *   6. localidade de snapshot (preferência: quem já tem a imagem começa em segundos)
 *   7. carga (desempate: o menos ocupado)
 *   8. política (o último árbitro: negados saem, preferidos vencem o empate)
 *
 * 1–5 são requisito de ADMISSÃO, não preferência: mandar tarefa para máquina
 * incompatível é falhar DEPOIS de materializar o workspace. 6–8 ordenam os
 * admitidos. O desempate final é estável (id lexicográfico) para que a mesma
 * frota e a mesma tarefa produzam sempre a mesma escolha — escolha instável se
 * lê como defeito intermitente.
 *
 * A INVARIANTE de autoridade: a Needle declara requisitos, o scheduler escolhe
 * a máquina — NUNCA o contrário. Um `workerId` que o modelo tente embutir nos
 * requirements morre no parseRequirements; este módulo nem tem parâmetro para
 * recebê-lo.
 */

import { parseRequirements, type RuntimeRequirements } from '@aibot2/domain-runtime'
import { workerAlive, type WorkerRecord } from '@aibot2/domain-workers'

/** A política do administrador — o passo 8. */
export interface SchedulerPolicy {
  /** Máquinas proibidas para esta carga (saem da admissão). */
  denied?: string[]
  /** Máquinas preferidas (vencem o empate final). */
  preferred?: string[]
}

export interface ChooseOptions {
  /** Relógio injetável para o prazo do heartbeat (worker morto não é destino). */
  now?: () => number
  heartbeatDeadlineMs?: number
  /** A chave base/digest do snapshot resolvido — alimenta a localidade (6). */
  snapshotKey?: string
  policy?: SchedulerPolicy
}

export type Choice =
  | { chosen: WorkerRecord; reason: string }
  | { queued: true; reason: string }

interface Rejection {
  workerId: string
  stage: string
}

function admits(
  requirements: RuntimeRequirements,
  worker: WorkerRecord,
): { ok: true } | { ok: false; stage: string } {
  const caps = worker.capabilities
  // 2. compatibilidade de runtime
  for (const runtime of requirements.runtimes ?? []) {
    if (!caps.runtimes.includes(runtime)) {
      return { ok: false, stage: `runtime ${runtime}` }
    }
  }
  if (requirements.arch !== undefined && requirements.arch !== caps.arch) {
    return { ok: false, stage: `arch ${requirements.arch}` }
  }
  // 3. cpu / ram / gpu
  if (requirements.minCpus !== undefined && caps.cpus < requirements.minCpus) {
    return { ok: false, stage: 'cpu' }
  }
  if (requirements.minRamBytes !== undefined && caps.ramBytes < requirements.minRamBytes) {
    return { ok: false, stage: 'ram' }
  }
  if (requirements.gpu === true && caps.gpu !== true) {
    return { ok: false, stage: 'gpu' }
  }
  if (requirements.docker === true && caps.docker !== true) {
    return { ok: false, stage: 'docker' }
  }
  // 4. capacidade livre
  const slots = caps.slots ?? 1
  if ((worker.running ?? 0) >= slots) {
    return { ok: false, stage: 'sem slot livre' }
  }
  // 5. browser / devices
  if (requirements.browser === true && caps.browser !== true) {
    return { ok: false, stage: 'browser' }
  }
  for (const device of requirements.capabilities ?? []) {
    if (!(caps.capabilities ?? []).includes(device)) {
      return { ok: false, stage: `device ${device}` }
    }
  }
  return { ok: true }
}

/**
 * Escolhe a máquina para uma tarefa, ou devolve a FILA com motivo — nunca uma
 * escolha errada calada (mandar para máquina incompatível falha depois de
 * materializar, que é o pior momento).
 */
export function chooseWorker(
  rawRequirements: Record<string, unknown> | undefined,
  workers: readonly WorkerRecord[],
  options: ChooseOptions = {},
): Choice {
  // 1. requirements — a leitura descarta workerId/machine e afins.
  const requirements = parseRequirements(rawRequirements)
  const now = options.now !== undefined ? options.now() : Date.now()
  const rejections: Rejection[] = []

  const denied = new Set(options.policy?.denied ?? [])
  const admitted: WorkerRecord[] = []
  for (const worker of workers) {
    // Worker morto não é destino — heartbeat com prazo decide.
    if (!workerAlive(worker, now, options.heartbeatDeadlineMs)) {
      rejections.push({ workerId: worker.id, stage: 'heartbeat vencido' })
      continue
    }
    if (denied.has(worker.id)) {
      rejections.push({ workerId: worker.id, stage: 'negado pela política' })
      continue
    }
    const verdict = admits(requirements, worker)
    if (!verdict.ok) {
      rejections.push({ workerId: worker.id, stage: verdict.stage })
      continue
    }
    admitted.push(worker)
  }

  if (admitted.length === 0) {
    const detail =
      rejections.length === 0
        ? 'nenhum worker registrado'
        : rejections.map((each) => `${each.workerId} (${each.stage})`).join(', ')
    return { queued: true, reason: `sem worker compatível: ${detail}` }
  }

  // 6–8. ordenação dos admitidos: localidade → carga → política → id estável.
  const preferred = new Set(options.policy?.preferred ?? [])
  const hasSnapshot = (worker: WorkerRecord): boolean =>
    options.snapshotKey !== undefined &&
    (worker.capabilities.snapshots ?? []).includes(options.snapshotKey)

  const ranked = [...admitted].sort((a, b) => {
    const locality = Number(hasSnapshot(b)) - Number(hasSnapshot(a))
    if (locality !== 0) return locality
    const load = (a.running ?? 0) - (b.running ?? 0)
    if (load !== 0) return load
    const policy = Number(preferred.has(b.id)) - Number(preferred.has(a.id))
    if (policy !== 0) return policy
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const chosen = ranked[0]!
  const why: string[] = []
  if (hasSnapshot(chosen)) why.push(`snapshot ${options.snapshotKey} em cache`)
  why.push(`carga ${chosen.running ?? 0}`)
  if (preferred.has(chosen.id)) why.push('preferido pela política')
  return { chosen, reason: why.join(', ') }
}
