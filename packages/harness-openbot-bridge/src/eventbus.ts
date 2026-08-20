/**
 * O barramento por sessão: entrega o mesmo envelope a todo mundo que está
 * olhando a conversa (a janela, um watch no terminal, a ponte de ferramentas).
 * Porte da FORMA do internal/eventbus do oráculo Go.
 *
 * A ordem das duas metades do publish importa e não é intercambiável: PRIMEIRO
 * grava no log durável (que atribui o `seq`), DEPOIS distribui. Distribuir
 * antes de gravar entrega ao cliente um evento que pode não existir depois de
 * uma queda — e o cliente que reconecta pedindo replay a partir dele nunca
 * recebe resposta.
 *
 * Assinante lento é DESCONECTADO, não esperado. Segurar a produção porque uma
 * janela minimizada parou de ler faria o modelo travar no meio da resposta por
 * causa de quem não está olhando. Quem cai recebe o sinal de atraso (o Lagged
 * do Go) e se recupera pelo replay — é para isso que o log é numerado.
 */

import { KeyedMutex, type Envelope, type EnvelopeInput, type StorageDriver } from '@aibot2/domain-events'

/**
 * Folga de cada assinante. Grande o bastante para uma rajada de deltas de
 * streaming, pequena o bastante para a memória não crescer sem limite quando
 * um cliente trava. Mesmo valor do oráculo.
 */
export const FOLGA_PADRAO = 256

/** Um item entregue por `proximo()`: um envelope, o sinal de atraso, ou o fim da assinatura. */
export type ItemDaAssinatura =
  | { tipo: 'evento'; envelope: Envelope }
  | { tipo: 'atrasado' }
  | { tipo: 'fechada' }

/**
 * A assinatura de uma sessão. PULL-based de propósito: quem consome (o laço
 * escritor do stream) dita o ritmo, e é a diferença entre o ritmo de produção
 * e o de consumo que enche a fila e dispara o `atrasado` — em push, a pressão
 * sumiria dentro de promises pendentes e a memória cresceria do mesmo jeito,
 * só que invisível.
 */
export class Assinatura {
  readonly #fila: Envelope[] = []
  readonly #folga: number
  #atrasada = false
  #fechada = false
  #acordar: (() => void) | undefined
  /** Preenchido pelo bus para a remoção do tópico no close. */
  #remover: (() => void) | undefined

  constructor(folga: number, remover?: () => void) {
    this.#folga = folga
    this.#remover = remover
  }

  /** @internal — só o bus empurra. Devolve false quando o assinante caiu por atraso. */
  push(envelope: Envelope): boolean {
    if (this.#fechada || this.#atrasada) return false
    if (this.#fila.length >= this.#folga) {
      // A fila encheu: o assinante ficou para trás. Não se descarta "só este"
      // envelope — um buraco no meio do stream é pior que a reconexão, porque
      // o cliente não tem como saber que ele existe. Cai inteiro e replay.
      this.#atrasada = true
      this.#fila.length = 0
      this.#despertar()
      return false
    }
    this.#fila.push(envelope)
    this.#despertar()
    return true
  }

  /**
   * Espera o próximo item. `atrasado` e `fechada` são terminais — depois deles
   * a assinatura não entrega mais nada.
   */
  async proximo(): Promise<ItemDaAssinatura> {
    for (;;) {
      const envelope = this.#fila.shift()
      if (envelope !== undefined) return { tipo: 'evento', envelope }
      if (this.#atrasada) return { tipo: 'atrasado' }
      if (this.#fechada) return { tipo: 'fechada' }
      await new Promise<void>((resolve) => {
        this.#acordar = resolve
      })
    }
  }

  /** Cancela a assinatura. Idempotente — troca de sessão e fim de conexão chegam juntos. */
  close(): void {
    if (this.#fechada) return
    this.#fechada = true
    this.#remover?.()
    this.#remover = undefined
    this.#despertar()
  }

  get fechada(): boolean {
    return this.#fechada
  }

  #despertar(): void {
    const acordar = this.#acordar
    this.#acordar = undefined
    acordar?.()
  }
}

/** O distribuidor. Um por processo, sobre o log durável. */
export class SessionBus {
  readonly #store: StorageDriver
  readonly #folga: number
  /** sessão → assinantes vivos. */
  readonly #topicos = new Map<string, Set<Assinatura>>()
  /**
   * Publicações serializadas POR SESSÃO. No Go a dupla Append+fanout de duas
   * goroutines pode inverter a ordem no barramento; aqui o mutex fecha essa
   * janela de graça — o filtro `seq <= delivered` do stream descartaria o
   * envelope que chegasse "do passado" e o cliente ficaria com um buraco.
   */
  readonly #porSessao = new KeyedMutex()

  constructor(store: StorageDriver, folga: number = FOLGA_PADRAO) {
    if (folga < 1) throw new Error('folga do barramento precisa ser >= 1')
    this.#store = store
    this.#folga = folga
  }

  /** Abre uma assinatura da sessão. Fechar remove do tópico na hora. */
  subscribe(sessionId: string): Assinatura {
    let topico = this.#topicos.get(sessionId)
    if (topico === undefined) {
      topico = new Set()
      this.#topicos.set(sessionId, topico)
    }
    const donos = topico
    const assinatura = new Assinatura(this.#folga, () => {
      donos.delete(assinatura)
      if (donos.size === 0) this.#topicos.delete(sessionId)
    })
    donos.add(assinatura)
    return assinatura
  }

  /**
   * Grava e distribui. Devolve o `seq` atribuído.
   *
   * O envelope distribuído é RELIDO do log, não reconstruído aqui: o store é o
   * único que sabe o `ts` e o `seq` finais, e o que o assinante vê ao vivo tem
   * de ser byte-idêntico ao que o replay entregaria amanhã.
   */
  async publish(sessionId: string, input: EnvelopeInput): Promise<number> {
    return this.#porSessao.runExclusive(sessionId, async () => {
      const seq = await this.#store.append(sessionId, input)
      const gravados = await this.#store.since(sessionId, seq - 1, 1)
      const envelope = gravados[0]
      if (envelope !== undefined) this.#fanout(sessionId, envelope)
      return seq
    })
  }

  /**
   * Distribui SEM gravar. Existe para um caso só: sinal que perde o sentido
   * depois de entregue e que não pertence ao histórico (pulso de "digitando",
   * barra de progresso). Gravá-los encheria o log de ruído que o replay
   * reencenaria — ver a barra de progresso de ontem reaparecer é defeito.
   */
  publishEphemeral(sessionId: string, envelope: Envelope): void {
    this.#fanout(sessionId, envelope)
  }

  /** Quantos assinantes a sessão tem — o supervisor decide se vale continuar um turno que ninguém vê. */
  listeners(sessionId: string): number {
    return this.#topicos.get(sessionId)?.size ?? 0
  }

  #fanout(sessionId: string, envelope: Envelope): void {
    const topico = this.#topicos.get(sessionId)
    if (topico === undefined) return
    // Cópia da lista antes de empurrar: o push que derruba um atrasado remove
    // do Set via close(), e mutar o Set durante o for é pedir item pulado.
    for (const assinatura of [...topico]) {
      if (!assinatura.push(envelope)) {
        // Caiu por atraso: remove do tópico já — o próximo fanout não deve
        // nem tentar. O sinal `atrasado` fica retido na assinatura para o
        // consumidor ler e fechar com 1013.
        topico.delete(assinatura)
      }
    }
    if (topico.size === 0) this.#topicos.delete(sessionId)
  }
}
