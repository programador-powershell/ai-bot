/**
 * O seam de armazenamento do event log (D1 do m0-inventario).
 *
 * A interface existe para que o Postgres possa voltar num deploy multiusuário
 * sem reescrever nenhum consumidor: quem usa o log depende DESTE contrato,
 * nunca do driver concreto (a regra de dependência do harness). Os métodos são
 * assíncronos mesmo quando o driver de hoje resolve tudo síncrono — o contrato
 * é dos drivers possíveis, não do mais barato.
 *
 * As invariantes que TODO driver deve honrar (a suíte do sqlite as fixa):
 * - `seq` contínuo 1..N por sessão, sem furo nem repetição, mesmo sob appends
 *   concorrentes — a numeração é o que paga o replay;
 * - durabilidade POR VERBO (ver `durableKind`);
 * - truncate durável e atômico: ou cortou, ou não cortou;
 * - UM ESCRITOR por store: workers reportam, não gravam (o sequenciador mora
 *   no orquestrador — RS3).
 */

import type { Envelope, Kind, Actor } from './protocol.js'

/**
 * Teto de envelopes devolvidos por leitura. Igual ao teto do cliente de
 * propósito: quando os dois divergem, o lado menor pagina para sempre pedindo
 * o mesmo pedaço e o replay nunca termina.
 */
export const MAX_EVENT_BATCH = 500

/**
 * Quais verbos merecem ida ao disco NA HORA.
 *
 * fsync em cada delta de streaming seria uma ida ao disco por token — o app
 * ficaria mais lento que o modelo, para durabilizar texto que o `done`
 * seguinte consolida. O default é durável (verbo novo paga fsync até alguém
 * decidir o contrário): errar para o lado caro perde performance; errar para o
 * lado barato perde a decisão de aprovação de alguém.
 */
export function durableKind(kind: Kind): boolean {
  switch (kind) {
    case 'delta':
    case 'thinking':
    case 'task.progress':
    case 'state':
      return false
    default:
      return true
  }
}

/**
 * O cabeçalho da sessão — o que a barra lateral precisa para listar sem abrir
 * o log de ninguém. Campos opcionais espelham os `omitempty` do meta.json do
 * oráculo: ausente e vazio são a mesma coisa.
 */
export interface SessionMeta {
  id: string
  title: string
  /** Quem atendeu por último — muda a cada turno; a lista mostra o ícone dele. */
  specialist?: string
  model?: string
  cwd?: string
  /**
   * O DONO da conversa (diferente de `specialist`): conversa de bot tem dono
   * fixo, e é isso que permite abrir o Código e continuar falando com o Código.
   */
  botId?: string
  /** A conversa que deu origem a esta — o aninhamento da barra lateral. */
  parentId?: string
  /**
   * O ÚLTIMO pedido feito ao bot desta conversa — o subtítulo da linha. Mora
   * no meta, e não numa leitura do log no handshake: abrir cinquenta logs para
   * montar o `ready` pesaria o primeiro quadro em nome de um subtítulo.
   */
  lastGoal?: string
  projectId?: string
  createdAt: string
  updatedAt: string
  lastSeq: number
  /** Cursor já espelhado num servidor. Só anda para frente. */
  syncedSeq: number
  turns: number
  archived?: boolean
}

/** O que o chamador fornece ao criar uma sessão — cursores são do store. */
export interface SessionSeed {
  id: string
  title?: string
  specialist?: string
  model?: string
  cwd?: string
  botId?: string
  parentId?: string
  lastGoal?: string
  projectId?: string
  createdAt?: string
}

/**
 * O que o chamador fornece ao gravar. `seq`, `session` e `v` são IGNORADOS de
 * propósito (o store numera, a sessão é o argumento, a versão é do protocolo)
 * — aceitá-los do chamador seria deixar dois donos para a mesma verdade. É o
 * mesmo contrato do Append do oráculo, que sobrescreve os três sem perguntar.
 */
export interface EnvelopeInput {
  id: string
  /** Vazio/ausente = agora. Preservado quando vem (o importador de fixture depende disso). */
  ts?: string
  turn?: string
  kind: Kind
  from: Actor
  to?: Actor
  payload?: unknown
  // Presentes só para que um Envelope completo (fixture) seja aceito sem
  // cirurgia; o store não os lê.
  v?: number
  seq?: number
  session?: string
}

/** A sessão não existe no store. */
export class SessionNotFoundError extends Error {
  override name = 'SessionNotFoundError'
  constructor(id: string) {
    super(`sessão não encontrada: ${id}`)
  }
}

/** Criar por cima de sessão existente é engano de chamador, e engano faz barulho. */
export class SessionExistsError extends Error {
  override name = 'SessionExistsError'
  constructor(id: string) {
    super(`sessão já existe: ${id}`)
  }
}

/** Outro dono já escreve neste store — a regra é UM escritor (RS3). */
export class StoreInUseError extends Error {
  override name = 'StoreInUseError'
  constructor(location: string) {
    super(`store já está em uso por outro escritor: ${location}`)
  }
}

/** O contrato do event log. */
export interface StorageDriver {
  /** Grava o cabeçalho de uma sessão nova (cursores nascem em zero). */
  createSession(seed: SessionSeed): Promise<SessionMeta>
  getSession(id: string): Promise<SessionMeta>
  /**
   * Edita campos do cabeçalho. `lastSeq`/`syncedSeq` mudados pelo `mutate` são
   * descartados: quem move cursor é o próprio log.
   */
  updateSession(id: string, mutate: (meta: SessionMeta) => void): Promise<SessionMeta>
  /** Move o cursor de espelho — só para FRENTE (confirmação atrasada não regride). */
  markSynced(id: string, seq: number): Promise<void>
  /** Cabeçalhos, mais recente primeiro. */
  listSessions(): Promise<SessionMeta[]>
  /** Apaga a sessão inteira. Sessão ausente não é erro (apagar o já apagado é idempotente). */
  deleteSession(id: string): Promise<void>

  /** Numera e grava. Devolve o `seq` atribuído. */
  append(sessionId: string, input: EnvelopeInput): Promise<number>
  /** Envelopes com seq > fromSeq, até `limit` (teto MAX_EVENT_BATCH). É o replay. */
  since(sessionId: string, fromSeq: number, limit?: number): Promise<Envelope[]>
  /** O último número gravado. */
  lastSeq(sessionId: string): Promise<number>
  /**
   * Remove todo envelope com seq >= beforeSeq, durável. Corte além do fim é
   * no-op; a numeração 1..N permanece verdadeira (o append seguinte continua
   * do novo fim).
   */
  truncateBefore(sessionId: string, beforeSeq: number): Promise<SessionMeta>

  close(): Promise<void>
}
