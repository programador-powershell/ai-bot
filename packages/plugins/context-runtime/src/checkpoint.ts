/**
 * Checkpoint/recovery do Context Runtime.
 *
 * checkpoint = cápsula + cursor do event log + artefatos necessários +
 * pendências de aprovação. resume = checkpoint + EVENT STORE — NUNCA a RAM do
 * processo anterior: tudo que só existia em memória quando o processo morreu
 * ou está no log (e a dobra o recupera) ou não aconteceu (e o funil de
 * aprovação durável o faz REAPARECER). É a mesma disciplina do E4: estado que
 * não sobrevive a reinício não é estado, é sorte.
 *
 * O CheckpointStore é um seam: a implementação em disco (JSON, temp+rename)
 * mora aqui por enquanto — quando o provider definitivo nascer, ela muda de
 * pacote sem mudar nenhum consumidor.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeId } from '@aibot2/plugin-action-gateway'
import { MAX_EVENT_BATCH, type StorageDriver } from '@aibot2/domain-events'
import { Capsule, type ArtifactNote, type CapsuleData } from './capsule.js'

export const CHECKPOINT_VERSION = 1

/** Uma aprovação que estava pendente quando o checkpoint foi tirado. */
export interface PendingApprovalNote {
  callId: string
  tool: string
  summary: string
  turn: string
}

/** O que basta para retomar a sessão de onde ela parou. */
export interface Checkpoint {
  version: number
  sessionId: string
  savedAt: string
  /** O seq mais alto que a cápsula já dobrou — o resume dobra DALI em diante. */
  eventCursor: number
  capsule: CapsuleData
  /** As saídas integrais de que a continuação pode precisar (refs, não bytes). */
  artifacts: ArtifactNote[]
  /**
   * Pendências de aprovação NO MOMENTO do checkpoint. Registro observável —
   * a verdade viva continua sendo o log (o resume as RECALCULA de lá; uma
   * decisão que chegou depois do checkpoint não pode ressuscitar o pedido).
   */
  pendingApprovals: PendingApprovalNote[]
}

/** O seam de persistência do checkpoint. */
export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>
  /**
   * Tolerante como o Load da cápsula: ausente OU corrompido devolve
   * undefined — o resume então recomeça do zero pelo log, que é a fonte.
   */
  load(sessionId: string): Promise<Checkpoint | undefined>
}

/* ------------------------------ store em disco ----------------------------- */

/** Um arquivo JSON por sessão; escrita em dois tempos (temp+rename). */
export class FsCheckpointStore implements CheckpointStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  #path(sessionId: string): string {
    // safeId é o MESMO guarda do Artifact Store: id vindo de fora não escolhe
    // onde escrever.
    return join(this.#root, 'checkpoints', `${safeId(sessionId)}.json`)
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    const path = this.#path(checkpoint.sessionId)
    await mkdir(join(this.#root, 'checkpoints'), { recursive: true })
    const temp = path + '.tmp'
    // Dois tempos: quem ler no meio de uma queda vê o checkpoint ANTERIOR
    // inteiro, nunca metade do novo — meio-checkpoint é pior que nenhum.
    await writeFile(temp, JSON.stringify(checkpoint))
    try {
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  async load(sessionId: string): Promise<Checkpoint | undefined> {
    let raw: string
    try {
      raw = await readFile(this.#path(sessionId), 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as Checkpoint
      if (parsed === null || typeof parsed !== 'object') return undefined
      if (parsed.version !== CHECKPOINT_VERSION) return undefined
      if (typeof parsed.sessionId !== 'string' || typeof parsed.eventCursor !== 'number') return undefined
      return parsed
    } catch {
      // Corrompido não derruba: o log refaz a cápsula nas dobras seguintes.
      return undefined
    }
  }
}

/** Store em memória para testes e montagens sem disco. */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly #byId = new Map<string, string>()

  async save(checkpoint: Checkpoint): Promise<void> {
    // Serializa de verdade: o teste de recovery precisa provar que o resume
    // vive do que SERIALIZA, não de referências vivas do processo anterior.
    this.#byId.set(checkpoint.sessionId, JSON.stringify(checkpoint))
  }

  async load(sessionId: string): Promise<Checkpoint | undefined> {
    const raw = this.#byId.get(sessionId)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as Checkpoint
    } catch {
      return undefined
    }
  }
}

/* ------------------------------- pendências -------------------------------- */

/**
 * Varre o LOG atrás de approval.request sem decisão e sem desfecho — a mesma
 * regra do pendingApprovals do action-gateway, reimplementada aqui de
 * propósito: o checkpoint precisa ser tirável e retomável SEM o gateway
 * montado (um runtime de leitura, um exportador). O contrato dos dois é o
 * mesmo log; se divergirem, um teste de compat pega.
 */
export async function collectPendingApprovals(
  store: StorageDriver,
  sessionId: string,
): Promise<PendingApprovalNote[]> {
  const pending = new Map<string, PendingApprovalNote>()
  let from = 0
  for (;;) {
    const batch = await store.since(sessionId, from, MAX_EVENT_BATCH)
    if (batch.length === 0) break
    for (const envelope of batch) {
      from = envelope.seq
      const payload = envelope.payload as Record<string, unknown> | undefined
      const callId = typeof payload?.['callId'] === 'string' ? (payload['callId'] as string) : ''
      if (callId === '') continue
      if (envelope.kind === 'approval.request') {
        pending.set(callId, {
          callId,
          tool: typeof payload?.['tool'] === 'string' ? (payload['tool'] as string) : '',
          summary: typeof payload?.['summary'] === 'string' ? (payload['summary'] as string) : '',
          turn: envelope.turn ?? '',
        })
      } else if (envelope.kind === 'approval.decision' || envelope.kind === 'tool.result') {
        pending.delete(callId)
      }
    }
    if (batch.length < MAX_EVENT_BATCH) break
  }
  return [...pending.values()]
}

/* --------------------------------- montagem -------------------------------- */

/** Tira o checkpoint da sessão a partir da cápsula viva + o log. */
export async function buildCheckpoint(
  store: StorageDriver,
  sessionId: string,
  capsule: Capsule,
): Promise<Checkpoint> {
  return {
    version: CHECKPOINT_VERSION,
    sessionId,
    savedAt: new Date().toISOString(),
    eventCursor: capsule.cursor,
    capsule: capsule.toData(),
    artifacts: capsule.artifacts.map((artifact) => ({ ...artifact })),
    pendingApprovals: await collectPendingApprovals(store, sessionId),
  }
}

/** O desfecho de um resume. */
export interface Resumed {
  capsule: Capsule
  /** true = havia checkpoint; false = a sessão foi refeita SÓ pelo log. */
  fromCheckpoint: boolean
  /** Recalculadas do LOG no momento do resume (a verdade viva). */
  pendingApprovals: PendingApprovalNote[]
}

/**
 * Retoma a sessão: cápsula do checkpoint (ou nova) + dobra de TUDO que o log
 * tem além do cursor. É o caminho de reinício — o processo anterior morreu
 * com estado em RAM e esse estado NÃO é consultado (não existe mais).
 */
export async function resumeFromCheckpoint(
  store: StorageDriver,
  checkpoints: CheckpointStore,
  sessionId: string,
): Promise<Resumed> {
  const saved = await checkpoints.load(sessionId)
  const capsule = saved === undefined ? new Capsule() : Capsule.fromData(saved.capsule)
  // A dobra pós-checkpoint: o que aconteceu entre o último checkpoint e a
  // morte do processo está no log — e SÓ no log.
  for (;;) {
    const batch = await store.since(sessionId, capsule.cursor, MAX_EVENT_BATCH)
    if (batch.length === 0) break
    capsule.fold(batch)
    if (batch.length < MAX_EVENT_BATCH) break
  }
  return {
    capsule,
    fromCheckpoint: saved !== undefined,
    pendingApprovals: await collectPendingApprovals(store, sessionId),
  }
}
