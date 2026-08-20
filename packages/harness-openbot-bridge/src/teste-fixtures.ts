/**
 * APOIO DE TESTE compartilhado — as fixtures do oráculo e o store com ganchos.
 *
 * [Onda 2] Separado do teste-apoio.ts (que monta o transporte NODE) porque
 * agora há DOIS transportes exercitando os mesmos testes nomeados: o Node
 * (dublê, suíte nucleo) e o do chassis (Bun.serve, suíte chassis). Os dois
 * leem as MESMAS fixtures e usam o MESMO store instrumentado — duplicar isto
 * em cada suíte deixaria as invariantes com duas definições que divergem.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  importLogJsonl,
  type Envelope,
  type EnvelopeInput,
  type SessionMeta,
  type SessionSeed,
  type StorageDriver,
} from '@aibot2/domain-events'

/** Caminho das fixtures do oráculo (test-fixtures/ na raiz do repo). */
const FIXTURES = new URL('../../../test-fixtures/', import.meta.url)

export function lerFixture(relativo: string): string {
  return readFileSync(fileURLToPath(new URL(relativo, FIXTURES)), 'utf8')
}

/** Uma linha de transcrição WS: o frame gravado com a direção anotada. */
export interface LinhaDeTranscricao extends Record<string, unknown> {
  _dir: '->' | '<-'
  kind: string
  seq: number
  session: string
  payload?: unknown
}

export function lerTranscricao(relativo: string): LinhaDeTranscricao[] {
  return lerFixture(relativo)
    .split(/\r?\n/)
    .filter((linha) => linha.trim() !== '')
    .map((linha) => JSON.parse(linha) as LinhaDeTranscricao)
}

/**
 * Semeia uma sessão do oráculo no store: o cabeçalho vem do meta.json e cada
 * envelope do log.jsonl entra pelo append (que preserva ts e renumera 1..N —
 * os seq das fixtures já são 1..N, então os números batem).
 */
export async function semearSessaoDeFixture(
  store: StorageDriver,
  pasta: 'chat-simples' | 'ferramenta-aprovada',
): Promise<SessionMeta> {
  const meta = JSON.parse(lerFixture(`sessions/${pasta}/meta.json`)) as SessionMeta
  const seed: SessionSeed = {
    id: meta.id,
    title: meta.title,
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    createdAt: meta.createdAt,
  }
  await store.createSession(seed)
  const envelopes: Envelope[] = importLogJsonl(lerFixture(`sessions/${pasta}/log.jsonl`))
  for (const envelope of envelopes) {
    await store.append(meta.id, envelope as EnvelopeInput)
  }
  return store.getSession(meta.id)
}

/**
 * Store que DELEGA tudo e deixa o teste pendurar ganchos nos pontos críticos
 * das invariantes de ordem: depois do `since` do replay (invariante a) e antes
 * do `lastSeq` do ready (a janela do liveOnly, invariante c).
 */
export class StoreComGancho implements StorageDriver {
  ganchoDepoisDoSince: ((fromSeq: number, limit: number | undefined) => Promise<void>) | undefined
  ganchoAntesDoLastSeq: (() => Promise<void>) | undefined

  constructor(private readonly interno: StorageDriver) {}

  createSession(seed: SessionSeed): Promise<SessionMeta> {
    return this.interno.createSession(seed)
  }
  getSession(id: string): Promise<SessionMeta> {
    return this.interno.getSession(id)
  }
  updateSession(id: string, mutate: (meta: SessionMeta) => void): Promise<SessionMeta> {
    return this.interno.updateSession(id, mutate)
  }
  markSynced(id: string, seq: number): Promise<void> {
    return this.interno.markSynced(id, seq)
  }
  listSessions(): Promise<SessionMeta[]> {
    return this.interno.listSessions()
  }
  deleteSession(id: string): Promise<void> {
    return this.interno.deleteSession(id)
  }
  append(sessionId: string, input: EnvelopeInput): Promise<number> {
    return this.interno.append(sessionId, input)
  }
  async since(sessionId: string, fromSeq: number, limit?: number): Promise<Envelope[]> {
    const lote = await this.interno.since(sessionId, fromSeq, limit)
    if (this.ganchoDepoisDoSince !== undefined) {
      await this.ganchoDepoisDoSince(fromSeq, limit)
    }
    return lote
  }
  async lastSeq(sessionId: string): Promise<number> {
    if (this.ganchoAntesDoLastSeq !== undefined) {
      await this.ganchoAntesDoLastSeq()
    }
    return this.interno.lastSeq(sessionId)
  }
  truncateBefore(sessionId: string, beforeSeq: number): Promise<SessionMeta> {
    return this.interno.truncateBefore(sessionId, beforeSeq)
  }
  close(): Promise<void> {
    return this.interno.close()
  }
}
