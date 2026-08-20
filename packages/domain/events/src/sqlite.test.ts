/**
 * A bateria de aceite do E2 (m1-plano §5) — a mais importante do M1:
 *
 * 1. CORRIDA: 200 appends concorrentes → seq 1..200 sem furo nem repetição.
 *    Existe porque o event loop não protege nada entre awaits (RS5).
 * 2. COMPAT DE REPLAY: o log REAL do gateway Go entra pelo importador e
 *    `since(n)` devolve os MESMOS envelopes na MESMA ordem — campo a campo.
 * 3. TRUNCATE: corte durável, no-op além do fim, numeração 1..N continua
 *    verdadeira, cursor de espelho clampado — e a durabilidade é provada
 *    REABRINDO o arquivo de verdade no Windows, sem mock.
 * 4. DURABILIDADE POR VERBO: provada por instrumentação (o valor VIVO de
 *    PRAGMA synchronous), não por fé no contador.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { Kind } from './protocol.js'
import { importLogJsonl } from './fixture.js'
import { SqliteEventStore } from './sqlite.js'
import {
  MAX_EVENT_BATCH,
  SessionExistsError,
  SessionNotFoundError,
  StoreInUseError,
  type EnvelopeInput,
} from './storage.js'

const FIXTURES = new URL('../../../../test-fixtures/', import.meta.url)

function readFixture(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, FIXTURES)), 'utf8')
}

/* ------------------------------ infra de teste ---------------------------- */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

/** Store num diretório temporário REAL — os testes de durabilidade reabrem o arquivo. */
function newStore(): { store: SqliteEventStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aibot2-events-'))
  const path = join(dir, 'events.db')
  const store = SqliteEventStore.open(path)
  cleanups.push(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, path }
}

/** Reabre o mesmo arquivo (o anterior TEM de estar fechado — regra do escritor único). */
function reopen(path: string): SqliteEventStore {
  const store = SqliteEventStore.open(path)
  cleanups.push(async () => {
    await store.close()
  })
  return store
}

let eventCounter = 0

function ev(kind: Kind, extra: Partial<EnvelopeInput> = {}): EnvelopeInput {
  eventCounter += 1
  return { id: `e-${eventCounter}`, kind, from: { kind: 'user' }, ...extra }
}

function userMessage(text: string, turn?: string): EnvelopeInput {
  return ev('message', {
    payload: { role: 'user', text },
    ...(turn !== undefined ? { turn } : {}),
  })
}

function doneOf(turn: string): EnvelopeInput {
  return ev('done', { turn, from: { kind: 'supervisor' }, payload: { turn } })
}

/* -------------------------------- corrida -------------------------------- */

describe('corrida de appends (o aceite que define o E2)', () => {
  it('200 appends concorrentes numeram 1..200 sem furo nem repetição', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's-corrida' })

    const writers = 4
    const perWriter = 50
    const seqs: number[] = []

    await Promise.all(
      Array.from({ length: writers }, (_, writer) =>
        (async () => {
          for (let index = 0; index < perWriter; index++) {
            const seq = await store.append(
              's-corrida',
              userMessage(`w${writer}-${index}`),
            )
            seqs.push(seq)
            // await no meio de propósito: alarga a janela de interleave — é a
            // forma da corrida que o mutex por sessão tem de vencer.
            await Promise.resolve()
          }
        })(),
      ),
    )

    expect(seqs).toHaveLength(writers * perWriter)
    const sorted = [...seqs].sort((a, b) => a - b)
    for (const [index, seq] of sorted.entries()) {
      // Furo ou repetição apareceria aqui com o número exato na mão.
      expect(seq).toBe(index + 1)
    }

    // O log gravado conta a mesma história que os números devolvidos.
    const replay = await store.since('s-corrida', 0)
    expect(replay).toHaveLength(writers * perWriter)
    for (const [index, envelope] of replay.entries()) {
      expect(envelope.seq).toBe(index + 1)
    }
  }, 30_000)
})

/* --------------------------- compat com o oráculo ------------------------- */

describe('compat de replay com o log REAL do gateway Go', () => {
  it('chat-simples: since(0) devolve exatamente os envelopes da fixture, na ordem', async () => {
    const { store } = newStore()
    const envelopes = importLogJsonl(readFixture('sessions/chat-simples/log.jsonl'))
    const sessionId = envelopes[0]?.session ?? ''
    await store.createSession({ id: sessionId })

    for (const envelope of envelopes) {
      // O store IGNORA o seq que veio e numera sozinho — os números têm de
      // coincidir porque a ordem de gravação é a do log (1..N contínuo).
      const seq = await store.append(sessionId, envelope)
      expect(seq).toBe(envelope.seq)
    }

    // Campo a campo, por valor — nunca por referência nem por byte.
    const replay = await store.since(sessionId, 0)
    expect(replay).toEqual(envelopes)
  })

  it('ferramenta-aprovada: cursor no meio devolve o resto, e o fim devolve nada', async () => {
    const { store } = newStore()
    const envelopes = importLogJsonl(readFixture('sessions/ferramenta-aprovada/log.jsonl'))
    const sessionId = envelopes[0]?.session ?? ''
    await store.createSession({ id: sessionId })
    for (const envelope of envelopes) {
      await store.append(sessionId, envelope)
    }

    expect(await store.since(sessionId, 0)).toEqual(envelopes)
    // O replay de reconexão: "vi até o 4, me dá o resto" — inclusive o
    // quadrilátero de aprovação inteiro, que é durável por decisão.
    expect(await store.since(sessionId, 4)).toEqual(envelopes.slice(4))
    expect(await store.since(sessionId, 9)).toEqual([])
  })

  it('o cabeçalho reconstruído bate com o meta.json que o Go gravou', async () => {
    const { store } = newStore()
    const envelopes = importLogJsonl(readFixture('sessions/ferramenta-aprovada/log.jsonl'))
    const oracle = JSON.parse(readFixture('sessions/ferramenta-aprovada/meta.json')) as {
      lastSeq: number
      turns: number
      specialist: string
      syncedSeq: number
    }
    const sessionId = envelopes[0]?.session ?? ''
    await store.createSession({ id: sessionId })
    for (const envelope of envelopes) {
      await store.append(sessionId, envelope)
    }

    const meta = await store.getSession(sessionId)
    expect(meta.lastSeq).toBe(oracle.lastSeq)
    expect(meta.turns).toBe(oracle.turns)
    expect(meta.specialist).toBe(oracle.specialist)
    expect(meta.syncedSeq).toBe(oracle.syncedSeq)
    expect(await store.lastSeq(sessionId)).toBe(oracle.lastSeq)
  })
})

/* ------------------------------ replay/paginação -------------------------- */

describe('since', () => {
  it('pagina por cursor: cada lote começa depois do último seq visto', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    for (let index = 0; index < 7; index++) {
      await store.append('s1', userMessage(`m${index}`))
    }

    expect((await store.since('s1', 0, 3)).map((envelope) => envelope.seq)).toEqual([1, 2, 3])
    expect((await store.since('s1', 3, 3)).map((envelope) => envelope.seq)).toEqual([4, 5, 6])
    expect((await store.since('s1', 6, 3)).map((envelope) => envelope.seq)).toEqual([7])
    expect(await store.since('s1', 7, 3)).toEqual([])
  })

  it('o teto MAX_EVENT_BATCH vale mesmo quando o chamador pede mais', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    // deltas: efêmeros e baratos — aqui só interessa a contagem.
    for (let index = 0; index < MAX_EVENT_BATCH + 20; index++) {
      await store.append('s1', ev('delta', { payload: { text: 'x' } }))
    }
    const batch = await store.since('s1', 0, 99_999)
    expect(batch).toHaveLength(MAX_EVENT_BATCH)
  }, 30_000)

  it('sessão desconhecida é erro nomeado, não lote vazio', async () => {
    const { store } = newStore()
    await expect(store.since('fantasma', 0)).rejects.toThrow(SessionNotFoundError)
    await expect(store.append('fantasma', userMessage('oi'))).rejects.toThrow(
      SessionNotFoundError,
    )
    await expect(store.lastSeq('fantasma')).rejects.toThrow(SessionNotFoundError)
  })
})

/* -------------------------------- truncate -------------------------------- */

describe('truncateBefore (corte durável)', () => {
  it('corta, reconta turnos e a numeração continua do novo fim', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('primeira pergunta', 't1'))
    await store.append('s1', doneOf('t1'))
    const cutAt = await store.append('s1', userMessage('segunda pergunta', 't2'))
    await store.append('s1', doneOf('t2'))

    const meta = await store.truncateBefore('s1', cutAt)
    expect(meta.lastSeq).toBe(cutAt - 1)
    expect(meta.turns).toBe(1)

    const replay = await store.since('s1', 0)
    expect(replay).toHaveLength(cutAt - 1)
    expect(replay.some((envelope) => envelope.turn === 't2')).toBe(false)

    // O append seguinte continua do novo fim — sem buraco e sem colisão.
    const next = await store.append('s1', userMessage('pergunta refeita', 't3'))
    expect(next).toBe(cutAt)
  })

  it('sobrevive à reabertura: o corte foi ao disco, não só ao processo', async () => {
    const { store, path } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('fica'))
    await store.append('s1', userMessage('fica também'))
    await store.append('s1', userMessage('sai'))

    await store.truncateBefore('s1', 3)
    await store.close()

    // A "equivalência do rename": no oráculo era temp+fsync+rename e o teste
    // provava que nenhum descritor atravessava a troca; aqui o corte é UMA
    // transação e a prova é a mesma de sempre — reabrir o ARQUIVO real (neste
    // Windows, nesta máquina) e o log contar a história cortada.
    const second = reopen(path)
    expect(await second.lastSeq('s1')).toBe(2)
    expect(await second.since('s1', 0)).toHaveLength(2)
    expect(await second.append('s1', userMessage('recomeço'))).toBe(3)
  })

  it('corte além do fim é no-op — clique repetido não pune ninguém', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('única'))

    const meta = await store.truncateBefore('s1', 99)
    expect(meta.lastSeq).toBe(1)
    expect(await store.since('s1', 0)).toHaveLength(1)
  })

  it('corte em zero é recusado: apagaria a sessão inteira', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await expect(store.truncateBefore('s1', 0)).rejects.toThrow(/corte em zero/)
  })

  it('rebaixa o cursor de espelho: syncedSeq nunca aponta além do que existe', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('a'))
    await store.append('s1', userMessage('b'))
    await store.append('s1', userMessage('c'))
    await store.markSynced('s1', 3)

    const meta = await store.truncateBefore('s1', 2)
    expect(meta.syncedSeq).toBe(1)
    expect(meta.lastSeq).toBe(1)
  })
})

/* --------------------------- durabilidade por verbo ----------------------- */

describe('durabilidade por kind (instrumentada)', () => {
  it('efêmeros não pagam fsync; duráveis pagam — provado pelo pragma VIVO', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })

    // Verbo durável: o commit roda com synchronous=FULL (2).
    await store.append('s1', userMessage('conteúdo que a pessoa não pode perder'))
    expect(store.inspect().synchronous).toBe(2)
    expect(store.inspect().fsyncAppends).toBe(1)
    expect(store.inspect().lazyAppends).toBe(0)

    // Os quatro efêmeros: NORMAL (1), sem fsync por commit.
    await store.append('s1', ev('delta', { payload: { text: 'peda' } }))
    expect(store.inspect().synchronous).toBe(1)
    await store.append('s1', ev('thinking', { payload: { label: 'pensando' } }))
    await store.append('s1', ev('task.progress', {
      from: { kind: 'worker', id: 'w-1' },
      payload: { taskId: 't1', workerId: 'w-1', note: 'andando' },
    }))
    await store.append('s1', ev('state', {
      from: { kind: 'system' },
      payload: { busy: true },
    }))
    expect(store.inspect().synchronous).toBe(1)
    expect(store.inspect().lazyAppends).toBe(4)
    expect(store.inspect().fsyncAppends).toBe(1)

    // A decisão de aprovação é o exemplo canônico do que NUNCA pode se perder:
    // volta a FULL antes do commit dela.
    await store.append('s1', ev('approval.decision', {
      payload: { callId: 'c1', allow: true, scope: 'once' },
    }))
    expect(store.inspect().synchronous).toBe(2)
    expect(store.inspect().fsyncAppends).toBe(2)

    // E o seq não distingue classe: efêmero e durável dividem a MESMA numeração.
    expect(await store.lastSeq('s1')).toBe(6)
  })

  it('o journal é WAL — leitura concorrente local sem bloquear o escritor', async () => {
    const { store } = newStore()
    expect(store.inspect().journalMode).toBe('wal')
  })
})

/* ------------------------------- cabeçalhos ------------------------------- */

describe('sessões', () => {
  it('createSession nasce com cursores em zero e devolve o meta gravado', async () => {
    const { store } = newStore()
    const meta = await store.createSession({
      id: 's1',
      title: 'Conversa do bot',
      botId: 'codigo',
      parentId: 's0',
      lastGoal: 'Portar o store',
    })
    expect(meta.lastSeq).toBe(0)
    expect(meta.syncedSeq).toBe(0)
    expect(meta.turns).toBe(0)
    // O trio do aninhamento viaja no cabeçalho — é o que a barra lateral
    // desenha no primeiro quadro, sem abrir log nenhum.
    expect(meta.botId).toBe('codigo')
    expect(meta.parentId).toBe('s0')
    expect(meta.lastGoal).toBe('Portar o store')
  })

  it('criar duas vezes é engano barulhento, não sobrescrita silenciosa', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await expect(store.createSession({ id: 's1' })).rejects.toThrow(SessionExistsError)
  })

  it('updateSession ignora cursores mexidos pelo mutate — quem move cursor é o log', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('oi'))

    const meta = await store.updateSession('s1', (draft) => {
      draft.title = 'Renomeada'
      draft.lastSeq = 999
      draft.syncedSeq = 999
    })
    expect(meta.title).toBe('Renomeada')
    expect(meta.lastSeq).toBe(1)
    expect(meta.syncedSeq).toBe(0)
  })

  it('markSynced só anda para frente: confirmação atrasada não regride o espelho', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('a'))
    await store.append('s1', userMessage('b'))

    await store.markSynced('s1', 2)
    await store.markSynced('s1', 1) // atrasada — não pode regredir
    expect((await store.getSession('s1')).syncedSeq).toBe(2)
  })

  it('listSessions devolve mais recente primeiro', async () => {
    const { store } = newStore()
    await store.createSession({ id: 'antiga' })
    await store.createSession({ id: 'nova' })
    await store.append('antiga', userMessage('mexeu por último'))

    const ids = (await store.listSessions()).map((meta) => meta.id)
    expect(ids).toEqual(['antiga', 'nova'])
  })

  it('deleteSession apaga log e cabeçalho, e apagar de novo é idempotente', async () => {
    const { store } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('some'))

    await store.deleteSession('s1')
    await expect(store.getSession('s1')).rejects.toThrow(SessionNotFoundError)
    await expect(store.deleteSession('s1')).resolves.toBeUndefined()
  })
})

/* ------------------------------ escritor único ---------------------------- */

describe('um escritor por store', () => {
  it('abrir o mesmo arquivo duas vezes falha na subida, não corrompe depois', async () => {
    const { path } = newStore()
    expect(() => SqliteEventStore.open(path)).toThrow(StoreInUseError)
  })

  it('fechar devolve a posse: reabrir recupera o lastSeq do disco', async () => {
    const { store, path } = newStore()
    await store.createSession({ id: 's1' })
    await store.append('s1', userMessage('um'))
    await store.append('s1', userMessage('dois'))
    await store.append('s1', userMessage('três'))
    await store.close()

    const second = reopen(path)
    expect(await second.lastSeq('s1')).toBe(3)
    expect(await second.append('s1', userMessage('quatro'))).toBe(4)
  })

  it('store fechado recusa operação em vez de escrever no vazio', async () => {
    const { store } = newStore()
    await store.close()
    await expect(store.getSession('s1')).rejects.toThrow(/store fechado/)
  })
})
