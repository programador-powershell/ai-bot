/**
 * Bateria da REGRA task-scoped — sem browser e com fetch falso, porque o que
 * se afirma aqui é exatamente que a recusa acontece ANTES de qualquer HTTP:
 * sem execution target, ou sem requirements.browser=true no plano, o fio nem
 * é tocado. E o ciclo de vida: o disposer do kernel fecha UMA vez, mesmo com
 * close manual junto.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'

import * as browserRuntime from './index.js'
import { BrowserRefusalError, type ExecutionTarget } from './target.js'

function target(over: Partial<ExecutionTarget> = {}): ExecutionTarget {
  return {
    taskRunId: 'run-t1-a1',
    workerId: 'pc-02',
    leaseEpoch: 4,
    runtimeId: 'rt-t1-a1',
    ...over,
  }
}

/** Fetch roteirizado: registra as chamadas e responde o contrato mínimo. */
function fakeFetch() {
  const calls: string[] = []
  const fetchFn = async (url: string, _init: RequestInit): Promise<Response> => {
    calls.push(new URL(url).pathname)
    const body = url.endsWith('/close') ? { closed: true } : { opened: true, alreadyOpen: false }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetchFn }
}

function mount(fetchFn: browserRuntime.Config['fetchFn']) {
  const ctx = new Context()
  ctx.plugin(browserRuntime, {
    baseUrl: 'http://127.0.0.1:9',
    token: 'token-de-teste',
    ...(fetchFn !== undefined ? { fetchFn } : {}),
  })
  return ctx
}

describe('a regra task-scoped (recusas ANTES do fio)', () => {
  it('sem execution target é recusa com motivo — nenhum HTTP', async () => {
    const { calls, fetchFn } = fakeFetch()
    const ctx = mount(fetchFn)
    await expect(ctx.browser.open({ requirements: { browser: true } })).rejects.toThrow(
      BrowserRefusalError,
    )
    await expect(ctx.browser.open({ requirements: { browser: true } })).rejects.toThrow(
      /execution target/,
    )
    expect(calls).toEqual([])
  })

  it('target incompleto é recusa que diz o que falta', async () => {
    const { calls, fetchFn } = fakeFetch()
    const ctx = mount(fetchFn)
    await expect(
      ctx.browser.open({ target: target({ leaseEpoch: 0 }), requirements: { browser: true } }),
    ).rejects.toThrow(/leaseEpoch/)
    await expect(
      ctx.browser.open({ target: target({ runtimeId: ' ' }), requirements: { browser: true } }),
    ).rejects.toThrow(/runtimeId/)
    expect(calls).toEqual([])
  })

  it('sem requirements.browser=true no plano é recusa — browser só nasce para quem declarou', async () => {
    const { calls, fetchFn } = fakeFetch()
    const ctx = mount(fetchFn)
    await expect(ctx.browser.open({ target: target() })).rejects.toThrow(BrowserRefusalError)
    await expect(
      ctx.browser.open({ target: target(), requirements: { browser: false } }),
    ).rejects.toThrow(/requirements\.browser/)
    // A leitura é a MESMA do scheduler: 'sim' não é true — campo fora do
    // vocabulário simplesmente não existe.
    await expect(
      ctx.browser.open({ target: target(), requirements: { browser: 'sim' } }),
    ).rejects.toThrow(BrowserRefusalError)
    expect(calls).toEqual([])
  })

  it('com target + requirements.browser=true o open acontece', async () => {
    const { calls, fetchFn } = fakeFetch()
    const ctx = mount(fetchFn)
    const lease = await ctx.browser.open({ target: target(), requirements: { browser: true } })
    expect(lease.target.runtimeId).toBe('rt-t1-a1')
    expect(calls).toEqual(['/session/rt-t1-a1/open'])
  })
})

describe('o volante da execução (Take the Wheel pelo lease)', () => {
  /**
   * Fetch roteirizado para o volante: o open abre, o /control devolve o estado
   * corrente, e o take/release trocam quem segura. Prova que o lease fala o
   * contrato /session/{runtimeId}/control* — a chave é o runtime, nunca o bot.
   */
  function controlFetch() {
    const calls: string[] = []
    let holder: 'bot' | 'human' = 'bot'
    const fetchFn = async (url: string): Promise<Response> => {
      const path = new URL(url).pathname
      calls.push(path)
      let body: Record<string, unknown>
      if (path.endsWith('/open')) body = { opened: true, alreadyOpen: false }
      else if (path.endsWith('/control/take')) {
        holder = 'human'
        body = { holder, since: 't', requested: false }
      } else if (path.endsWith('/control/release')) {
        holder = 'bot'
        body = { holder, since: 't', requested: false }
      } else if (path.endsWith('/control/request')) {
        body = { holder, since: 't', requested: true, reason: 'preciso do login' }
      } else if (path.endsWith('/control')) {
        body = { holder, since: 't', requested: false }
      } else body = {}
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return { calls, fetchFn }
  }

  it('control()/take/release atravessam por runtimeId — a UI vê quem segura', async () => {
    const { calls, fetchFn } = controlFetch()
    const ctx = mount(fetchFn)
    const lease = await ctx.browser.open({ target: target(), requirements: { browser: true } })

    expect((await lease.control()).holder).toBe('bot')
    expect((await lease.takeControl()).holder).toBe('human')
    // Depois do take o estado LIDO reflete o humano — é o cartão que a tela mostra.
    expect((await lease.control()).holder).toBe('human')
    expect((await lease.releaseControl()).holder).toBe('bot')

    // Toda rota do volante é escopada ao runtime da execução, não a um bot.
    expect(calls).toEqual([
      '/session/rt-t1-a1/open',
      '/session/rt-t1-a1/control',
      '/session/rt-t1-a1/control/take',
      '/session/rt-t1-a1/control',
      '/session/rt-t1-a1/control/release',
    ])
  })

  it('requestControl carrega o motivo do bot para a pessoa', async () => {
    const { fetchFn } = controlFetch()
    const ctx = mount(fetchFn)
    const lease = await ctx.browser.open({ target: target(), requirements: { browser: true } })
    const state = await lease.requestControl('preciso do login')
    expect(state.requested).toBe(true)
    expect(state.reason).toBe('preciso do login')
  })
})

describe('o ciclo de vida (disposer do kernel)', () => {
  it('o fim do escopo do dono fecha a sessão — sem ninguém chamar close', async () => {
    const { calls, fetchFn } = fakeFetch()
    const ctx = mount(fetchFn)

    // O "escopo da TaskRun": um plugin filho cujo unload é o fim da tentativa.
    let taskCtx!: Context
    const scope = ctx.plugin(function taskRun(child: Context) {
      taskCtx = child
    })
    await scope

    await ctx.browser.open({ target: target(), requirements: { browser: true } }, taskCtx)
    expect(calls).toEqual(['/session/rt-t1-a1/open'])

    await scope.dispose()
    expect(calls).toEqual(['/session/rt-t1-a1/open', '/session/rt-t1-a1/close'])
  })

  it('close manual + disposer fecham UMA vez (idempotência)', async () => {
    const { calls, fetchFn } = fakeFetch()
    const ctx = mount(fetchFn)

    let taskCtx!: Context
    const scope = ctx.plugin(function taskRun(child: Context) {
      taskCtx = child
    })
    await scope

    const lease = await ctx.browser.open(
      { target: target(), requirements: { browser: true } },
      taskCtx,
    )
    await lease.close()
    await lease.close()
    await scope.dispose()

    const closes = calls.filter((path) => path.endsWith('/close'))
    expect(closes).toHaveLength(1)
  })
})
