/**
 * Mutex assíncrono por chave — o substituto honesto do `sync.Mutex` por sessão
 * do oráculo Go.
 *
 * Por que ele existe (RS5): o event loop do Node NÃO protege nada entre
 * awaits. "Ler o último seq, await, gravar seq+1" é exatamente a corrida que o
 * comentário do Append Go descreve — dois eventos nascendo com o mesmo número
 * e o replay entregando um pelo outro. Não importa que o driver de hoje
 * resolva os passos síncronos: o contrato do StorageDriver é assíncrono, e o
 * primeiro await que alguém acrescentar no meio do caminho crítico reabre a
 * corrida EM SILÊNCIO. O mutex torna a seção crítica atômica por construção,
 * não por acidente da implementação atual.
 *
 * Por chave (= por sessão), não global: sessões diferentes não disputam nada —
 * serializá-las juntas faria o streaming de uma conversa pagar o fsync da
 * outra.
 */

/** Trabalho a executar com exclusividade. Pode ser síncrono ou assíncrono. */
export type ExclusiveTask<T> = () => T | Promise<T>

export class KeyedMutex {
  /**
   * A cauda da fila de cada chave. A entrada é removida quando o ÚLTIMO
   * ocupante termina — sem a limpeza, o mapa cresceria uma entrada por sessão
   * já encerrada pelo resto da vida do processo.
   */
  readonly #tails = new Map<string, Promise<void>>()

  /**
   * Executa `task` depois de todos os que chegaram antes na MESMA chave
   * (FIFO), e antes de qualquer um que chegue depois. Erro do task propaga ao
   * chamador dele e NÃO envenena a fila: o próximo da fila não tem culpa.
   */
  async runExclusive<T>(key: string, task: ExclusiveTask<T>): Promise<T> {
    const gate = this.#tails.get(key) ?? Promise.resolve()

    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#tails.set(key, turn)

    await gate
    try {
      return await task()
    } finally {
      release()
      // Só limpa se a cauda ainda é a nossa: se alguém entrou na fila depois,
      // a entrada agora pertence a ele.
      if (this.#tails.get(key) === turn) {
        this.#tails.delete(key)
      }
    }
  }
}
