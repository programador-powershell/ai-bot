/**
 * Bateria do agent-computer com Chromium REAL, headless (download aprovado) —
 * nada de mock de browser: os aceites E8 desta frente são sobre o browser de
 * verdade. A página-alvo é servida pelo PRÓPRIO teste em 127.0.0.1, e por isso
 * a instância principal sobe com allowPrivateHosts (o mesmo opt-in que um
 * deployment local usa); a instância do teste de SSRF sobe SEM o opt-in.
 *
 * O que se afirma aqui:
 * - token errado é 401 em qualquer rota;
 * - sessão é POR RUNTIME: open/close, idempotentes, e o /health conta;
 * - snapshot devolve refs e{N} e as roles esperadas da página local;
 * - act clica/digita POR REF e o DOM muda de verdade (visto no re-snapshot);
 * - ref de geração velha (ou inventada) é 409 stale, com instrução acionável;
 * - Take the Wheel: humano no controle ⇒ act do bot é 409, nunca enfileirado;
 * - SSRF: URL que RESOLVE para IP privado é 403 com motivo;
 * - close fecha o contexto DE VERDADE (a sessão some do processo).
 */

import { createServer as createHttpServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAgentComputer, type AgentComputer } from './index.js'
import type { SnapshotElement } from './aria-snapshot.js'

const LONG = 30_000

/** A página-alvo: um formulário mínimo cujo botão MUDA quando clicado. */
const FIXTURE_HTML = `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><title>Fixture do agente</title></head>
  <body>
    <h1>Página de teste</h1>
    <label>Nome <input type="text"></label>
    <button onclick="this.textContent='Enviado'">Enviar</button>
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

interface Answer {
  status: number
  body: Record<string, unknown>
}

function caller(port: number, token: string) {
  return async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    tokenOverride?: string,
  ): Promise<Answer> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokenOverride ?? token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
}

describe('agent-computer com Chromium real', () => {
  // Token gerado POR TESTE: segredo nunca mora no repositório.
  const token = randomUUID()
  const runtimeId = 'run-t1-a1'
  let agent: AgentComputer
  let agentPort: number
  let fixture: { server: Server; port: number }
  let call: ReturnType<typeof caller>

  beforeAll(async () => {
    fixture = await serveFixture()
    agent = createAgentComputer({
      token,
      // O opt-in de deployment local: a página-alvo mora em 127.0.0.1.
      allowPrivateHosts: true,
      // O resolver injetado dá um nome que "resolve" para a metadata — a
      // recusa incondicional tem de valer MESMO com allowPrivateHosts.
      resolve: async (hostname) =>
        hostname === 'sosia.metadata.corp' ? ['169.254.169.254'] : ['93.184.216.34'],
    })
    agentPort = await agent.listen()
    call = caller(agentPort, token)
  }, 120_000)

  afterAll(async () => {
    await agent.close()
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  }, 60_000)

  it('token errado é 401 e não conta nada sobre o que protege', async () => {
    const answer = await call('GET', '/health', undefined, 'token-errado')
    expect(answer.status).toBe(401)
    expect(JSON.stringify(answer.body)).not.toContain('session')
  })

  it('abre a sessão do runtime; o segundo open é idempotente', { timeout: LONG }, async () => {
    const first = await call('POST', `/session/${runtimeId}/open`, {})
    expect(first.status).toBe(200)
    expect(first.body['alreadyOpen']).toBe(false)

    const second = await call('POST', `/session/${runtimeId}/open`, {})
    expect(second.body['alreadyOpen']).toBe(true)

    const health = await call('GET', '/health')
    expect(health.body['sessions']).toBe(1)
  })

  it('agir num runtime que nunca abriu é 404, não sessão implícita', async () => {
    const answer = await call('POST', '/session/run-fantasma/act', { kind: 'click', ref: 'e1' })
    expect(answer.status).toBe(404)
  })

  it('navega até a página local e devolve título', { timeout: LONG }, async () => {
    const answer = await call('POST', `/session/${runtimeId}/navigate`, {
      url: `http://127.0.0.1:${fixture.port}/`,
    })
    expect(answer.status).toBe(200)
    expect(answer.body['title']).toBe('Fixture do agente')
  })

  let snapshotId = 0
  let textboxRef = ''
  let buttonRef = ''

  it('snapshot devolve refs e{N} e as roles da página', { timeout: LONG }, async () => {
    const answer = await call('POST', `/session/${runtimeId}/snapshot`, {})
    expect(answer.status).toBe(200)
    snapshotId = answer.body['snapshotId'] as number
    expect(snapshotId).toBeGreaterThan(0)
    const elements = answer.body['elements'] as SnapshotElement[]
    expect(elements.every((each) => /^e\d+$/.test(each.ref))).toBe(true)
    const textbox = elements.find((each) => each.role === 'textbox' && each.name === 'Nome')
    const button = elements.find((each) => each.role === 'button' && each.name === 'Enviar')
    expect(textbox).toBeDefined()
    expect(button).toBeDefined()
    textboxRef = textbox!.ref
    buttonRef = button!.ref
  })

  it('type por ref preenche o campo — visto no re-snapshot, nunca no eco', { timeout: LONG }, async () => {
    const answer = await call('POST', `/session/${runtimeId}/act`, {
      kind: 'type',
      ref: textboxRef,
      snapshotId,
      text: 'Alice',
    })
    expect(answer.status).toBe(200)
    expect(answer.body['characters']).toBe(5)
    // O texto digitado NÃO volta na resposta (senha mora aí).
    expect(JSON.stringify(answer.body)).not.toContain('Alice')

    const after = await call('POST', `/session/${runtimeId}/snapshot`, {})
    const elements = after.body['elements'] as SnapshotElement[]
    const textbox = elements.find((each) => each.role === 'textbox')
    expect(textbox!.value).toBe('Alice')
    snapshotId = after.body['snapshotId'] as number
    textboxRef = textbox!.ref
    buttonRef = elements.find((each) => each.role === 'button')!.ref
  })

  it('click por ref muda o DOM de verdade', { timeout: LONG }, async () => {
    const answer = await call('POST', `/session/${runtimeId}/act`, {
      kind: 'click',
      ref: buttonRef,
      snapshotId,
    })
    expect(answer.status).toBe(200)

    const after = await call('POST', `/session/${runtimeId}/snapshot`, {})
    const elements = after.body['elements'] as SnapshotElement[]
    // O onclick trocou o nome acessível: a mudança é observável na lista.
    expect(elements.some((each) => each.role === 'button' && each.name === 'Enviado')).toBe(true)
    snapshotId = after.body['snapshotId'] as number
  })

  it('ref de geração velha é 409 stale com instrução acionável', { timeout: LONG }, async () => {
    const answer = await call('POST', `/session/${runtimeId}/act`, {
      kind: 'click',
      ref: buttonRef,
      snapshotId: snapshotId - 1,
    })
    expect(answer.status).toBe(409)
    expect(answer.body['stale']).toBe(true)
    expect(String(answer.body['error'])).toContain('snapshot')
  })

  it('ref inventada da geração atual também é 409 stale (e rápido)', { timeout: LONG }, async () => {
    const answer = await call('POST', `/session/${runtimeId}/act`, {
      kind: 'click',
      ref: 'e9999',
      snapshotId,
    })
    expect(answer.status).toBe(409)
    expect(answer.body['stale']).toBe(true)
  })

  it('Take the Wheel: humano no controle ⇒ act do bot é RECUSADO, nunca enfileirado', { timeout: LONG }, async () => {
    await call('POST', `/session/${runtimeId}/control/take`, {})

    const refused = await call('POST', `/session/${runtimeId}/act`, {
      kind: 'click',
      ref: buttonRef,
      snapshotId,
    })
    expect(refused.status).toBe(409)
    expect(refused.body['humanHasControl']).toBe(true)

    // Navegar também é agir.
    const refusedNav = await call('POST', `/session/${runtimeId}/navigate`, {
      url: `http://127.0.0.1:${fixture.port}/`,
    })
    expect(refusedNav.status).toBe(409)

    const state = await call('GET', `/session/${runtimeId}/control`)
    expect(state.body['holder']).toBe('human')

    await call('POST', `/session/${runtimeId}/control/release`, {})
    const allowed = await call('POST', `/session/${runtimeId}/act`, {
      kind: 'press',
      key: 'Tab',
    })
    expect(allowed.status).toBe(200)
  })

  it('metadata resolvida é recusada MESMO com allowPrivateHosts', { timeout: LONG }, async () => {
    const answer = await call('POST', `/session/${runtimeId}/navigate`, {
      url: 'http://sosia.metadata.corp/latest/',
    })
    expect(answer.status).toBe(403)
    expect(answer.body['refused']).toBe(true)
  })

  it('close fecha o contexto de verdade e é idempotente', { timeout: LONG }, async () => {
    const closed = await call('POST', `/session/${runtimeId}/close`, {})
    expect(closed.body['closed']).toBe(true)

    const after = await call('POST', `/session/${runtimeId}/act`, { kind: 'press', key: 'Tab' })
    expect(after.status).toBe(404)

    const again = await call('POST', `/session/${runtimeId}/close`, {})
    expect(again.body['closed']).toBe(false)

    const health = await call('GET', '/health')
    expect(health.body['sessions']).toBe(0)
  })

  it('rota desconhecida é 404 — nenhum passthrough além do contrato', async () => {
    const answer = await call('POST', '/computers/reset', {})
    expect(answer.status).toBe(404)
  })
})

describe('agent-computer SEM opt-in de hosts privados (o caso SSRF)', () => {
  const token = randomUUID()
  let agent: AgentComputer
  let call: ReturnType<typeof caller>

  beforeAll(async () => {
    agent = createAgentComputer({
      token,
      // SEM allowPrivateHosts: o default de produção.
      resolve: async () => ['10.0.0.5'],
    })
    const port = await agent.listen()
    call = caller(port, token)
    await call('POST', '/session/run-ssrf/open', {})
  }, 120_000)

  afterAll(async () => {
    await agent.close()
  }, 60_000)

  it('nome que resolve para IP privado é recusado DEPOIS de resolver', { timeout: LONG }, async () => {
    const answer = await call('POST', '/session/run-ssrf/navigate', {
      url: 'http://painel.interno.corp/',
    })
    expect(answer.status).toBe(403)
    expect(answer.body['refused']).toBe(true)
    expect(String(answer.body['error'])).toContain('10.0.0.5')
  })

  it('IP literal interno é recusado por padrão', { timeout: LONG }, async () => {
    const answer = await call('POST', '/session/run-ssrf/navigate', {
      url: 'http://127.0.0.1:8080/',
    })
    expect(answer.status).toBe(403)
  })
})
