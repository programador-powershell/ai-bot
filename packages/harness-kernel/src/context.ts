/**
 * O Context é o repositório de serviços tipados e a fachada de tudo que um
 * plugin pode fazer: montar outros plugins, ouvir/disparar eventos e registrar
 * efeitos reversíveis. Cada plugin recebe um Context próprio (com o SEU
 * escopo), mas serviços e eventos são um só por raiz — é isso que faz
 * `ctx.<serviço>` funcionar de qualquer ponto da árvore.
 *
 * A forma é deliberadamente próxima do Cordis (cláusula de saída do m1-plano
 * §2): se um dia a casa preferir a dependência npm, a troca deve ser mecânica.
 */

import { EventBus, type Events } from './events.js'
import { PluginScope, type Disposer } from './scope.js'
import { normalizePlugin, type Plugin } from './plugin.js'

/**
 * Estado compartilhado por todos os contextos da mesma raiz.
 * @internal exposto só porque aparece na assinatura do construtor de fork.
 */
export interface Kernel {
  readonly services: Map<string, unknown>
  readonly bus: EventBus
}

/**
 * O que `ctx.effect()` aceita do corpo do efeito: nada (efeito sem reversa),
 * um disposer, um iterável/generator de disposers ou uma promise de disposer.
 */
export type EffectResult =
  | void
  | Disposer
  | Iterable<Disposer>
  | Promise<void | Disposer>

/**
 * Alvo do declaration merging: consumidores declaram aqui as chaves tipadas
 * dos serviços que registram (`declare module '@aibot2/harness-kernel'
 * { interface Context { meuServico: MeuServico } }`; dentro deste pacote, o
 * alvo é o caminho relativo deste módulo).
 */
export interface Context {}

export class Context {
  /** @internal estado da raiz — compartilhado com todos os forks. */
  readonly kernel: Kernel
  /** Escopo dono de tudo que ESTE contexto registrar. */
  readonly scope: PluginScope

  constructor(kernel?: Kernel, scope?: PluginScope) {
    this.kernel = kernel ?? { services: new Map(), bus: new EventBus() }
    this.scope = scope ?? new PluginScope('(raiz)', [])
    // O Proxy é o que transforma serviço registrado em `ctx.<nome>` sem criar
    // accessor global no prototype: a visibilidade morre com a raiz, não vaza
    // entre raízes (cada teste/processo monta a sua).
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string' || Reflect.has(target, prop)) {
          return Reflect.get(target, prop, receiver)
        }
        return target.kernel.services.get(prop)
      },
      has(target, prop) {
        if (Reflect.has(target, prop)) return true
        return typeof prop === 'string' && target.kernel.services.has(prop)
      },
    })
  }

  /* ------------------------------------------------------------------ *
   * Serviços                                                            *
   * ------------------------------------------------------------------ */

  /** Leitura sem açúcar (e sem tipagem) — útil para dependência opcional. */
  get(name: string): unknown {
    return this.kernel.services.get(name)
  }

  /**
   * Registra `ctx.<name>` para toda a raiz. Colisão é ERRO, não sobrescrita:
   * dois donos para o mesmo nome é conflito de montagem, e conflito de
   * montagem se resolve na montagem. O registro pertence ao escopo atual —
   * o unload do dono remove o serviço.
   */
  provide(name: string, value: unknown): Disposer {
    if (this.kernel.services.has(name)) {
      throw new Error(
        `[harness-kernel] serviço "${name}" já registrado — colisão de nome é erro, não sobrescrita`,
      )
    }
    if (name in this) {
      throw new Error(
        `[harness-kernel] "${name}" colide com a API do Context — escolha outro nome de serviço`,
      )
    }
    this.kernel.services.set(name, value)
    return this.scope.attach(() => {
      // Cinto de segurança: só remove se ainda formos os donos. Na prática a
      // colisão barra sobrescrita, mas um disposer nunca deve apagar o que
      // não registrou.
      if (this.kernel.services.get(name) === value) {
        this.kernel.services.delete(name)
      }
    }, `service:${name}`)
  }

  /* ------------------------------------------------------------------ *
   * Eventos                                                             *
   * ------------------------------------------------------------------ */

  /**
   * Ouve um evento. O disposer devolvido remove o listener (true se ainda
   * estava lá) — e o listener também morre com o plugin: o unload do escopo
   * remove tudo que não foi removido à mão.
   */
  on<K extends keyof Events & string>(name: K, listener: Events[K]): () => boolean {
    const remove = this.kernel.bus.register(name, listener as (...args: any[]) => any)
    this.scope.attach(remove, `on:${name}`)
    return remove
  }

  /** Fire-and-forget síncrono; erro de listener vai para `internal/error`. */
  emit<K extends keyof Events & string>(name: K, ...args: Parameters<Events[K]>): void {
    this.kernel.bus.emit(name, args)
  }

  /** Todos concorrentes; assenta quando todos assentarem. */
  parallel<K extends keyof Events & string>(
    name: K,
    ...args: Parameters<Events[K]>
  ): Promise<void> {
    return this.kernel.bus.parallel(name, args)
  }

  /** Em ordem de registro, um por vez. */
  serial<K extends keyof Events & string>(
    name: K,
    ...args: Parameters<Events[K]>
  ): Promise<void> {
    return this.kernel.bus.serial(name, args)
  }

  /** Para no primeiro retorno não-undefined; os seguintes nem rodam. */
  bail<K extends keyof Events & string>(
    name: K,
    ...args: Parameters<Events[K]>
  ): Promise<Awaited<ReturnType<Events[K]>> | undefined> {
    return this.kernel.bus.bail(name, args) as Promise<
      Awaited<ReturnType<Events[K]>> | undefined
    >
  }

  /**
   * Middleware em volta do miolo (último argumento). Não chamar `next()` veta
   * a cadeia — é o gancho que viabiliza agent/pre-step, llm/stream e
   * tools/pre-execute no resto do plano.
   */
  waterfall<K extends keyof Events & string>(
    name: K,
    ...args: Parameters<Events[K]>
  ): ReturnType<Events[K]> {
    return this.kernel.bus.waterfall(name, args) as ReturnType<Events[K]>
  }

  /* ------------------------------------------------------------------ *
   * Efeitos e plugins                                                   *
   * ------------------------------------------------------------------ */

  /**
   * Efeito reversível arbitrário: o corpo roda JÁ; o que ele devolver vira
   * disposer na pilha do escopo. No generator, cada `yield` entrega um passo
   * JÁ montado — se o corpo estourar no meio, o que subiu desce na hora (em
   * reverso), para a falha não deixar metade do efeito de pé.
   *
   * Setup assíncrono que rejeita é reportado em `internal/error` (o chamador
   * de effect já foi embora; sem ouvintes registrados na raiz, a falha se
   * perde — registrar esse ouvinte é papel da montagem raiz).
   */
  effect(setup: () => EffectResult, label?: string): Disposer {
    const steps: Disposer[] = []
    let pending: Promise<void> | undefined
    const outcome = setup()
    if (typeof outcome === 'function') {
      steps.push(outcome)
    } else if (isIterable(outcome)) {
      const iterator = outcome[Symbol.iterator]()
      try {
        let cursor = iterator.next()
        while (!cursor.done) {
          steps.push(cursor.value)
          cursor = iterator.next()
        }
      } catch (error) {
        for (let index = steps.length - 1; index >= 0; index--) {
          try {
            steps[index]!()
          } catch {
            // A falha primária é a do corpo do efeito; a reversa é melhor
            // esforço — mascará-la esconderia a causa raiz.
          }
        }
        throw error
      }
    } else if (outcome instanceof Promise) {
      pending = outcome.then(
        (value) => {
          if (typeof value === 'function') steps.push(value)
        },
        (error) => {
          try {
            this.kernel.bus.emit('internal/error', [error])
          } catch {
            // Sem ouvintes (ou com ouvinte quebrado) não há canal: engolir
            // aqui evita virar unhandled rejection dentro do kernel.
          }
        },
      )
    }
    const dispose: Disposer = async () => {
      // Desmontar no meio da montagem desfaria coisa que ainda nem existe:
      // o disposer espera o setup assíncrono assentar antes de desfazer.
      if (pending) await pending
      const errors: unknown[] = []
      for (let index = steps.length - 1; index >= 0; index--) {
        try {
          await steps[index]!()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `[harness-kernel] efeito "${label ?? '(sem rótulo)'}" falhou ao desfazer`,
        )
      }
    }
    return this.scope.attach(dispose, label ?? 'effect')
  }

  /**
   * Monta um plugin (função, objeto `{apply}` ou classe) e devolve o handle
   * await-ável. Duas invariantes moram aqui:
   *
   *  - inject resolve na MONTAGEM: dependência ausente estoura agora, com a
   *    lista completa, e o apply nem chega a rodar;
   *  - a montagem é atômica para quem observa: apply que falha (síncrono ou
   *    assíncrono) desfaz o que já tinha registrado antes de o erro subir.
   *
   * Quem monta é dono: o unload do pai desmonta o filho, na posição LIFO
   * correta em relação ao resto que o pai registrou.
   */
  plugin<T = void>(plugin: Plugin<T>, config?: T): PluginScope {
    const shape = normalizePlugin(plugin)
    const missing = shape.inject.filter((dep) => !this.kernel.services.has(dep))
    if (missing.length > 0) {
      throw new Error(
        `[harness-kernel] montagem de "${shape.name}" falhou: inject exige serviço(s) ausente(s): ` +
          `${missing.join(', ')} — monte os providers antes dos consumidores`,
      )
    }
    const scope = new PluginScope(shape.name, shape.provide)
    const child = new Context(this.kernel, scope)
    let outcome: unknown
    try {
      // O `as T` cobre o caso config-omitida (T = void): a assinatura fica
      // permissiva de propósito — exigir config via tipo condicional quebrava
      // a inferência de T nas três formas.
      outcome = shape.apply(child, config as T)
    } catch (error) {
      // Rollback é melhor esforço no caminho síncrono (disposers podem ser
      // assíncronos e aqui não dá para aguardar); o erro que sobe é o da
      // montagem — abort() nunca rejeita.
      void scope.abort()
      throw error
    }
    if (outcome instanceof Promise) {
      scope.adopt(
        outcome.then(
          () => undefined,
          async (error) => {
            await scope.abort()
            throw error
          },
        ),
      )
    } else {
      scope.adopt(Promise.resolve())
    }
    this.scope.attach(() => scope.dispose(), `plugin:${shape.name}`)
    return scope
  }
}

function isIterable(value: unknown): value is Iterable<Disposer> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value
}
