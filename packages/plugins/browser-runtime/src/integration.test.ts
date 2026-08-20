/**
 * Integração de ponta a ponta da frente: kernel → ctx.browser → agent-computer
 * → Chromium REAL headless. O que só este teste pode afirmar:
 *
 * - o seam do kernel fala com o processo de verdade (HTTP + token);
 * - o disposer do kernel fecha o CONTEXTO de verdade (o /health do
 *   agent-computer volta a zero sessões — não é só o registro do plugin);
 * - recusa de política não cria browser nenhum (bot ocioso = zero sessões).
 *
 * O agent-computer sobe com allowPrivateHosts porque a página-alvo é servida
 * pelo próprio teste em 127.0.0.1 — o mesmo opt-in de deployment local.
 */

import { createServer as createHttpServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Context } from '@aibot2/harness-kernel'
import { createAgentComputer, type AgentComputer } from '@aibot2/agent-computer'

import * as browserRuntime from './index.js'
import { BrowserRefusalError, type ExecutionTarget } from './target.js'

const LONG = 30_000

const FIXTURE_HTML = `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><title>Fixture do plugin</title></head>
  <body>
    <label>Busca <input type="text"></label>
    <button onclick="this.textContent='Feito'">Executar</button>
  </body>
</html>`

function serveFixture(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIXTURE_HTML)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
    })
  })
}

describe('ctx.browser contra o agent-computer real', () => {
  const token = randomUUID()
  let agent: AgentComputer
  let baseUrl = ''
  let fixture: { server: Server; port: number }
  let ctx: Context

  async function sessionsAlive(): Promise<number> {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await response.json()) as { sessions: number }
    return body.sessions
  }

  beforeAll(async () => {
    fixture = await serveFixture()
    agent = createAgentComputer({ token, allowPrivateHosts: true })
    const port = await agent.listen()
    baseUrl = `http://127.0.0.1:${port}`
    ctx = new Context()
    ctx.plugin(browserRuntime, { baseUrl, token })
  }, 120_000)

  afterAll(async () => {
    await agent.close()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  }, 60_000)

  it('recusa de política não cria browser nenhum', { timeout: LONG }, async () => {
    await expect(ctx.browser.open({})).rejects.toThrow(BrowserRefusalError)
    const target: ExecutionTarget = {
      taskRunId: 'run-t7-a1',
      workerId: 'pc-02',
      leaseEpoch: 2,
      runtimeId: 'rt-t7-a1',
    }
    await expect(ctx.browser.open({ target })).rejects.toThrow(BrowserRefusalError)
    expect(await sessionsAlive()).toBe(0)
  })

  it('TaskRun com requirements.browser=true abre, age e o dispose fecha DE VERDADE', { timeout: LONG }, async () => {
    // O "escopo da TaskRun": o unload dele é o fim da tentativa.
    let taskCtx!: Context
    const scope = ctx.plugin(function taskRun(child: Context) {
      taskCtx = child
    })
    await scope

    const lease = await ctx.browser.open(
      {
        target: {
          taskRunId: 'run-t9-a1',
          workerId: 'pc-02',
          leaseEpoch: 5,
          runtimeId: 'rt-t9-a1',
        },
        requirements: { browser: true },
      },
      taskCtx,
    )
    expect(await sessionsAlive()).toBe(1)

    const landed = await lease.navigate(`http://127.0.0.1:${fixture.port}/`)
    expect(landed.title).toBe('Fixture do plugin')

    const snapshot = await lease.snapshot()
    const button = snapshot.elements.find(
      (each) => each.role === 'button' && each.name === 'Executar',
    )
    expect(button).toBeDefined()
    expect(/^e\d+$/.test(button!.ref)).toBe(true)

    await lease.act({ kind: 'click', ref: button!.ref, snapshotId: snapshot.snapshotId })
    const after = await lease.snapshot()
    expect(after.elements.some((each) => each.role === 'button' && each.name === 'Feito')).toBe(
      true,
    )

    // O fim da TaskRun: o disposer do kernel fecha o contexto no processo —
    // não é limpeza de registro local, o /health do agent-computer zera.
    await scope.dispose()
    expect(await sessionsAlive()).toBe(0)

    // Agir depois do fim é 404 no computador — a sessão não existe mais.
    await expect(lease.act({ kind: 'press', key: 'Tab' })).rejects.toThrow(/runtime desconhecido/)
  })
})
