/**
 * O Agent Loop: turno = assembler → modelo (scriptedModel) → tools pelo
 * ctx.actionGateway (NUNCA por fora) → resultado projetado de volta ao
 * contexto → eventos no log. O gateway é o REAL (E4) sobre o driver sqlite
 * REAL: provar o funil contra um fake seria prová-lo contra nada.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { SqliteEventStore, type Envelope } from '@aibot2/domain-events'
import { ActionGatewayService, type SpecialistDirectory, type ToolExecutor } from '@aibot2/plugin-action-gateway'
import { SpecialistRegistry } from '@aibot2/specialist-registry'
import { MemoryCheckpointStore } from './checkpoint.js'
import { ContextRuntimeService } from './service.js'
import { AgentLoopService, parseToolCalls, stripToolBlocks, type ChatModel, type ModelStep } from './loop.js'

/* ------------------------------- infra do rig ------------------------------ */

const CATALOGO: Record<string, readonly string[]> = {
  code: ['fs.read', 'fs.list', 'fs.search', 'context.fetch'],
}

function fakeDirectory(): SpecialistDirectory {
  return {
    getOrDefault(id: string) {
      const tools = CATALOGO[id] ?? []
      return { id, name: id || 'chat', allowsTool: (tool: string) => tools.includes(tool) }
    },
  }
}

class SpyExecutor implements ToolExecutor {
  calls: { tool: string; args: unknown }[] = []
  handler: (tool: string, args: unknown) => string = () => 'ok'

  async call(_sessionId: string, tool: string, args: unknown): Promise<string> {
    this.calls.push({ tool, args })
    return this.handler(tool, args)
  }
}

/** O seam do modelo nos testes: respostas roteirizadas + o que ele recebeu. */
class ScriptedModel implements ChatModel {
  readonly script: (string | ((step: ModelStep) => string))[]
  readonly seen: ModelStep[] = []

  constructor(script: (string | ((step: ModelStep) => string))[]) {
    this.script = script
  }

  async complete(step: ModelStep): Promise<string> {
    this.seen.push(step)
    const next = this.script.shift()
    if (next === undefined) throw new Error('scriptedModel: roteiro esgotado')
    return typeof next === 'function' ? next(step) : next
  }
}

interface Rig {
  ctx: Context
  store: SqliteEventStore
  executor: SpyExecutor
  model: ScriptedModel
  loop: AgentLoopService
  runtime: ContextRuntimeService
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function buildRig(script: (string | ((step: ModelStep) => string))[], contextTokens?: number): Promise<Rig> {
  const store = SqliteEventStore.open(':memory:')
  cleanups.push(() => store.close())
  await store.createSession({ id: 's1', title: '', specialist: 'code' })
  const ctx = new Context()
  const executor = new SpyExecutor()
  new ActionGatewayService(ctx, {
    store,
    tools: executor,
    directory: fakeDirectory(),
    approvalTimeoutMs: 500,
  })
  const runtime = new ContextRuntimeService(ctx, {
    store,
    checkpoints: new MemoryCheckpointStore(),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  })
  const model = new ScriptedModel(script)
  const loop = new AgentLoopService(ctx, { store, model })
  return { ctx, store, executor, model, loop, runtime }
}

async function logOf(store: SqliteEventStore): Promise<Envelope[]> {
  return store.since('s1', 0, 500)
}

const FENCE = (body: string): string => '```aibot:tool\n' + body + '\n```'

/* ---------------------------------- testes --------------------------------- */

describe('o turno', () => {
  it('prompt → resposta: mensagens e done no log, checkpoint tirado', async () => {
    const rig = await buildRig(['Olá! Posso ajudar.'])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code', system: ['seja util'] })
    const created: unknown[] = []
    rig.ctx.on('checkpoint.created', (event) => created.push(event))

    const outcome = await agent.runTurn('oi')
    expect(outcome.answer).toBe('Olá! Posso ajudar.')
    expect(outcome.interrupted).toBe(false)

    const log = await logOf(rig.store)
    const kinds = log.map((envelope) => envelope.kind)
    expect(kinds.slice(0, 3)).toEqual(['message', 'message', 'done'])
    // checkpoint.created: no barramento E no log (payload de state com o campo novo).
    expect(created).toHaveLength(1)
    const mark = log.find(
      (envelope) => envelope.kind === 'state' &&
        (envelope.payload as Record<string, unknown>)['checkpointCreated'] !== undefined,
    )
    expect(mark).toBeDefined()
    // O system do agente NÃO vai ao log — instrução não é fala.
    expect(log.some((e) => JSON.stringify(e.payload ?? '').includes('seja util'))).toBe(false)
  })

  it('o working set do modelo tem system + prompt; o prompt não é duplicado', async () => {
    const rig = await buildRig([(step) => {
      const texts = step.messages.map((m) => m.content)
      expect(texts[0]).toBe('politica')
      // O prompt volta pelo histórico — UMA vez.
      expect(texts.filter((t) => t === 'qual o plano?')).toHaveLength(1)
      return 'plano traçado'
    }])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code', system: ['politica'] })
    const outcome = await agent.runTurn('qual o plano?')
    expect(outcome.answer).toBe('plano traçado')
  })
})

describe('ferramentas — NUNCA por fora do ctx.actionGateway', () => {
  it('a tool call passa pelo funil e o resultado PROJETADO volta ao contexto', async () => {
    const rig = await buildRig([
      'Vou ler o arquivo.\n' + FENCE('{"tool":"fs.read","args":{"path":"a.txt"}}'),
      (step) => {
        // O passo 2 vê a evidência projetada — o retorno da ferramenta voltou
        // ao contexto pelo LOG, não por canal lateral.
        const evidence = step.messages.find((m) => m.content.includes('fs.read =>'))
        expect(evidence).toBeDefined()
        expect(evidence!.role).toBe('user')
        expect(evidence!.content).toContain('CONTEUDO-42')
        return 'O arquivo diz CONTEUDO-42.'
      },
    ])
    rig.executor.handler = () => 'CONTEUDO-42'
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    const outcome = await agent.runTurn('leia a.txt')

    expect(outcome.toolCalls).toBe(1)
    expect(outcome.answer).toBe('O arquivo diz CONTEUDO-42.')
    // O executor foi tocado UMA vez — e só via gateway: o log tem o par
    // tool.call → tool.result que SÓ o funil grava.
    expect(rig.executor.calls).toEqual([{ tool: 'fs.read', args: { path: 'a.txt' } }])
    const kinds = (await logOf(rig.store)).map((envelope) => envelope.kind)
    const callAt = kinds.indexOf('tool.call')
    const resultAt = kinds.indexOf('tool.result')
    expect(callAt).toBeGreaterThan(-1)
    expect(resultAt).toBeGreaterThan(callAt)
  })

  it('teste-espelho: ferramenta fora do catálogo NÃO executa e a recusa volta ao modelo', async () => {
    const rig = await buildRig([
      FENCE('{"tool":"proc.run","args":{"command":"rm -rf"}}'),
      (step) => {
        const refusal = step.messages.find((m) => m.content.includes('proc.run =>'))
        expect(refusal).toBeDefined()
        expect(refusal!.content).toContain('falhou:')
        return 'Entendi, não posso executar processos.'
      },
    ])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    const outcome = await agent.runTurn('rode o build')
    // O efeito NUNCA aconteceu — o portão recusou dentro do funil.
    expect(rig.executor.calls).toHaveLength(0)
    expect(outcome.answer).toContain('não posso')
    // A recusa deixou o par de auditoria no log (tool.call + tool.result !ok).
    const log = await logOf(rig.store)
    const result = log.find((envelope) => envelope.kind === 'tool.result')
    expect((result!.payload as { ok: boolean }).ok).toBe(false)
  })

  it('JSON inválido no bloco volta ao modelo como evidência, sem executar nada', async () => {
    const rig = await buildRig([
      FENCE('{"tool": QUEBRADO'),
      (step) => {
        const feedback = step.messages.find((m) => m.content.includes('JSON inválido'))
        expect(feedback).toBeDefined()
        return 'Corrigido: não vou chamar nada.'
      },
    ])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    const outcome = await agent.runTurn('faça algo')
    expect(rig.executor.calls).toHaveLength(0)
    expect(outcome.toolCalls).toBe(0)
    expect(outcome.answer).toContain('Corrigido')
  })

  it('o teto de passos encerra DECLARADO (done interrupted no log)', async () => {
    const rig = await buildRig([
      FENCE('{"tool":"fs.list","args":{}}'),
      FENCE('{"tool":"fs.list","args":{}}'),
      FENCE('{"tool":"fs.list","args":{}}'),
    ])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code', maxSteps: 2 })
    const outcome = await agent.runTurn('liste tudo para sempre')
    expect(outcome.interrupted).toBe(true)
    expect(outcome.steps).toBe(2)
    const done = (await logOf(rig.store)).find((envelope) => envelope.kind === 'done')
    expect((done!.payload as { interrupted?: boolean }).interrupted).toBe(true)
  })

  it('integração leva 2: o catálogo vem do ctx.specialists REAL — fs.read do code executa, web.search é recusada no funil', async () => {
    // O kernel montado com os plugins reais das levas 1-2: SpecialistRegistry
    // (E5, ctx.specialists) fornece o catálogo compilado e o ActionGateway
    // (E4) é o funil — nenhum catálogo de teste no caminho.
    const store = SqliteEventStore.open(':memory:')
    cleanups.push(() => store.close())
    await store.createSession({ id: 's1', title: '', specialist: 'code' })
    const ctx = new Context()
    const registry = new SpecialistRegistry(ctx)
    const executor = new SpyExecutor()
    executor.handler = () => 'CONTEUDO-REAL'
    // O adapter Definition→SpecialistView é o MESMO papel que o host cumpre ao
    // ligar E5 no E4 — a decisão de catálogo continua 100% do registry real.
    const directory: SpecialistDirectory = {
      getOrDefault(id: string) {
        const definition = registry.getOrDefault(id)
        return {
          id: definition.id,
          name: definition.name,
          allowsTool: (tool: string) => registry.allowsTool(definition.id, tool),
        }
      },
    }
    new ActionGatewayService(ctx, { store, tools: executor, directory, approvalTimeoutMs: 500 })
    new ContextRuntimeService(ctx, { store, checkpoints: new MemoryCheckpointStore() })
    const model = new ScriptedModel([
      FENCE('{"tool":"fs.read","args":{"path":"a.txt"}}'),
      FENCE('{"tool":"web.search","args":{"q":"docs"}}'),
      (step) => {
        // A recusa do catálogo REAL voltou ao modelo como evidência.
        const refusal = step.messages.find((m) => m.content.includes('web.search =>'))
        expect(refusal).toBeDefined()
        expect(refusal!.content).toContain('falhou:')
        return 'Li o arquivo; pesquisa não é do meu ofício.'
      },
    ])
    const loop = new AgentLoopService(ctx, { store, model })
    const agent = loop.create({ sessionId: 's1', specialistId: 'code' })
    const outcome = await agent.runTurn('leia a.txt e pesquise a doc')
    // Só a ferramenta DO catálogo do code tocou o executor; a web.search do
    // chat morreu no portão sem efeito.
    expect(executor.calls).toEqual([{ tool: 'fs.read', args: { path: 'a.txt' } }])
    expect(outcome.answer).toContain('não é do meu ofício')
  })

  it('veto no waterfall agent/pre-step interrompe o turno sem chamar o modelo', async () => {
    const rig = await buildRig(['nunca chega aqui'])
    // Listener que NÃO chama next(): o veto do kernel.
    rig.ctx.on('agent/pre-step', () => undefined)
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    const outcome = await agent.runTurn('oi')
    expect(outcome.interrupted).toBe(true)
    expect(rig.model.seen).toHaveLength(0)
  })
})

describe('inbox: followup / steer / inject', () => {
  it('steer no meio do turno entra ANTES do próximo passo e fica no log', async () => {
    let agent!: ReturnType<AgentLoopService['create']>
    const rig = await buildRig([
      (step) => {
        // No meio do passo 1 a pessoa corrige o rumo (como se falasse durante
        // o stream) — o steer chega para o PASSO 2.
        agent.steer('na verdade use o arquivo b.txt')
        expect(step.messages.some((m) => m.content.includes('b.txt'))).toBe(false)
        return FENCE('{"tool":"fs.read","args":{"path":"a.txt"}}')
      },
      (step) => {
        expect(step.messages.some((m) => m.content.includes('na verdade use o arquivo b.txt'))).toBe(true)
        return 'Troquei para b.txt.'
      },
    ])
    agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    const outcome = await agent.runTurn('leia a.txt')
    expect(outcome.answer).toBe('Troquei para b.txt.')
    // O steer é fala da pessoa: vai ao LOG (o replay a mostra).
    const log = await logOf(rig.store)
    expect(log.some(
      (envelope) => envelope.kind === 'message' &&
        (envelope.payload as { text?: string }).text === 'na verdade use o arquivo b.txt',
    )).toBe(true)
  })

  it('inject entra UMA vez na montagem e NÃO vai ao log', async () => {
    const rig = await buildRig([
      (step) => {
        expect(step.messages.some((m) => m.content.includes('nota-de-processo'))).toBe(true)
        return FENCE('{"tool":"fs.list","args":{}}')
      },
      (step) => {
        // Uma vez só: a injeção não se repete no passo seguinte.
        expect(step.messages.some((m) => m.content.includes('nota-de-processo'))).toBe(false)
        return 'feito'
      },
    ])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    agent.inject('nota-de-processo: prefira caminhos relativos')
    await agent.runTurn('liste')
    const log = await logOf(rig.store)
    expect(log.some((envelope) => JSON.stringify(envelope.payload ?? '').includes('nota-de-processo'))).toBe(false)
  })

  it('followup vira o turno seguinte, na ordem', async () => {
    const rig = await buildRig(['resposta um', 'resposta dois'])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    const first = agent.runTurn('primeiro')
    const second = agent.followup('segundo')
    expect((await first).answer).toBe('resposta um')
    expect((await second).answer).toBe('resposta dois')
    const dones = (await logOf(rig.store)).filter((envelope) => envelope.kind === 'done')
    expect(dones).toHaveLength(2)
  })
})

describe('orçamento e compactação no turno', () => {
  it('prefire: a colagem grande compacta ANTES do modelo e anuncia nos dois canais', async () => {
    // Janela pequena: fitBudget = 1300 tokens; prefire ≈ 1105. A colagem de
    // ~6000 chars (~1500 tokens) cruza o prefire na primeira montagem.
    const rig = await buildRig([
      (step) => {
        // O modelo ainda recebe a pergunta — truncada com marca, nunca perdida.
        expect(step.messages.some((m) => m.content.includes('colagem-inicio'))).toBe(true)
        return 'analisado'
      },
    ], 2000)
    const compactions: { trigger: string }[] = []
    rig.ctx.on('context.compacted', (event) => compactions.push(event))

    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    const outcome = await agent.runTurn('colagem-inicio ' + 'log '.repeat(1500) + ' explique')
    expect(outcome.compacted).toBe(true)
    expect(compactions.some((event) => event.trigger === 'prefire' || event.trigger === 'hard')).toBe(true)
    // A marca durável no log (payload de state com o campo novo).
    const marks = (await logOf(rig.store)).filter(
      (envelope) => envelope.kind === 'state' &&
        (envelope.payload as Record<string, unknown>)['contextCompacted'] !== undefined,
    )
    expect(marks.length).toBeGreaterThan(0)
  })

  it('a cápsula da sessão dobra no fim do turno (fase) e o goal nasce do prompt', async () => {
    const rig = await buildRig(['ok'])
    const agent = rig.loop.create({ sessionId: 's1', specialistId: 'code' })
    await agent.runTurn('migre o schema de billing')
    const capsule = rig.runtime.capsuleOf('s1')
    expect(capsule.goal).toBe('migre o schema de billing')
    expect(capsule.cursor).toBeGreaterThan(0)
  })

  it('constraints do create entram na cápsula e sobrevivem à dobra', async () => {
    const rig = await buildRig(['ok'])
    const agent = rig.loop.create({
      sessionId: 's1', specialistId: 'code', constraints: ['nunca dar push'],
    })
    await agent.runTurn('oi')
    expect(rig.runtime.capsuleOf('s1').constraints).toContain('nunca dar push')
  })
})

describe('parse dos blocos cercados (porte do oráculo)', () => {
  it('extrai chamadas, guarda o cru e ignora bloco não fechado', () => {
    const calls = parseToolCalls(
      'texto ' + FENCE('{"tool":"fs.read","args":{"path":"x"}}') + ' meio ```aibot:tool\n{"tool":"cortado"',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tool).toBe('fs.read')
  })

  it('JSON quebrado vira chamada sem tool — o erro VOLTA para o modelo', () => {
    const calls = parseToolCalls(FENCE('{quebrado'))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tool).toBe('')
    expect(calls[0]!.raw).toBe('{quebrado')
  })

  it('stripToolBlocks tira os blocos do texto mostrado à pessoa', () => {
    expect(stripToolBlocks('antes ' + FENCE('{"tool":"x"}') + ' depois')).toBe('antes  depois'.trim())
    expect(stripToolBlocks(FENCE('{"tool":"x"}'))).toBe('')
  })
})
