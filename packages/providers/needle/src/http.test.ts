/**
 * O provider HTTP contra um serviço REAL de loopback (node:http numa porta
 * efêmera) — nada de mock de fetch: o aceite E5 pede o processo DERRUBADO no
 * teste, e derrubar um mock não prova nada.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { SpecialistRegistry } from '@aibot2/specialist-registry'
import { RouterService, NEEDLE_MIN_CONFIDENCE } from '@aibot2/needle-orchestrator'
import { NeedleHttpModel, NeedleUnavailableError, type NeedleHttpConfig } from './http.js'
import { scriptedNeedle } from './scripted.js'

/** Sonda ambígua do oráculo: o léxico tem opinião e não decide sozinho. */
const AMBIGUOUS_TEXT = 'revisa a segurança desse código'

type Handler = (path: string, body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>

const servers: Server[] = []

/** Servidor roteirizado de loopback; devolve a porta efêmera. */
async function fakeNeedleService(handler: Handler): Promise<number> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      void Promise.resolve(handler(request.url ?? '', body)).then((result) => {
        response.statusCode = result.status
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(result.body))
      })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function configFor(port: number, overrides: Partial<NeedleHttpConfig> = {}): NeedleHttpConfig {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'needle-pro',
    timeoutMs: 2_000,
    maxConcurrentRequests: 2,
    structuredOutput: true,
    ...overrides,
  }
}

describe('config', () => {
  it('recusa baseUrl fora do loopback — o degrau local roda NA máquina', () => {
    for (const baseUrl of ['http://10.0.0.5:8788', 'https://needle.example.com', 'http://192.168.0.2:1']) {
      expect(() => new NeedleHttpModel(configFor(0, { baseUrl }))).toThrow(/não é loopback/)
    }
    // Loopback nas três grafias passa.
    for (const baseUrl of ['http://127.0.0.1:8788', 'http://localhost:8788', 'http://[::1]:8788']) {
      expect(() => new NeedleHttpModel(configFor(0, { baseUrl }))).not.toThrow()
    }
  })

  it('recusa timeout e concorrência sem sentido', () => {
    expect(() => new NeedleHttpModel(configFor(1, { timeoutMs: 0 }))).toThrow(/timeoutMs/)
    expect(() => new NeedleHttpModel(configFor(1, { maxConcurrentRequests: 0 }))).toThrow(/maxConcurrentRequests/)
  })
})

describe('health/route/orchestrate contra o serviço de pé', () => {
  it('sonda liga o ready, route devolve o veredito e orchestrate leva a config', async () => {
    const seen: { path: string; body: unknown }[] = []
    const port = await fakeNeedleService((path, body) => {
      seen.push({ path, body })
      if (path === '/health') return { status: 200, body: { ok: true } }
      if (path === '/route') return { status: 200, body: { specialist: 'work', confidence: 0.91, why: 'rotina' } }
      return { status: 200, body: { decisionId: 'd-1', mode: 'finish', confidence: 0.8 } }
    })
    const model = new NeedleHttpModel(configFor(port))

    // Nasce degradado: o boot não espera o serviço.
    expect(model.ready()).toBe(false)
    await model.start()
    expect(model.ready()).toBe(true)

    const verdict = await model.route({ prompt: 'organiza minha rotina', intent: 'request', candidates: [] })
    expect(verdict).toEqual({ specialist: 'work', confidence: 0.91, why: 'rotina' })

    const decision = await model.orchestrate({ goal: 'criar api', specialists: ['code'] })
    expect(decision).toEqual({ decisionId: 'd-1', mode: 'finish', confidence: 0.8 })

    // O que viaja: model em toda chamada, structuredOutput no orchestrate.
    const routeBody = seen.find((s) => s.path === '/route')?.body as Record<string, unknown>
    expect(routeBody.model).toBe('needle-pro')
    expect(routeBody.intent).toBe('request')
    const orchestrateBody = seen.find((s) => s.path === '/orchestrate')?.body as Record<string, unknown>
    expect(orchestrateBody.structuredOutput).toBe(true)
    expect(orchestrateBody.specialists).toEqual(['code'])
  })

  it('resposta fora do protocolo vira erro nomeado, não veredito torto', async () => {
    const port = await fakeNeedleService((path) =>
      path === '/health' ? { status: 200, body: { ok: true } } : { status: 200, body: { anything: true } })
    const model = new NeedleHttpModel(configFor(port))
    await model.start()
    await expect(model.route({ prompt: 'x', intent: 'request', candidates: [] }))
      .rejects.toThrow(/fora do protocolo/)
  })

  it('maxConcurrentRequests segura o excedente em fila — o serviço nunca vê mais que o teto', async () => {
    let inFlight = 0
    let peak = 0
    const port = await fakeNeedleService(async (path) => {
      if (path === '/health') return { status: 200, body: { ok: true } }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      inFlight--
      return { status: 200, body: { specialist: 'chat', confidence: 0.5 } }
    })
    const model = new NeedleHttpModel(configFor(port, { maxConcurrentRequests: 2 }))
    await model.start()

    await Promise.all(Array.from({ length: 6 }, () =>
      model.route({ prompt: 'x', intent: 'request', candidates: [] })))
    expect(peak).toBe(2)
  })

  it('timeout aborta a chamada e degrada o ready', async () => {
    const port = await fakeNeedleService(async (path) => {
      if (path === '/health') return { status: 200, body: { ok: true } }
      await new Promise((resolve) => setTimeout(resolve, 500))
      return { status: 200, body: { specialist: 'chat', confidence: 0.5 } }
    })
    const model = new NeedleHttpModel(configFor(port, { timeoutMs: 50 }))
    await model.start()
    await expect(model.route({ prompt: 'x', intent: 'request', candidates: [] }))
      .rejects.toThrow(NeedleUnavailableError)
    expect(model.ready()).toBe(false)
  })
})

describe('ACEITE E5: needle indisponível degrada a cascata para o LLM, sem erro ao usuário', () => {
  it('processo derrubado no meio: o turno em curso cai no modelo grande e o seguinte nem tenta', async () => {
    const port = await fakeNeedleService((path) =>
      path === '/health'
        ? { status: 200, body: { ok: true } }
        : { status: 200, body: { specialist: 'work', confidence: 0.95 } })
    const model = new NeedleHttpModel(configFor(port))
    await model.start()
    expect(model.ready()).toBe(true)

    // DERRUBA o serviço — o cenário literal do aceite.
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    const classifier = {
      calls: 0,
      async classify() {
        this.calls++
        return { specialist: 'data', confidence: 0.8 }
      },
    }
    const ctx = new Context()
    ctx.plugin(SpecialistRegistry, {})
    ctx.plugin(RouterService, { needle: model, classifier })

    // O route NÃO rejeita: a falha do degrau vira degrau seguinte.
    const route = await ctx.router.route({ text: AMBIGUOUS_TEXT })
    expect(route.reason).toBe('model')
    expect(route.specialist).toBe('data')
    expect(classifier.calls).toBe(1)
    // A falha degradou o ready: o próximo turno pula o degrau sem nem tentar.
    expect(model.ready()).toBe(false)
    const second = await ctx.router.route({ text: AMBIGUOUS_TEXT })
    expect(second.reason).toBe('model')
    expect(classifier.calls).toBe(2)
  })

  it('serviço que nunca subiu: ready falso desde o boot, cascata inteira de pé', async () => {
    // Porta de loopback sem ninguém ouvindo.
    const model = new NeedleHttpModel(configFor(1))
    await model.start() // não lança — boot nunca depende do serviço
    expect(model.ready()).toBe(false)

    const ctx = new Context()
    ctx.plugin(SpecialistRegistry, {})
    ctx.plugin(RouterService, {
      needle: model,
      classifier: { async classify() { return { specialist: 'work', confidence: 0.8 } } },
    })
    const route = await ctx.router.route({ text: AMBIGUOUS_TEXT })
    expect(route.reason).toBe('model')
    expect(route.specialist).toBe('work')
  })
})

describe('scriptedNeedle', () => {
  it('serve o roteiro em fila, grava as consultas e muda de prontidão', async () => {
    const scripted = scriptedNeedle({
      routes: [{ specialist: 'code', confidence: NEEDLE_MIN_CONFIDENCE }],
      decisions: [{ decisionId: 'd', mode: 'finish', confidence: 1 }],
    })
    expect(scripted.ready()).toBe(true)

    const verdict = await scripted.route({ prompt: 'p', intent: 'request', candidates: [] })
    expect(verdict.specialist).toBe('code')
    expect(scripted.routeCalls.length).toBe(1)
    expect(scripted.routeCalls[0]?.prompt).toBe('p')

    const decision = await scripted.orchestrate({ goal: 'g', specialists: [] })
    expect(decision).toEqual({ decisionId: 'd', mode: 'finish', confidence: 1 })

    // Roteiro esgotado é bug do TESTE — estoura, não inventa resposta.
    await expect(scripted.route({ prompt: 'q', intent: 'request', candidates: [] })).rejects.toThrow(/fila de rotas vazia/)

    scripted.setReady(false)
    expect(scripted.ready()).toBe(false)
    expect((await scripted.health()).ok).toBe(false)
  })

  it('encaixa na cascata como qualquer OrchestratorModel', async () => {
    const scripted = scriptedNeedle({ routes: [{ specialist: 'work', confidence: 0.9 }] })
    const ctx = new Context()
    ctx.plugin(SpecialistRegistry, {})
    ctx.plugin(RouterService, { needle: scripted })
    const route = await ctx.router.route({ text: AMBIGUOUS_TEXT })
    expect(route.reason).toBe('needle')
    expect(route.specialist).toBe('work')
    expect(route.confidence).toBe(0.9)
  })
})
