/**
 * O escopo é a unidade de reversibilidade do kernel: tudo que um plugin
 * registra (listener, serviço, efeito, plugin filho) vira uma entrada na pilha
 * daqui, e o unload consome a pilha em ordem reversa. A ordem reversa não é
 * estética — quem se registrou por último pode depender do que veio antes,
 * então é ele quem sai primeiro (o espelho exato da montagem).
 *
 * O escopo também é o handle devolvido por `ctx.plugin()`: é thenable, então
 * `await handle` espera o apply (inclusive assíncrono) assentar.
 */

/** Desfaz um efeito. Pode devolver promise; quem desmonta aguarda. */
export type Disposer = () => unknown

/**
 * `pending`: apply ainda rodando · `active`: montado · `failed`: apply
 * estourou (o rollback já aconteceu) · `disposed`: desmontado por unload.
 */
export type ScopeStatus = 'pending' | 'active' | 'failed' | 'disposed'

interface DisposerEntry {
  run: Disposer
  /** Identifica a entrada em diagnósticos; nunca decide lógica. */
  label: string | undefined
  /**
   * Disparo único: dispose manual + unload do escopo alcançam a MESMA entrada,
   * e desfazer duas vezes é tão bug quanto não desfazer.
   */
  done: boolean
}

export class PluginScope implements PromiseLike<void> {
  readonly name: string
  /**
   * Metadado `provide` declarado pelo plugin (chaves que ele registra).
   * Reservado ao compositor (ordenação no M2+); hoje não tem efeito.
   */
  readonly provides: readonly string[]

  private readonly entries: DisposerEntry[] = []
  private state: ScopeStatus = 'pending'
  private ready: Promise<void> = Promise.resolve()
  private teardown: Promise<void> | undefined

  constructor(name: string, provides: readonly string[]) {
    this.name = name
    this.provides = provides
  }

  get status(): ScopeStatus {
    return this.state
  }

  /**
   * Registra um disposer na pilha e devolve a versão de disparo único.
   * Registrar num escopo já desmontado estoura na hora: o unload desse escopo
   * nunca mais vai rodar, então aceitar o registro seria aceitar o vazamento.
   * @internal — plugins usam ctx.on/ctx.provide/ctx.effect, nunca isto.
   */
  attach(run: Disposer, label?: string): Disposer {
    if (this.state === 'disposed' || this.state === 'failed') {
      throw new Error(
        `[harness-kernel] escopo "${this.name}" já desmontado — registrar efeito agora vazaria no unload`,
      )
    }
    const entry: DisposerEntry = { run, label, done: false }
    this.entries.push(entry)
    return () => runEntry(entry)
  }

  /**
   * Adota a promessa da montagem — é ela que torna o handle await-ável.
   * O catch vazio marca a rejeição como observada para quem NÃO aguarda o
   * handle; sem ele, montar sem await viraria unhandled rejection do processo.
   * @internal
   */
  adopt(ready: Promise<void>): void {
    this.ready = ready.then(() => {
      if (this.state === 'pending') this.state = 'active'
    })
    this.ready.catch(() => {})
  }

  /**
   * Desmonta o escopo: consome a pilha em ordem reversa, aguardando disposers
   * assíncronos. Um disposer quebrado não pode orfanar os demais — os erros
   * são coletados, o resto desce, e só então eles estouram juntos.
   * Idempotente: a segunda chamada devolve a mesma promessa.
   */
  dispose(): Promise<void> {
    this.teardown ??= this.unwind('disposed')
    return this.teardown
  }

  /**
   * Rollback de montagem que falhou: o mesmo caminho do dispose com estado
   * final diferente — `failed` preserva o fato de que o plugin nunca chegou a
   * ativo. Engole erros de disposer de propósito: neste caminho o erro que
   * importa (e que sobe para o chamador) é o do apply.
   * @internal
   */
  abort(): Promise<void> {
    this.teardown ??= this.unwind('failed').catch(() => {})
    return this.teardown
  }

  private async unwind(finalState: ScopeStatus): Promise<void> {
    const errors: unknown[] = []
    for (let index = this.entries.length - 1; index >= 0; index--) {
      try {
        await runEntry(this.entries[index]!)
      } catch (error) {
        errors.push(error)
      }
    }
    this.state = finalState
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `[harness-kernel] ${errors.length} disposers falharam no unload de "${this.name}"`,
      )
    }
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return this.ready.then(onfulfilled, onrejected)
  }
}

function runEntry(entry: DisposerEntry): unknown {
  if (entry.done) return undefined
  // Marca ANTES de rodar: um disposer que (indiretamente) dispara o próprio
  // unload não pode reentrar em si mesmo e virar loop.
  entry.done = true
  return entry.run()
}
