/**
 * O registro de especialistas como Service do kernel.
 *
 * No oráculo Go isto era estado de MÓDULO (atomic.Pointer global); aqui é
 * estado de INSTÂNCIA, e a diferença é deliberada: cada raiz de Context monta
 * o seu registro, testes não vazam catálogo entre si, e o unload do plugin
 * desregistra `ctx.specialists` — o efeito reversível que o kernel promete.
 *
 * A troca a quente é um snapshot IMUTÁVEL substituído por inteiro: quem troca
 * monta outro e aponta, nunca escreve no que está servindo leitura. Não há
 * atomic aqui porque o event loop já serializa — mas a imutabilidade continua
 * importando: um leitor que guardou o snapshot no começo de um laço pontua o
 * laço INTEIRO contra um catálogo só, mesmo que uma publicação caia no meio.
 */

import { Service, type Context, type Disposer } from '@aibot2/harness-kernel'
import {
  COMPILED_CATALOG,
  DEFAULT_ID,
  MASTER,
  MASTER_ID,
  allowsTool,
  type Definition,
} from './definition.js'
import { OverlayError, parseOverlay, validateOverlay } from './overlay.js'

declare module '@aibot2/harness-kernel' {
  interface Context {
    specialists: SpecialistRegistry
  }
}

/** O que Origin() devolve enquanto ninguém publicou nada. */
const ORIGIN_COMPILED = 'compilado'

/**
 * O catálogo ATIVO. Imutável depois de montado: o master entra no ÍNDICE mas
 * não na lista — `exists("master")` e `get("master")` precisam responder (o
 * transporte serve o avatar dele), e ao mesmo tempo ele não é uma opção que a
 * pessoa escolhe na barra.
 */
interface Snapshot {
  readonly origin: string
  readonly list: readonly Definition[]
  readonly byID: ReadonlyMap<string, Definition>
}

function newSnapshot(origin: string, list: readonly Definition[]): Snapshot {
  const copied = [...list]
  const byID = new Map<string, Definition>()
  for (const definition of copied) {
    byID.set(definition.id, definition)
  }
  byID.set(MASTER_ID, MASTER)
  return { origin, list: copied, byID }
}

/**
 * Checkpoint opaco do catálogo. Plugins usam capture/restore para que
 * descarregar um overlay revele exatamente o estado anterior — inclusive
 * OUTRO overlay que já estivesse ativo, camada que resetOverlay perderia.
 */
export interface RegistrySnapshot {
  /** @internal */
  readonly snapshot: Snapshot
}

export interface RegistryConfig {
  /**
   * Diz se uma ferramenta existe no registro do host. Chega por injeção
   * (aqui ou por setToolChecker) porque o registro de ferramentas mora em
   * outro plugin — perguntar direto fecharia um ciclo. Sem verificador a
   * checagem é PULADA, o que só é aceitável porque o único caminho que não o
   * instala é teste.
   */
  toolChecker?: (name: string) => boolean
}

export class SpecialistRegistry extends Service {
  static readonly inject: readonly string[] = []

  private active: Snapshot
  private toolChecker: ((name: string) => boolean) | undefined
  private readonly hooks = new Set<() => void>()
  /**
   * Gancho é para reconstruir cache, nada mais. Reentrar numa troca durante o
   * aviso faria os DEMAIS ganchos rodarem sobre um catálogo que já mudou de
   * novo — o erro nomeia o contrato em vez de deixar o cache torto calado.
   */
  private notifying = false

  constructor(ctx: Context, config: RegistryConfig = {}) {
    super(ctx, 'specialists')
    this.active = newSnapshot(ORIGIN_COMPILED, COMPILED_CATALOG)
    this.toolChecker = config.toolChecker
  }

  /* ------------------------------ leitura ------------------------------- */

  /** O catálogo na ordem de exibição — o master fica FORA (não é opção). */
  all(): Definition[] {
    return [...this.active.list]
  }

  ids(): string[] {
    return this.active.list.map((definition) => definition.id)
  }

  /** `undefined` distingue "não existe" de "veio zerado". */
  get(id: string): Definition | undefined {
    return this.active.byID.get(id)
  }

  /**
   * Nunca falha: id desconhecido cai no padrão. Usado no caminho de
   * renderização, onde derrubar a tela por causa de um id velho gravado numa
   * conversa antiga seria desproporcional. UMA leitura do snapshot, não duas:
   * entre duas leituras caberia uma troca, e a resposta sairia de dois
   * catálogos diferentes.
   */
  getOrDefault(id: string): Definition {
    const index = this.active.byID
    return index.get(id) ?? (index.get(DEFAULT_ID) as Definition)
  }

  /** Diz se o id é de um especialista real (master incluso). */
  exists(id: string): boolean {
    return this.active.byID.has(id)
  }

  allowsTool(id: string, tool: string): boolean {
    const definition = this.active.byID.get(id)
    if (definition === undefined) return false
    return allowsTool(definition, tool)
  }

  /**
   * De onde veio o catálogo em vigor: "compilado" ou "publicado v0.2.0".
   * Quando alguém relata que o especialista responde diferente do esperado, a
   * primeira pergunta é qual catálogo a estação está rodando.
   */
  origin(): string {
    return this.active.origin
  }

  /* --------------------------- troca a quente --------------------------- */

  /**
   * Valida o documento publicado e TROCA o catálogo ativo.
   *
   * Erro (OverlayError, com TODOS os problemas juntos) significa que NADA
   * mudou: o catálogo anterior — compilado ou de um overlay que já valia —
   * continua inteiro de pé. É a diferença entre uma publicação errada custar
   * um aviso no log e custar o app.
   */
  loadOverlay(raw: string | unknown): void {
    const document = parseOverlay(raw)
    const problems = validateOverlay(document, this.toolChecker)
    if (problems.length > 0) {
      throw new OverlayError(problems)
    }
    const version = document.version.trim().replace(/^v/, '')
    this.swap(newSnapshot(`publicado v${version}`, document.specialists))
  }

  /**
   * Volta ao catálogo compilado — o caminho de volta quando uma publicação
   * passa na validação e mesmo assim está errada. Sem ele a única saída seria
   * publicar de novo, o que depende exatamente do servidor que acabou de
   * publicar o problema.
   */
  resetOverlay(): void {
    this.swap(newSnapshot(ORIGIN_COMPILED, COMPILED_CATALOG))
  }

  /** Registra o snapshot imutável atual sem copiar o caminho quente. */
  capture(): RegistrySnapshot {
    return { snapshot: this.active }
  }

  /**
   * Recoloca um checkpoint e avisa os mesmos caches que loadOverlay. Estado
   * ausente é ignorado para que um disposer parcial não apague o catálogo.
   */
  restore(state: RegistrySnapshot | undefined): void {
    if (state === undefined || state.snapshot === undefined) return
    this.swap(state.snapshot)
  }

  /**
   * Gancho chamado depois de TODA troca de catálogo, com a troca JÁ
   * publicada (pode ler o catálogo novo por all()/get()). Existe por uma
   * razão medida: o roteador mantém caches do catálogo (candidatos e radicais
   * normalizados), e cache que não é reconstruído na troca faz o roteador
   * decidir pelo catálogo velho enquanto a tela mostra o novo.
   *
   * O disposer devolvido remove o gancho — quem registra via ctx.effect faz o
   * gancho morrer com o plugin dono.
   */
  onChange(hook: () => void): Disposer {
    this.hooks.add(hook)
    return () => {
      this.hooks.delete(hook)
    }
  }

  /** Liga a validação de ferramentas ao registro real. UMA vez, na subida. */
  setToolChecker(check: (name: string) => boolean): void {
    this.toolChecker = check
  }

  private swap(next: Snapshot): void {
    if (this.notifying) {
      throw new Error(
        '[specialist-registry] troca de catálogo dentro de um gancho onChange — gancho é para reconstruir cache, não para publicar',
      )
    }
    this.active = next
    this.notifying = true
    try {
      for (const hook of this.hooks) {
        hook()
      }
    } finally {
      this.notifying = false
    }
  }
}
