/**
 * O StorageDriver concreto sobre `node:sqlite` (builtin do Node 24 — zero
 * dependência para TI, decisão R2/D1 do m0-inventario).
 *
 * O oráculo Go guardava o log em JSONL porque SQLite não está na stdlib do Go.
 * Aqui está na do Node, e o banco dá de graça o que lá era feito à mão — mas as
 * INVARIANTES são as mesmas, e cada uma tem a sua tradução:
 *
 * - "mutex por sessão + O_APPEND"  → KeyedMutex por sessão + `BEGIN IMMEDIATE`
 *   com o seq derivado de MAX(events.seq) DENTRO da transação. O log continua
 *   sendo a fonte da numeração ("o log manda"), agora por construção do SQL.
 * - "Sync antes de confirmar"      → `PRAGMA synchronous` por verbo: FULL
 *   fsynca o WAL a cada commit (verbos duráveis), NORMAL não paga fsync por
 *   commit (delta/thinking/progress/state — o `done` seguinte consolida).
 * - "temp + fsync + rename" do truncate → UMA transação. A dança do rename
 *   existia porque meio-arquivo-escrito era um estado possível; em SQLite
 *   meio-corte NÃO é um estado possível: ou a transação commitou (e o corte
 *   sobrevive à queda, synchronous=FULL), ou não commitou (e o log continua
 *   inteiro). Não há descritor atravessando rename porque não há rename — o
 *   teste de reabertura prova a durabilidade real no Windows, sem mock.
 * - "meta.json debounced é CACHE do log" → a linha de `sessions` é atualizada
 *   NA MESMA transação do evento; o debounce de 200ms morre aqui porque o
 *   motivo dele (um fsync+rename de arquivo separado por linha) não existe
 *   mais. O risco que o debounce aceitava (cabeçalho até 200ms atrás numa
 *   queda) virou outro, menor: cabeçalho e evento de um verbo EFÊMERO podem
 *   sumir JUNTOS numa queda — que é o mesmo contrato (efêmero não promete).
 * - ".lock por PID" → registro em memória de caminhos abertos NESTE processo
 *   (dois drivers no mesmo arquivo é engano de montagem e falha na subida).
 *   Autoridade ENTRE processos deliberadamente não mora aqui: PID-check tem
 *   incidente documentado (RS6) e a posse multi-processo vira lease com época
 *   na E7 — reimplementar o .lock seria portar a cicatriz sem a ferida.
 * - "safeID contra `..` no caminho" → morreu: o id é chave TEXT em statement
 *   preparado; não há caminho de arquivo para escapar nem SQL montado por
 *   concatenação.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { resolve as resolvePath } from 'node:path'

import { VERSION, type Envelope } from './protocol.js'
import { KeyedMutex } from './mutex.js'
import {
  MAX_EVENT_BATCH,
  durableKind,
  SessionExistsError,
  SessionNotFoundError,
  StoreInUseError,
  type EnvelopeInput,
  type SessionMeta,
  type SessionSeed,
  type StorageDriver,
} from './storage.js'

/**
 * Escritores vivos deste processo, por caminho resolvido. `:memory:` fica de
 * fora: cada abertura é um banco novo, não há arquivo para disputar.
 */
const openWriters = new Map<string, SqliteEventStore>()

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  specialist TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  cwd        TEXT NOT NULL DEFAULT '',
  bot_id     TEXT NOT NULL DEFAULT '',
  parent_id  TEXT NOT NULL DEFAULT '',
  last_goal  TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  synced_seq INTEGER NOT NULL DEFAULT 0,
  turns      INTEGER NOT NULL DEFAULT 0,
  archived   INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  session  TEXT    NOT NULL,
  seq      INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  envelope TEXT    NOT NULL,
  PRIMARY KEY (session, seq)
) STRICT, WITHOUT ROWID;
`

/** Instrumentação exigida pelo aceite: a durabilidade por verbo tem de ser PROVÁVEL. */
export interface StoreInspection {
  journalMode: string
  /** O valor vivo de PRAGMA synchronous (1 = NORMAL, 2 = FULL) — lido do banco, não do nosso contador. */
  synchronous: number
  fsyncAppends: number
  lazyAppends: number
}

export class SqliteEventStore implements StorageDriver {
  readonly #db: DatabaseSync
  /** null para `:memory:` (sem arquivo, sem registro). */
  readonly #registryKey: string | null
  readonly #locks = new KeyedMutex()
  #open = true

  #fsyncAppends = 0
  #lazyAppends = 0

  readonly #stSelectSession: StatementSync
  readonly #stSelectAllSessions: StatementSync
  readonly #stInsertSession: StatementSync
  readonly #stUpdateSessionMeta: StatementSync
  readonly #stUpdateOnAppend: StatementSync
  readonly #stMarkSynced: StatementSync
  readonly #stDeleteSession: StatementSync
  readonly #stDeleteSessionEvents: StatementSync
  readonly #stMaxSeq: StatementSync
  readonly #stInsertEvent: StatementSync
  readonly #stSince: StatementSync
  readonly #stDeleteFromSeq: StatementSync
  readonly #stCountDone: StatementSync

  private constructor(location: string, registryKey: string | null) {
    this.#registryKey = registryKey
    this.#db = new DatabaseSync(location)
    // WAL: leitura concorrente local sem bloquear o escritor (RS3). O modo é
    // persistente no arquivo; reexecutar na reabertura é idempotente.
    this.#db.exec('PRAGMA journal_mode = WAL')
    // Um leitor externo no meio de um commit espera em vez de estourar SQLITE_BUSY.
    this.#db.exec('PRAGMA busy_timeout = 5000')
    // Postura de abertura: durável até o primeiro verbo efêmero relaxar.
    this.#db.exec('PRAGMA synchronous = FULL')
    this.#db.exec(SCHEMA)

    this.#stSelectSession = this.#db.prepare('SELECT * FROM sessions WHERE id = ?')
    this.#stSelectAllSessions = this.#db.prepare('SELECT * FROM sessions')
    this.#stInsertSession = this.#db.prepare(
      `INSERT INTO sessions
         (id, title, specialist, model, cwd, bot_id, parent_id, last_goal, project_id,
          created_at, updated_at, last_seq, synced_seq, turns, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
    )
    this.#stUpdateSessionMeta = this.#db.prepare(
      `UPDATE sessions SET
         title = ?, specialist = ?, model = ?, cwd = ?, bot_id = ?, parent_id = ?,
         last_goal = ?, project_id = ?, created_at = ?, updated_at = ?, archived = ?
       WHERE id = ?`,
    )
    // O specialist do cabeçalho é "quem atendeu por último": só muda quando o
    // envelope traz um — o CASE evita apagar o anterior com string vazia.
    this.#stUpdateOnAppend = this.#db.prepare(
      `UPDATE sessions SET
         last_seq = ?, updated_at = ?, turns = turns + ?,
         specialist = CASE WHEN ? <> '' THEN ? ELSE specialist END
       WHERE id = ?`,
    )
    this.#stMarkSynced = this.#db.prepare(
      'UPDATE sessions SET synced_seq = ?, updated_at = ? WHERE id = ?',
    )
    this.#stDeleteSession = this.#db.prepare('DELETE FROM sessions WHERE id = ?')
    this.#stDeleteSessionEvents = this.#db.prepare('DELETE FROM events WHERE session = ?')
    this.#stMaxSeq = this.#db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS last FROM events WHERE session = ?',
    )
    this.#stInsertEvent = this.#db.prepare(
      'INSERT INTO events (session, seq, kind, envelope) VALUES (?, ?, ?, ?)',
    )
    this.#stSince = this.#db.prepare(
      'SELECT envelope FROM events WHERE session = ? AND seq > ? ORDER BY seq LIMIT ?',
    )
    this.#stDeleteFromSeq = this.#db.prepare('DELETE FROM events WHERE session = ? AND seq >= ?')
    this.#stCountDone = this.#db.prepare(
      "SELECT COUNT(*) AS turns FROM events WHERE session = ? AND kind = 'done'",
    )
  }

  /**
   * Abre (ou cria) o store. Segundo escritor no MESMO caminho falha na subida:
   * `seq` é atribuído sob o mutex desta instância, e dois donos numerando a
   * mesma sessão é a corrupção silenciosa que a regra "um escritor por store"
   * existe para impedir.
   */
  static open(location: string): SqliteEventStore {
    if (location === '') {
      throw new Error('caminho do store vazio')
    }
    const registryKey = location === ':memory:' ? null : resolvePath(location)
    if (registryKey !== null && openWriters.has(registryKey)) {
      throw new StoreInUseError(location)
    }
    const store = new SqliteEventStore(location, registryKey)
    if (registryKey !== null) {
      openWriters.set(registryKey, store)
    }
    return store
  }

  /* ------------------------------- sessões ------------------------------- */

  async createSession(seed: SessionSeed): Promise<SessionMeta> {
    this.#assertOpen()
    if (seed.id === '') {
      throw new Error('sessão sem id')
    }
    return this.#locks.runExclusive(seed.id, () => {
      const now = new Date().toISOString()
      // Criar é gesto raro e durável — a pessoa espera reencontrar a conversa
      // se o app cair em seguida.
      this.#setSynchronous(true)
      try {
        this.#stInsertSession.run(
          seed.id,
          seed.title ?? '',
          seed.specialist ?? '',
          seed.model ?? '',
          seed.cwd ?? '',
          seed.botId ?? '',
          seed.parentId ?? '',
          seed.lastGoal ?? '',
          seed.projectId ?? '',
          seed.createdAt ?? now,
          now,
        )
      } catch (error) {
        // No oráculo, recriar sobrescrevia o meta.json e o log "mandava" de
        // volta — um acidente sobrevivível. Aqui a PK torna o engano barulhento,
        // que é melhor: ninguém cria a mesma sessão duas vezes de propósito.
        if (isUniqueViolation(error)) {
          throw new SessionExistsError(seed.id)
        }
        throw error
      }
      return this.#getMeta(seed.id)
    })
  }

  async getSession(id: string): Promise<SessionMeta> {
    this.#assertOpen()
    return this.#getMeta(id)
  }

  async updateSession(id: string, mutate: (meta: SessionMeta) => void): Promise<SessionMeta> {
    this.#assertOpen()
    return this.#locks.runExclusive(id, () => {
      const current = this.#getMeta(id)
      const draft: SessionMeta = { ...current }
      mutate(draft)
      // Cursores são do log, id é identidade: o mutate não manda neles.
      draft.id = id
      draft.lastSeq = current.lastSeq
      draft.syncedSeq = current.syncedSeq
      draft.updatedAt = new Date().toISOString()

      // Edição do usuário (renomear, arquivar) vai durável na hora: é rara e é
      // o tipo de mudança que a pessoa espera ver de volta depois de uma queda.
      this.#setSynchronous(true)
      this.#stUpdateSessionMeta.run(
        draft.title,
        draft.specialist ?? '',
        draft.model ?? '',
        draft.cwd ?? '',
        draft.botId ?? '',
        draft.parentId ?? '',
        draft.lastGoal ?? '',
        draft.projectId ?? '',
        draft.createdAt,
        draft.updatedAt,
        draft.archived === true ? 1 : 0,
        id,
      )
      return this.#getMeta(id)
    })
  }

  async markSynced(id: string, seq: number): Promise<void> {
    this.#assertOpen()
    await this.#locks.runExclusive(id, () => {
      const current = this.#getMeta(id)
      // MAX: uma confirmação atrasada chegando depois de outra mais nova não
      // pode regredir o cursor — o espelho reenviaria o que já foi aceito.
      if (seq <= current.syncedSeq) {
        return
      }
      this.#setSynchronous(true)
      this.#stMarkSynced.run(seq, new Date().toISOString(), id)
    })
  }

  async listSessions(): Promise<SessionMeta[]> {
    this.#assertOpen()
    const rows = this.#stSelectAllSessions.all() as Record<string, unknown>[]
    const metas = rows.map((row) => rowToMeta(row))
    // A ordenação fica no JS, não num ORDER BY sobre o texto: timestamps do
    // oráculo variam de largura (nanossegundos truncados) e a comparação
    // lexicográfica erraria exatamente nos empates de prefixo.
    metas.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return metas
  }

  async deleteSession(id: string): Promise<void> {
    this.#assertOpen()
    await this.#locks.runExclusive(id, () => {
      this.#setSynchronous(true)
      this.#transaction(() => {
        this.#stDeleteSessionEvents.run(id)
        this.#stDeleteSession.run(id)
      })
    })
  }

  /* --------------------------------- log --------------------------------- */

  async append(sessionId: string, input: EnvelopeInput): Promise<number> {
    this.#assertOpen()
    // TODO o caminho ler-seq→gravar roda dentro do mutex da sessão: é a
    // tradução do sync.Mutex do oráculo, e é o que mantém a seção crítica
    // atômica quando qualquer passo dela ganhar um await (RS5).
    return this.#locks.runExclusive(sessionId, () => {
      if (this.#stSelectSession.get(sessionId) === undefined) {
        throw new SessionNotFoundError(sessionId)
      }

      const durable = durableKind(input.kind)
      // O pragma vale para o COMMIT da transação abaixo: FULL fsynca o WAL,
      // NORMAL não. É aqui que a durabilidade por verbo vira realidade — e o
      // inspect() deixa o teste ler o valor vivo do banco para provar.
      this.#setSynchronous(durable)
      if (durable) {
        this.#fsyncAppends++
      } else {
        this.#lazyAppends++
      }

      const now = new Date().toISOString()
      return this.#transaction(() => {
        // O seq nasce de MAX(events.seq) DENTRO da transação: o log é a fonte
        // da numeração por construção — um cabeçalho atrasado (banco importado
        // à mão, por exemplo) nunca faz dois envelopes nascerem com o mesmo
        // número.
        const last = asNumber((this.#stMaxSeq.get(sessionId) as Record<string, unknown>)['last'])
        const seq = last + 1

        // A ordem dos campos espelha a do oráculo — cosmética (a comparação de
        // compat é por valor), mas deixa um diff humano contra um log Go legível.
        const envelope: Envelope = {
          v: VERSION,
          id: input.id,
          ts: input.ts !== undefined && input.ts !== '' ? input.ts : now,
          seq,
          session: sessionId,
          ...(input.turn !== undefined ? { turn: input.turn } : {}),
          kind: input.kind,
          from: input.from,
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.payload !== undefined ? { payload: input.payload } : {}),
        }

        this.#stInsertEvent.run(sessionId, seq, envelope.kind, JSON.stringify(envelope))
        const specialist = input.from.specialist ?? ''
        this.#stUpdateOnAppend.run(
          seq,
          now,
          input.kind === 'done' ? 1 : 0,
          specialist,
          specialist,
          sessionId,
        )
        return seq
      })
    })
  }

  async since(sessionId: string, fromSeq: number, limit?: number): Promise<Envelope[]> {
    this.#assertOpen()
    let batch = limit ?? MAX_EVENT_BATCH
    if (batch <= 0 || batch > MAX_EVENT_BATCH) {
      batch = MAX_EVENT_BATCH
    }
    // Leitura NÃO passa pelo mutex de propósito: o replay da reconexão pagina
    // no meio de uma resposta que ainda está chegando, e cada SELECT enxerga
    // um snapshot consistente do WAL — serializar leitores atrás do escritor
    // faria a reconexão esperar o streaming.
    if (this.#stSelectSession.get(sessionId) === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    const rows = this.#stSince.all(sessionId, fromSeq, batch) as Record<string, unknown>[]
    return rows.map((row) => JSON.parse(asString(row['envelope'])) as Envelope)
  }

  async lastSeq(sessionId: string): Promise<number> {
    this.#assertOpen()
    if (this.#stSelectSession.get(sessionId) === undefined) {
      throw new SessionNotFoundError(sessionId)
    }
    // A mesma fonte do append: MAX do log, não o cache do cabeçalho — as duas
    // verdades andam juntas na mesma transação, mas quando alguém precisa de UMA,
    // que seja a que numera.
    return asNumber((this.#stMaxSeq.get(sessionId) as Record<string, unknown>)['last'])
  }

  async truncateBefore(sessionId: string, beforeSeq: number): Promise<SessionMeta> {
    this.#assertOpen()
    if (beforeSeq === 0) {
      throw new Error(
        'corte em zero apagaria a sessão inteira — informe o seq do primeiro envelope a remover',
      )
    }
    // O mutex segura o corte inteiro: um append no meio nasceria numerado
    // contra um fim que está prestes a mudar.
    return this.#locks.runExclusive(sessionId, () => {
      const current = this.#getMeta(sessionId)
      const last = asNumber((this.#stMaxSeq.get(sessionId) as Record<string, unknown>)['last'])
      // Além do fim é no-op: tratar como erro puniria o clique repetido de
      // quem já conseguiu o que queria.
      if (beforeSeq > last) {
        return current
      }

      // O corte prometido ao cliente precisa existir depois de uma queda —
      // durável SEMPRE, mesmo que o último verbo gravado fosse efêmero.
      this.#setSynchronous(true)
      this.#transaction(() => {
        this.#stDeleteFromSeq.run(sessionId, beforeSeq)
        // O que sobrou responde pelos números: último seq mantido e turnos
        // recontados do próprio log — o cabeçalho é reflexo, nunca fonte.
        const kept = asNumber((this.#stMaxSeq.get(sessionId) as Record<string, unknown>)['last'])
        const turns = asNumber(
          (this.#stCountDone.get(sessionId) as Record<string, unknown>)['turns'],
        )
        // O espelho nunca aponta além do que existe: um cursor à frente do fim
        // faria o sync pular exatamente o que for gravado a seguir.
        const synced = Math.min(current.syncedSeq, kept)
        this.#db
          .prepare(
            'UPDATE sessions SET last_seq = ?, turns = ?, synced_seq = ?, updated_at = ? WHERE id = ?',
          )
          .run(kept, turns, synced, new Date().toISOString(), sessionId)
      })
      return this.#getMeta(sessionId)
    })
  }

  async close(): Promise<void> {
    if (!this.#open) {
      return
    }
    this.#open = false
    if (this.#registryKey !== null && openWriters.get(this.#registryKey) === this) {
      openWriters.delete(this.#registryKey)
    }
    this.#db.close()
  }

  /**
   * Instrumentação para o aceite de durabilidade — não é API de produto.
   * `synchronous` é lido VIVO do banco: prova que o driver realmente trocou o
   * modo, e não só incrementou o próprio contador.
   */
  inspect(): StoreInspection {
    this.#assertOpen()
    const journal = this.#db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
    const sync = this.#db.prepare('PRAGMA synchronous').get() as Record<string, unknown>
    return {
      journalMode: asString(journal['journal_mode']),
      synchronous: asNumber(sync['synchronous']),
      fsyncAppends: this.#fsyncAppends,
      lazyAppends: this.#lazyAppends,
    }
  }

  /* -------------------------------- interno ------------------------------- */

  #assertOpen(): void {
    if (!this.#open) {
      throw new Error('store fechado')
    }
  }

  #setSynchronous(durable: boolean): void {
    this.#db.exec(`PRAGMA synchronous = ${durable ? 'FULL' : 'NORMAL'}`)
  }

  /**
   * BEGIN IMMEDIATE, não DEFERRED: a intenção de escrita é declarada na
   * entrada, então um segundo escritor externo espera aqui (busy_timeout) em
   * vez de falhar no meio com o trabalho já feito.
   */
  #transaction<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.#db.exec('COMMIT')
      return result
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #getMeta(id: string): SessionMeta {
    const row = this.#stSelectSession.get(id) as Record<string, unknown> | undefined
    if (row === undefined) {
      throw new SessionNotFoundError(id)
    }
    return rowToMeta(row)
  }
}

/* --------------------------------- linhas -------------------------------- */

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'bigint') {
    return Number(value)
  }
  return 0
}

/**
 * Linha → SessionMeta, com os vazios OMITIDOS como o `omitempty` do oráculo:
 * quem compara um meta nosso com um meta.json gravado pelo Go precisa ver a
 * mesma grafia para o mesmo estado.
 */
function rowToMeta(row: Record<string, unknown>): SessionMeta {
  const meta: SessionMeta = {
    id: asString(row['id']),
    title: asString(row['title']),
    createdAt: asString(row['created_at']),
    updatedAt: asString(row['updated_at']),
    lastSeq: asNumber(row['last_seq']),
    syncedSeq: asNumber(row['synced_seq']),
    turns: asNumber(row['turns']),
  }
  const specialist = asString(row['specialist'])
  if (specialist !== '') meta.specialist = specialist
  const model = asString(row['model'])
  if (model !== '') meta.model = model
  const cwd = asString(row['cwd'])
  if (cwd !== '') meta.cwd = cwd
  const botId = asString(row['bot_id'])
  if (botId !== '') meta.botId = botId
  const parentId = asString(row['parent_id'])
  if (parentId !== '') meta.parentId = parentId
  const lastGoal = asString(row['last_goal'])
  if (lastGoal !== '') meta.lastGoal = lastGoal
  const projectId = asString(row['project_id'])
  if (projectId !== '') meta.projectId = projectId
  if (asNumber(row['archived']) === 1) meta.archived = true
  return meta
}

/** A violação de PK do SQLite chega como erro com código/mensagem próprios. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as Error & { errcode?: number }).errcode
  // 1555 = SQLITE_CONSTRAINT_PRIMARYKEY, 2067 = SQLITE_CONSTRAINT_UNIQUE.
  return code === 1555 || code === 2067 || error.message.includes('UNIQUE constraint failed')
}
