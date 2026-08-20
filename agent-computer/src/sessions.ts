/**
 * As sessões de browser POR RUNTIME — a cirurgia da spec §3/§32 sobre o
 * agent-computer do openbot.
 *
 * No openbot, `sessionFor(botId)` amarrava um computador PERMANENTE a cada
 * bot: perfil persistente em volume, browser que sobrevive entre turnos.
 * Aqui a chave é o runtimeId de um EXECUTION TARGET: o contexto nasce para a
 * TaskRun que declarou requirements.browser=true e morre com ela. Bot ocioso
 * consome ZERO containers e ZERO navegadores — essa é a economia inteira do
 * desenho, e é por isso que NÃO existe perfil persistente nesta leva: um
 * contexto efêmero que herdasse logins de outra tarefa seria vazamento entre
 * tarefas, não conveniência.
 *
 * Um único processo Chromium serve todas as sessões (lançado preguiçosamente
 * no primeiro open); cada runtimeId ganha um BrowserContext PRÓPRIO — cookies,
 * storage e páginas isolados por construção, com o custo de um processo só.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createControl, type Control } from './control.js'

/** Uma sessão viva: o contexto da TaskRun, a página e o volante dela. */
export interface RuntimeSession {
  runtimeId: string
  page: Page
  control: Control
  /**
   * A geração de snapshot DESTA sessão. Toda ref e{N} entregue ao bot carrega
   * a geração em que nasceu; agir com geração antiga é recusado com "tire um
   * snapshot novo" — mensagem acionável, não elemento que só não resolve.
   */
  snapshotId: number
}

interface Slot {
  context: BrowserContext
  session: RuntimeSession
}

export interface SessionManagerOptions {
  /** Headless por padrão; o teste visual de amanhã pode abrir com cabeça. */
  headless?: boolean
}

export class SessionManager {
  readonly #options: SessionManagerOptions
  readonly #slots = new Map<string, Slot>()
  /**
   * Promise, não instância: dois opens concorrentes no processo frio não podem
   * lançar dois Chromium — o segundo aguarda o launch do primeiro.
   */
  #browser: Promise<Browser> | undefined

  constructor(options: SessionManagerOptions = {}) {
    this.#options = options
  }

  #launch(): Promise<Browser> {
    this.#browser ??= chromium.launch({ headless: this.#options.headless ?? true })
    return this.#browser
  }

  /** Quantas sessões estão vivas — o que o /health publica. */
  count(): number {
    return this.#slots.size
  }

  /** A sessão do runtime, ou undefined — quem responde 404 é a rota. */
  get(runtimeId: string): RuntimeSession | undefined {
    return this.#slots.get(runtimeId)?.session
  }

  /**
   * Abre a sessão do runtime. Idempotente de propósito: um retry de rede do
   * cliente não pode criar um segundo contexto e orfanar o primeiro — o
   * segundo open devolve a MESMA sessão com `alreadyOpen`.
   */
  async open(runtimeId: string): Promise<{ session: RuntimeSession; alreadyOpen: boolean }> {
    const existing = this.#slots.get(runtimeId)
    if (existing !== undefined) {
      return { session: existing.session, alreadyOpen: true }
    }
    const browser = await this.#launch()
    const context = await browser.newContext()
    const page = await context.newPage()
    const session: RuntimeSession = {
      runtimeId,
      page,
      control: createControl(),
      snapshotId: 0,
    }
    this.#slots.set(runtimeId, { context, session })
    return { session, alreadyOpen: false }
  }

  /**
   * Fecha a sessão DE VERDADE (o contexto do Playwright morre, não só o
   * registro). Idempotente: o disposer do kernel e um close explícito podem
   * ambos chegar — o segundo devolve false e não estoura.
   */
  async close(runtimeId: string): Promise<boolean> {
    const slot = this.#slots.get(runtimeId)
    if (slot === undefined) return false
    this.#slots.delete(runtimeId)
    // Contexto que falhou ao fechar (browser já caiu?) não pode impedir a
    // remoção do registro — o registro já saiu acima, e o erro sobe.
    await slot.context.close()
    return true
  }

  /** Derruba tudo — o caminho do shutdown do processo. */
  async closeAll(): Promise<void> {
    const slots = [...this.#slots.values()]
    this.#slots.clear()
    for (const slot of slots) {
      try {
        await slot.context.close()
      } catch {
        // Shutdown é melhor esforço: um contexto emperrado não pode segurar
        // o fechamento do browser inteiro logo abaixo.
      }
    }
    if (this.#browser !== undefined) {
      const browser = await this.#browser
      this.#browser = undefined
      await browser.close()
    }
  }
}
