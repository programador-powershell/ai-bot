/**
 * Barramento de eventos da raiz. A tipagem (nome do evento → assinatura) mora
 * na borda — os métodos genéricos do Context — porque é lá que o declaration
 * merging dos consumidores atua; aqui dentro o barramento é homogêneo de
 * propósito: uma lista de callbacks por nome, sem conhecer o tipo de ninguém.
 */

/**
 * Mapa global de eventos tipados. Consumidores estendem via declaration
 * merging (`declare module '@aibot2/harness-kernel' { interface Events {...} }`;
 * dentro deste pacote, o alvo é o caminho relativo deste módulo).
 *
 * Convenção do kernel: em eventos waterfall, o ÚLTIMO parâmetro da assinatura
 * é o `next` — e é ele que o chamador fornece como miolo no dispatch.
 */
export interface Events {
  /**
   * Canal de erro do emit: fire-and-forget não tem retorno para o chamador,
   * então um listener quebrado desagua aqui. Sem ninguém ouvindo, o primeiro
   * erro estoura no emissor — sumir com erro é pior que quebrar.
   */
  'internal/error'(error: unknown): void
}

type Listener = (...args: any[]) => any

interface Hook {
  callback: Listener
}

export class EventBus {
  private readonly hooks = new Map<string, Hook[]>()

  /** Registra e devolve o removedor (true se ainda estava registrado). */
  register(name: string, callback: Listener): () => boolean {
    let list = this.hooks.get(name)
    if (!list) {
      list = []
      this.hooks.set(name, list)
    }
    const hook: Hook = { callback }
    list.push(hook)
    return () => {
      const index = list.indexOf(hook)
      if (index < 0) return false
      list.splice(index, 1)
      return true
    }
  }

  /**
   * Cópia do momento do disparo: listener adicionado/removido DURANTE um
   * dispatch só vale para o próximo — mutar a lista no meio da iteração é o
   * tipo de bug que só aparece um ano depois.
   */
  private snapshot(name: string): Listener[] {
    const list = this.hooks.get(name)
    return list ? list.map((hook) => hook.callback) : []
  }

  /** Fire-and-forget síncrono: retorno dos listeners é ignorado. */
  emit(name: string, args: readonly unknown[]): void {
    const errors: unknown[] = []
    for (const listener of this.snapshot(name)) {
      try {
        listener(...args)
      } catch (error) {
        // Um listener quebrado não pode calar os demais: coleta e segue.
        errors.push(error)
      }
    }
    if (errors.length === 0) return
    // O próprio internal/error não re-entra em si mesmo — um handler de erro
    // quebrado viraria loop infinito.
    const handlers = name === 'internal/error' ? [] : this.snapshot('internal/error')
    if (handlers.length === 0) throw errors[0]
    for (const error of errors) {
      for (const handler of handlers) handler(error)
    }
  }

  /** Todos concorrentes; só assenta quando TODOS assentarem. */
  async parallel(name: string, args: readonly unknown[]): Promise<void> {
    const settled = await Promise.allSettled(
      this.snapshot(name).map(async (listener) => listener(...args)),
    )
    const failures = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length === 0) return
    if (failures.length === 1) throw failures[0]!.reason
    // Esperar todos antes de estourar é deliberado: abortar no primeiro erro
    // deixaria efeitos pela metade rodando sem ninguém olhando.
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `[harness-kernel] ${failures.length} listeners falharam em "${name}"`,
    )
  }

  /**
   * Em ordem de registro, cada listener só roda quando o anterior assentou —
   * o modo para efeitos que não podem se sobrepor. Erro interrompe a fila.
   */
  async serial(name: string, args: readonly unknown[]): Promise<void> {
    for (const listener of this.snapshot(name)) {
      await listener(...args)
    }
  }

  /**
   * Em ordem, aguardando cada um: `undefined` é "passo a vez"; a primeira
   * resposta de verdade encerra a rodada e os seguintes nem são chamados.
   */
  async bail(name: string, args: readonly unknown[]): Promise<unknown> {
    for (const listener of this.snapshot(name)) {
      const value = await listener(...args)
      if (value !== undefined) return value
    }
    return undefined
  }

  /**
   * Middleware em volta do miolo (o último argumento): cada listener recebe
   * `next` e decide se a cadeia continua. Não chamar `next()` VETA — os
   * listeners internos e o miolo não rodam. `next(...)` com argumentos
   * substitui os argumentos rio abaixo; sem argumentos, repassa os atuais.
   */
  waterfall(name: string, args: readonly unknown[]): unknown {
    const tail = args[args.length - 1]
    if (typeof tail !== 'function') {
      throw new TypeError(
        `[harness-kernel] waterfall("${name}") exige o miolo como último argumento — é ele que a cadeia envolve`,
      )
    }
    const chain = this.snapshot(name)
    const dispatch = (index: number, current: readonly unknown[]): unknown => {
      const listener = chain[index]
      if (!listener) return (tail as Listener)(...current)
      let spent = false
      const next = (...override: unknown[]): unknown => {
        // next é de uso único: chamar duas vezes duplicaria os efeitos rio
        // abaixo, calado — melhor estourar aqui, com nome e endereço.
        if (spent) {
          throw new Error(
            `[harness-kernel] next() de "${name}" chamado duas vezes pelo mesmo listener`,
          )
        }
        spent = true
        return dispatch(index + 1, override.length > 0 ? override : current)
      }
      return listener(...current, next)
    }
    return dispatch(0, args.slice(0, -1))
  }
}
