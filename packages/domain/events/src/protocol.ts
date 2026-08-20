/**
 * O CANONICAL AGENT PROTOCOL — o único vocabulário que atravessa o produto.
 *
 * Um envelope só, e não um tipo por transporte: o servidor fala HTTP, WS e o
 * que mais vier, e se cada transporte tivesse a sua mensagem, "aprovar uma
 * ferramenta" existiria N vezes e divergiria N vezes. O transporte apenas
 * serializa; quem decide o que é legítimo decide sobre ESTE envelope.
 *
 * O envelope é APPEND-ONLY e numerado por sessão (`seq`). É a numeração que
 * paga o replay: um cliente que caiu reconecta dizendo o último `seq` que viu
 * e recebe o resto — sem ela, reconectar seria recomeçar a resposta.
 *
 * A FORMA (campos, nomes JSON, conjuntos fechados) é o porte 1:1 do
 * `internal/protocol/protocol.go` do gateway Go: os logs gravados por ele são
 * o oráculo da suíte de compatibilidade, então qualquer campo que mudasse de
 * nome aqui faria a fixture "provar" um protocolo que não existe.
 */

/**
 * Versão do envelope. Sobe quando um campo muda de SIGNIFICADO — nunca quando
 * um campo novo é acrescentado (acrescentar é compatível).
 */
export const VERSION = 1

/**
 * Os verbos do protocolo. A lista é fechada de propósito: verbo novo é decisão
 * de protocolo, não detalhe de implementação — e um verbo desconhecido morre
 * na borda (`validateEnvelope`), não três camadas adiante num default mudo.
 */
export const KINDS = [
  // ciclo de vida da conexão
  'hello', 'ready', 'error', 'done',
  // conversa
  'prompt', 'route', 'delta', 'message', 'thinking',
  // ferramentas
  'tool.call', 'tool.result',
  // permissão — só decisão HUMANA destrava; ver approval.* nos payloads
  'approval.request', 'approval.decision',
  // orquestração (vocabulário clean-room, ver docs/creditos-inspiracao.md do oráculo)
  'task.dispatch', 'task.progress', 'worker.done', 'escalate', 'ask', 'reply', 'gate',
  // delegação pontual (não confundir com task.dispatch — ver payload Delegate)
  'delegate',
  // estado observável
  'state',
  // aviso de execução — quem decide NÃO apendar é o supervisor; se apendado,
  // o store o trata como durável (o quarteto efêmero é delta/thinking/task.progress/state)
  'notice',
] as const

export type Kind = (typeof KINDS)[number]

const kindSet: ReadonlySet<string> = new Set(KINDS)

/** Diz se o verbo é conhecido. */
export function isValidKind(kind: string): kind is Kind {
  return kindSet.has(kind)
}

/**
 * Quem PODE decidir versus quem apenas executa. A distinção não é decorativa:
 * só `user` aprova ferramenta, e só `supervisor` roteia.
 */
export type ActorKind =
  | 'user'
  | 'supervisor'
  | 'specialist'
  | 'worker'
  | 'tool'
  | 'system'

/** Origem ou destino de um envelope. */
export interface Actor {
  kind: ActorKind
  /** Estável dentro da sessão (id do trabalhador, nome da ferramenta…). */
  id?: string
  /**
   * O especialista sob o qual o ator agiu. Viaja no envelope, e não é deduzido
   * depois, porque deduzir dá certo até a conversa trocar de especialista no
   * meio — que é o caso normal aqui.
   */
  specialist?: string
}

/**
 * A unidade de tráfego do protocolo.
 *
 * `ts` é string, não Date, de propósito: o Go grava RFC3339 com precisão de
 * nanossegundo (`2026-08-20T10:16:19.746287Z`) e Date só guarda milissegundo —
 * converter na borda destruiria em silêncio um valor que a suíte de
 * compatibilidade compara campo a campo. O TS gera com a precisão que tem e
 * ACEITA a que vier (a regra das fixtures).
 *
 * `seq` é number: o log de uma conversa nunca chega perto de 2^53, e BigInt
 * contaminaria toda a cadeia (JSON, comparações, UI) por um caso impossível.
 */
export interface Envelope {
  v: number
  id: string
  ts: string
  seq: number
  session: string
  /**
   * Agrupa tudo o que nasceu de um mesmo prompt: rota, deltas, chamadas de
   * ferramenta e o done. A UI colapsa o turno inteiro por este id.
   */
  turn?: string
  kind: Kind
  from: Actor
  /** Ausente é o caso comum (broadcast para a UI) — por isso opcional. */
  to?: Actor
  /**
   * `unknown`, não um union fechado: o store transporta e numera, não
   * interpreta. Quem precisa do conteúdo decodifica com os tipos de
   * payloads.ts — erro de payload é erro de quem consome, na borda dele.
   */
  payload?: unknown
}

/** Marca rejeição na borda: o envelope não tem como ser processado adiante. */
export class InvalidEnvelopeError extends Error {
  override name = 'InvalidEnvelopeError'
}

/**
 * Recusa o que não tem como ser processado adiante e devolve o valor já
 * tipado. As quatro verificações são as MESMAS do `Validate()` do oráculo
 * (versão, sessão, verbo, remetente) — nem mais nem menos: id/ts/seq não são
 * validados lá e um porte "mais rígido" recusaria envelopes que o Go aceitou
 * e gravou, quebrando o replay das fixtures.
 */
export function validateEnvelope(value: unknown): Envelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidEnvelopeError('envelope inválido: não é um objeto')
  }
  const candidate = value as Record<string, unknown>
  if (candidate['v'] !== VERSION) {
    throw new InvalidEnvelopeError(
      `envelope inválido: versão ${String(candidate['v'])} (esperada ${VERSION})`,
    )
  }
  if (typeof candidate['session'] !== 'string' || candidate['session'] === '') {
    throw new InvalidEnvelopeError('envelope inválido: sessão vazia')
  }
  const kind = candidate['kind']
  if (typeof kind !== 'string' || !isValidKind(kind)) {
    throw new InvalidEnvelopeError(`envelope inválido: verbo desconhecido ${JSON.stringify(kind)}`)
  }
  const from = candidate['from']
  if (
    from === null || typeof from !== 'object' ||
    typeof (from as Record<string, unknown>)['kind'] !== 'string' ||
    (from as Record<string, unknown>)['kind'] === ''
  ) {
    throw new InvalidEnvelopeError('envelope inválido: remetente sem tipo')
  }
  return value as Envelope
}
