/**
 * Os aceites do E4 sobre o funil inteiro (m1-plano §5): auditoria ANTES do
 * efeito, decisão humana durável, digest igual dos dois lados do portão,
 * timeout que recusa, aprovação pendente que sobrevive a reinício, a regra de
 * ouro da UI e o teste-espelho — um tool call sem decisão do portão NÃO
 * executa.
 *
 * O store é o driver sqlite REAL (node:sqlite): durabilidade de aprovação é
 * exatamente o que este plugin promete, e prová-la contra um fake seria
 * prová-la contra nada.
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import {
  SqliteEventStore,
  importLogJsonl,
  type ApprovalRequest,
  type Envelope,
  type ToolCall,
  type ToolResult,
} from '@aibot2/domain-events'
import * as plugin from './index.js'
import {
  ActionGatewayService,
  FsArtifactStore,
  UI_ALLOWED_TOOLS,
  uiAllowedList,
  type ActionDecisionEvent,
  type ActionGatewayConfig,
  type ActionOutcomeEvent,
  type SpecialistDirectory,
  type ToolExecutor,
} from './index.js'

/* ------------------------------ auxiliares ------------------------------ */

const CATALOGO: Record<string, readonly string[]> = {
  chat: ['fs.read', 'memory.read', 'memory.write', 'web.search', 'web.fetch', 'context.fetch'],
  code: [
    'fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.patch',
    'git.status', 'git.diff', 'git.commit', 'proc.run', 'context.fetch', 'flow.validate',
  ],
  design: ['fs.write', 'design.replicate', 'image.generate'],
}

function fakeDirectory(): SpecialistDirectory {
  return {
    getOrDefault(id: string) {
      const tools = CATALOGO[id] ?? CATALOGO['chat']!
      return { id, name: id || 'chat', allowsTool: (tool: string) => tools.includes(tool) }
    },
  }
}

/** O executor-espião: o teste-espelho é a contagem de chamadas dele. */
class SpyExecutor implements ToolExecutor {
  calls: { sessionId: string; tool: string; args: unknown }[] = []
  handler: (sessionId: string, tool: string, args: unknown) => Promise<string> | string = () => 'ok'

  async call(sessionId: string, tool: string, args: unknown): Promise<string> {
    this.calls.push({ sessionId, tool, args })
    return this.handler(sessionId, tool, args)
  }
}

interface Rig {
  ctx: Context
  gateway: ActionGatewayService
  store: SqliteEventStore
  executor: SpyExecutor
  decisions: ActionDecisionEvent[]
  succeeded: ActionOutcomeEvent[]
  failed: ActionOutcomeEvent[]
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function buildRig(options?: Partial<ActionGatewayConfig> & { location?: string }): Promise<Rig> {
  const store = (options?.store as SqliteEventStore) ?? SqliteEventStore.open(options?.location ?? ':memory:')
  if (options?.store === undefined) {
    cleanups.push(() => store.close())
  }
  const executor = new SpyExecutor()
  const ctx = new Context()
  const config: ActionGatewayConfig = {
    store,
    tools: options?.tools ?? executor,
    directory: options?.directory ?? fakeDirectory(),
    approvalTimeoutMs: options?.approvalTimeoutMs ?? 5000,
  }
  if (options?.artifacts !== undefined) config.artifacts = options.artifacts
  if (options?.policy !== undefined) config.policy = options.policy
  const gateway = new ActionGatewayService(ctx, config)
  const decisions: ActionDecisionEvent[] = []
  const succeeded: ActionOutcomeEvent[] = []
  const failed: ActionOutcomeEvent[] = []
  ctx.on('action.decision', (event) => decisions.push(event))
  ctx.on('action.succeeded', (event) => succeeded.push(event))
  ctx.on('action.failed', (event) => failed.push(event))
  return { ctx, gateway, store, executor, decisions, succeeded, failed }
}

async function envelopes(store: SqliteEventStore, sessionId: string): Promise<Envelope[]> {
  return store.since(sessionId, 0, 500)
}

async function waitFor<T>(probe: () => Promise<T | undefined>, label: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`waitFor estourou: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A primeira aprovação pendente da sessão — o cartão que a tela mostraria. */
async function firstPending(gateway: ActionGatewayService, sessionId: string) {
  return waitFor(
    async () => (await gateway.pendingApprovals(sessionId))[0],
    `approval.request em ${sessionId}`,
  )
}

/* ------------------------------ montagem -------------------------------- */

it('monta como plugin do kernel: ctx.actionGateway existe e o unload desregistra', async () => {
  const store = SqliteEventStore.open(':memory:')
  cleanups.push(() => store.close())
  const ctx = new Context()
  const scope = ctx.plugin(plugin, {
    store,
    tools: new SpyExecutor(),
    directory: fakeDirectory(),
  })
  await scope
  expect(ctx.actionGateway).toBeInstanceOf(ActionGatewayService)

  await scope.dispose()
  expect(ctx.get('actionGateway')).toBeUndefined()
})

/* --------------------------- o funil de efeitos -------------------------- */

describe('execute', () => {
  it('aceite E4: tool.call é gravado ANTES da decisão — a recusa deixa o par de auditoria e o efeito NÃO roda', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'chat' })

    // chat não tem proc.run no catálogo → deny.
    const result = await rig.gateway.execute({
      sessionId: 's1', specialistId: 'chat', tool: 'proc.run', args: { command: 'dir' },
    })

    expect(result.ok).toBe(false)
    expect(result.decision).toBe('deny')
    expect(result.text).toContain('RECUSADO (proc.run):')
    // O teste-espelho: sem decisão favorável do portão, o executor nem é chamado.
    expect(rig.executor.calls).toHaveLength(0)

    // As duas linhas do envelope govern(): o pedido ANTES, o desfecho DEPOIS.
    const trail = await envelopes(rig.store, 's1')
    expect(trail.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
    const outcome = trail[1]!.payload as ToolResult
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('proc.run')

    expect(rig.decisions).toHaveLength(1)
    expect(rig.decisions[0]!.decision).toBe('deny')
    expect(rig.decisions[0]!.intent).toBe('EXECUTE')
    expect(rig.failed).toHaveLength(1)
    expect(rig.succeeded).toHaveLength(0)
  })

  it('aceite E4: recusa humana — o pedido espera, a pessoa diz não, o efeito não roda', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })

    const running = rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.write', args: { path: 'a.txt', content: 'x' },
    })

    const pending = await firstPending(rig.gateway, 's1')
    // A ferramenta ainda não rodou: a decisão humana vem ANTES do efeito.
    expect(rig.executor.calls).toHaveLength(0)

    rig.gateway.decide({ callId: pending.request.callId, allow: false, comment: 'não quero' })
    const result = await running

    expect(result.ok).toBe(false)
    expect(result.text).toBe('RECUSADO PELO USUÁRIO (fs.write): não quero')
    expect(rig.executor.calls).toHaveLength(0)

    const trail = await envelopes(rig.store, 's1')
    expect(trail.map((e) => e.kind)).toEqual([
      'tool.call', 'approval.request', 'approval.decision', 'tool.result',
    ])
    // A decisão é envelope durável assinado pela PESSOA.
    expect(trail[2]!.from.kind).toBe('user')
    expect(trail[2]!.payload).toMatchObject({ allow: false, comment: 'não quero' })
  })

  it('aceite E4: decisão humana durável ANTES do efeito — a ordem da fixture, com o digest igual dos dois lados', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })

    // O executor fotografa o log NO MOMENTO do efeito: a decisão já tem de
    // estar gravada quando a ferramenta roda.
    let decisionAtEffect: Envelope | undefined
    rig.executor.handler = async (sessionId) => {
      const trail = await rig.store.since(sessionId, 0, 500)
      decisionAtEffect = trail.find((e) => e.kind === 'approval.decision')
      return 'gravado'
    }

    const running = rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.write', args: { path: 'a.txt', content: 'x' },
    })
    const pending = await firstPending(rig.gateway, 's1')
    rig.gateway.decide({ callId: pending.request.callId, allow: true, scope: 'once' })
    const result = await running

    expect(result.ok).toBe(true)
    expect(result.text).toBe('fs.write =>\ngravado')
    expect(rig.executor.calls).toHaveLength(1)
    expect(decisionAtEffect, 'o efeito rodou sem a decisão durável no log').toBeDefined()
    expect(decisionAtEffect!.payload).toMatchObject({ allow: true, scope: 'once' })

    const trail = await envelopes(rig.store, 's1')
    expect(trail.map((e) => e.kind)).toEqual([
      'tool.call', 'approval.request', 'approval.decision', 'tool.result',
    ])
    // O digest do pedido é o MESMO nos dois lados do portão.
    const call = trail[0]!.payload as ToolCall
    const request = trail[1]!.payload as ApprovalRequest
    expect(call.digest).toBeDefined()
    expect(call.digest).toBe(request.digest)
    expect(request.callId).toBe(call.callId)

    const outcome = trail[3]!.payload as ToolResult
    expect(outcome).toMatchObject({ ok: true, tool: 'fs.write', output: 'gravado' })
    expect(rig.succeeded).toHaveLength(1)
  })

  it('escopo "once" não vira regra; "digest" prende aos argumentos; "session" libera a ferramenta para o especialista', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })
    const args = { path: 'a.txt', content: 'x' }
    const call = (extra?: object) =>
      rig.gateway.execute({ sessionId: 's1', specialistId: 'code', tool: 'fs.write', args: { ...args, ...extra } })
    const approvals = async () =>
      (await envelopes(rig.store, 's1')).filter((e) => e.kind === 'approval.request').length

    // 1º pedido: aprovado com "digest".
    const first = call()
    const pending1 = await firstPending(rig.gateway, 's1')
    rig.gateway.decide({ callId: pending1.request.callId, allow: true, scope: 'digest' })
    expect((await first).ok).toBe(true)
    expect(await approvals()).toBe(1)

    // Os MESMOS argumentos passam sem perguntar de novo.
    expect((await call()).ok).toBe(true)
    expect(await approvals()).toBe(1)

    // Argumentos diferentes perguntam de novo — o sim não virou cheque em branco.
    const third = call({ content: 'outra coisa' })
    const pending2 = await firstPending(rig.gateway, 's1')
    rig.gateway.decide({ callId: pending2.request.callId, allow: true, scope: 'once' })
    expect((await third).ok).toBe(true)
    expect(await approvals()).toBe(2)

    // "once" não guardou nada: repetir pergunta de novo; aprova com "session".
    const fourth = call({ content: 'outra coisa' })
    const pending3 = await firstPending(rig.gateway, 's1')
    rig.gateway.decide({ callId: pending3.request.callId, allow: true, scope: 'session' })
    expect((await fourth).ok).toBe(true)
    expect(await approvals()).toBe(3)

    // "session" liberou a ferramenta INTEIRA para o code — qualquer argumento.
    expect((await call({ content: 'mais uma' })).ok).toBe(true)
    expect(await approvals()).toBe(3)
  })

  it('aceite E4: timeout recusa — silêncio não é consentimento', async () => {
    const rig = await buildRig({ approvalTimeoutMs: 25 })
    await rig.store.createSession({ id: 's1', specialist: 'code' })

    const result = await rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.write', args: { path: 'a.txt' },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('ninguém decidiu dentro do prazo')
    expect(rig.executor.calls).toHaveLength(0)

    const trail = await envelopes(rig.store, 's1')
    // O prazo estourado NÃO forja decisão humana: recusa direto no desfecho.
    expect(trail.map((e) => e.kind)).toEqual(['tool.call', 'approval.request', 'tool.result'])
    // E o pedido não fica pendurado como pendente.
    expect(await rig.gateway.pendingApprovals('s1')).toHaveLength(0)
    // Decidir depois do prazo é engano, e engano faz barulho.
    const request = trail[1]!.payload as ApprovalRequest
    expect(() => rig.gateway.decide({ callId: request.callId, allow: true })).toThrow(
      'nenhuma aprovação pendente',
    )
  })

  it('turno cancelado antes da decisão recusa com o motivo do cancelamento', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })
    const controller = new AbortController()

    const running = rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.write', args: { path: 'a.txt' },
      signal: controller.signal,
    })
    await firstPending(rig.gateway, 's1')
    controller.abort()

    const result = await running
    expect(result.ok).toBe(false)
    expect(result.error).toBe('o turno foi cancelado antes da decisão')
    expect(rig.executor.calls).toHaveLength(0)
  })

  it('falha da ferramenta vira a segunda linha da auditoria (sucedeu/falhou), nunca silêncio', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })
    rig.executor.handler = () => {
      throw new Error('disco cheio')
    }

    const result = await rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.read', args: { path: 'a.txt' },
    })

    expect(result.ok).toBe(false)
    expect(result.text).toBe('ERRO em fs.read: disco cheio')
    const trail = await envelopes(rig.store, 's1')
    expect(trail.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
    expect(trail[1]!.payload).toMatchObject({ ok: false, error: 'disco cheio' })
    expect(rig.failed).toHaveLength(1)
    expect(rig.failed[0]!.error).toBe('disco cheio')
  })

  it('o resumo do pedido é resolvido pelo SERVIDOR — um rótulo do modelo não vira alvo', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })

    const running = rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'proc.run',
      args: { label: 'leitura inofensiva', command: 'rm -rf x' },
    })
    const pending = await firstPending(rig.gateway, 's1')

    // O cartão mostra o comando REAL, extraído dos argumentos pelo servidor.
    expect(pending.request.summary).toBe('proc.run — rm -rf x')
    expect(rig.decisions[0]!.summary).toBe('proc.run — rm -rf x')

    rig.gateway.decide({ callId: pending.request.callId, allow: false })
    const result = await running
    expect(result.error).toBe('a pessoa recusou a execução')
  })

  it('decide() para pedido que ninguém espera é engano com nome e endereço', async () => {
    const rig = await buildRig()
    expect(() => rig.gateway.decide({ callId: 'c-fantasma', allow: true })).toThrow(
      'nenhuma aprovação pendente para c-fantasma',
    )
  })
})

/* --------------------- compat com a fixture do oráculo -------------------- */

describe('compat com sessions/ferramenta-aprovada', () => {
  const fixtureUrl = new URL(
    '../../../../test-fixtures/sessions/ferramenta-aprovada/log.jsonl',
    import.meta.url,
  )

  it('o funil reproduz a trilha e o DIGEST que o gateway Go gravou', async () => {
    const fixture = importLogJsonl(readFileSync(fixtureUrl, 'utf8'))
    const fixtureCall = fixture.find((e) => e.kind === 'tool.call')!.payload as ToolCall
    const fixtureRequest = fixture.find((e) => e.kind === 'approval.request')!.payload as ApprovalRequest

    // A invariante já vale na fixture: o digest é o MESMO dos dois lados.
    expect(fixtureCall.digest).toBe(fixtureRequest.digest)

    const rig = await buildRig()
    // A sessão do oráculo: especialista chat, sem projeto (sem cwd).
    await rig.store.createSession({ id: 'compat', specialist: 'chat' })
    rig.executor.handler = () => 'memória gravada: Backup semanal'

    const rawArgs = fixtureRequest.detail!
    const running = rig.gateway.execute({
      sessionId: 'compat', specialistId: 'chat', tool: 'memory.write',
      args: JSON.parse(rawArgs), rawArgs,
    })
    const pending = await firstPending(rig.gateway, 'compat')

    // O MESMO pedido produz o MESMO digest do oráculo (sha256[:8] do
    // escopo+ferramenta+argumentos crus) e o mesmo cartão.
    expect(pending.request.digest).toBe(fixtureCall.digest)
    expect(pending.request.summary).toBe(fixtureRequest.summary)
    expect(pending.request.detail).toBe(fixtureRequest.detail)
    expect(pending.request.risk).toBe(fixtureRequest.risk)

    rig.gateway.decide({ callId: pending.request.callId, allow: true, scope: 'once' })
    const result = await running
    expect(result.ok).toBe(true)

    // A MESMA sequência durável da fixture (a fatia de ferramenta dela).
    const trail = await envelopes(rig.store, 'compat')
    expect(trail.map((e) => e.kind)).toEqual([
      'tool.call', 'approval.request', 'approval.decision', 'tool.result',
    ])
    expect((trail[0]!.payload as ToolCall).digest).toBe(fixtureCall.digest)
    expect(trail[2]!.from).toEqual({ kind: 'user' })
    expect(trail[2]!.payload).toMatchObject({ allow: true, scope: 'once' })
    expect(trail[3]!.payload).toMatchObject({
      ok: true, tool: 'memory.write', output: 'memória gravada: Backup semanal',
    })
  })
})

/* ----------------------- aprovação durável (reinício) --------------------- */

describe('aprovação durável', () => {
  it('aceite E4: reinício no meio de uma aprovação pendente — o pedido REAPARECE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibot2-gateway-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const location = join(dir, 'log.db')

    // A primeira vida do processo: o pedido vai ao log e ninguém decide.
    const store1 = SqliteEventStore.open(location)
    await store1.createSession({ id: 's1', specialist: 'code' })
    const rig1 = await buildRig({ store: store1, approvalTimeoutMs: 60_000 })
    const controller = new AbortController()
    const running = rig1.gateway
      .execute({
        sessionId: 's1', specialistId: 'code', tool: 'fs.write',
        args: { path: 'a.txt' }, signal: controller.signal,
      })
      // O processo "morreu": o que sobrar desta promise não interessa mais.
      .catch(() => undefined)
    const before = await firstPending(rig1.gateway, 's1')
    await store1.close()

    // A segunda vida: outro processo, outro gateway, o MESMO log.
    const store2 = SqliteEventStore.open(location)
    cleanups.push(() => store2.close())
    const rig2 = await buildRig({ store: store2 })

    const reappeared = await rig2.gateway.pendingApprovals('s1')
    expect(reappeared).toHaveLength(1)
    expect(reappeared[0]!.request.callId).toBe(before.request.callId)
    expect(reappeared[0]!.request.tool).toBe('fs.write')
    expect(reappeared[0]!.request.digest).toBe(before.request.digest)

    // A decisão gravada encerra o reaparecimento — o cartão fecha e não volta.
    await store2.append('s1', {
      id: 'e-decisao-pos-reinicio',
      kind: 'approval.decision',
      from: { kind: 'user' },
      payload: { callId: before.request.callId, allow: false },
    })
    expect(await rig2.gateway.pendingApprovals('s1')).toHaveLength(0)

    controller.abort()
    await running
  })
})

/* --------------------- política declarada, no plugin ---------------------- */

describe('política declarada na montagem', () => {
  it('o override declarado é LIDO: toolRules deny vale por cima do modo aprovar tudo', async () => {
    const rig = await buildRig({ policy: { mode: 'all', toolRules: { 'fs.read': 'deny' } } })
    await rig.store.createSession({ id: 's1', specialist: 'code' })

    const denied = await rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.read', args: { path: 'a.txt' },
    })
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain('regra declarada')
    expect(rig.executor.calls).toHaveLength(0)

    // E o modo declarado também foi lido: o resto roda sem perguntar.
    const allowed = await rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'proc.run', args: { command: 'dir' },
    })
    expect(allowed.ok).toBe(true)
    expect(rig.executor.calls).toHaveLength(1)
  })

  it('toolRules allow dispensa a pergunta do modo edits — sem approval.request no log', async () => {
    const rig = await buildRig({ policy: { mode: 'edits', toolRules: { 'fs.write': 'allow' } } })
    await rig.store.createSession({ id: 's1', specialist: 'code' })

    const result = await rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.write', args: { path: 'a.txt' },
    })
    expect(result.ok).toBe(true)
    const trail = await envelopes(rig.store, 's1')
    expect(trail.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
  })

  it('política ilegível = deny em tudo, nunca default silencioso', async () => {
    const rig = await buildRig({ policy: { mode: 42 } })
    await rig.store.createSession({ id: 's1', specialist: 'code' })
    expect(rig.gateway.gate.unreadableReason).toBeDefined()

    const result = await rig.gateway.execute({
      sessionId: 's1', specialistId: 'code', tool: 'fs.read', args: { path: 'a.txt' },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('não pôde ser lida')
    expect(rig.executor.calls).toHaveLength(0)
  })
})

/* ------------------------------ o caminho da UI --------------------------- */

describe('callToolFromUI', () => {
  it('a whitelist tem as MESMAS 9 ferramentas do oráculo', () => {
    expect([...UI_ALLOWED_TOOLS].sort()).toEqual([
      'context.fetch', 'flow.validate', 'fs.list', 'fs.patch', 'fs.read',
      'fs.search', 'fs.write', 'git.diff', 'git.status',
    ])
    expect(uiAllowedList()).toBe(
      'context.fetch, flow.validate, fs.list, fs.patch, fs.read, fs.search, fs.write, git.diff, git.status',
    )
  })

  it('regra de ouro: recusa de whitelist NÃO deixa envelope', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })
    const before = await rig.store.lastSeq('s1')

    const result = await rig.gateway.callToolFromUI('s1', 'proc.run', '{}')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('a interface não pode pedir proc.run')
    expect(result.error).toContain(uiAllowedList())

    // O log não ganhou uma linha: o pedido nem chegou ao funil.
    expect(await rig.store.lastSeq('s1')).toBe(before)
    expect(rig.executor.calls).toHaveLength(0)
  })

  it('regra de ouro: o pedido da UI recebe o INTEGRAL do artifact, e o log guarda a projeção', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibot2-ui-artifacts-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const rig = await buildRig({ artifacts: new FsArtifactStore(dir) })
    await rig.store.createSession({ id: 's1', specialist: 'code' })

    // fs.read devolve 20000 bytes — bem acima do teto inline de 12 KiB.
    let integral = ''
    while (integral.length < 20000) integral += `[${String(integral.length).padStart(8, '0')}]`
    integral = integral.slice(0, 20000)
    rig.executor.handler = () => integral

    const result = await rig.gateway.callToolFromUI('s1', 'fs.read', '{"path":"grande.txt"}')

    // A interface recebe o arquivo INTEIRO — a projeção no editor seria um
    // arquivo corrompido e salvável.
    expect(result.ok).toBe(true)
    expect(result.output).toBe(integral)

    // Enquanto o LOG (a janela do modelo) guarda a projeção com a referência.
    const trail = await envelopes(rig.store, 's1')
    const outcome = trail.find((e) => e.kind === 'tool.result')!.payload as ToolResult
    expect(outcome.truncated).toBe(true)
    expect(outcome.output).toContain('SAÍDA GRANDE')
    expect(outcome.artifactRef).toMatch(/^artifact:\/\//)
    // O desfecho foi lido do LOG (mesmo turn "ui-…"), não deduzido do texto.
    expect(trail.find((e) => e.kind === 'tool.result')!.turn).toMatch(/^ui-/)
  })

  it('a chamada da UI passa pelo MESMO funil: envelopes assinados pela pessoa, turno próprio', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })
    rig.executor.handler = () => 'conteúdo'

    const result = await rig.gateway.callToolFromUI('s1', 'fs.read', '{"path":"a.txt"}')
    expect(result).toEqual({ ok: true, output: 'conteúdo' })

    const trail = await envelopes(rig.store, 's1')
    expect(trail.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
    for (const envelope of trail) {
      expect(envelope.from).toEqual({ kind: 'user', id: 'ui', specialist: 'code' })
      expect(envelope.turn).toMatch(/^ui-/)
    }
  })

  it('sessão sem modo cai no especialista da superfície do editor (code), não no chat', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1' })
    rig.executor.handler = () => 'conteúdo'

    const result = await rig.gateway.callToolFromUI('s1', 'fs.read', '{"path":"a.txt"}')
    expect(result.ok).toBe(true)
    const trail = await envelopes(rig.store, 's1')
    expect(trail[0]!.from.specialist).toBe('code')
  })

  it('recusa de mérito volta DENTRO do resultado; só infraestrutura vira exceção', async () => {
    const rig = await buildRig()
    await rig.store.createSession({ id: 's1', specialist: 'code' })
    rig.executor.handler = () => {
      throw new Error('arquivo não existe')
    }

    // Falha da ferramenta: resultado com o motivo, não exceção.
    const failed = await rig.gateway.callToolFromUI('s1', 'fs.read', '{"path":"nada.txt"}')
    expect(failed.ok).toBe(false)
    expect(failed.error).toBe('arquivo não existe')

    // Sessão inexistente é infraestrutura: falha alto.
    await expect(rig.gateway.callToolFromUI('nao-existe', 'fs.read', '{}')).rejects.toThrow()
  })
})
