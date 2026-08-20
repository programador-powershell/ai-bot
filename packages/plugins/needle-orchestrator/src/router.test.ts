/**
 * Bateria da cascata — porte caso a caso do router_test.go do oráculo, mais
 * os aceites E5: sticky sem NENHUM scorer chamado, `/mode` cortando no
 * primeiro whitespace, id inválido devolvendo o texto intacto, modo barrado
 * recusando com sinal SEM esvaziar o prompt, e a degradação dos degraus.
 *
 * Os textos-sonda são os do oráculo, com as mesmas guardas de cenário: sem a
 * guarda, recalibrar um radical faria os testes da cascata continuarem
 * passando exercitando o degrau errado.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { SpecialistRegistry, coerceDefinition, type Definition } from '@aibot2/specialist-registry'
import { MIN_CONFIDENCE, NEEDLE_MIN_CONFIDENCE, NEEDLE_TOOL_BUDGET } from './constants.js'
import { RouterService, shortlistFor, type RouterConfig } from './router.js'
import { score, type Scored } from './score.js'
import type { Classifier, OrchestratorModel, RouteQuery, RouteVerdict } from './seams.js'

/** Texto sem radical nenhum — exercita os degraus de quando o léxico cala. */
const NO_SIGNAL_TEXT = 'hmm'

/** Pontua "code" com folga: decide sozinho no degrau 1. */
const BUG_TEXT = 'corrige o bug de compilação'

/**
 * Tem opinião do léxico e mesmo assim NÃO decide: "seguranc" e "codig"
 * competem e a margem fica abaixo de MIN_MARGIN — é onde os degraus de IA
 * existem para entrar.
 */
const AMBIGUOUS_TEXT = 'revisa a segurança desse código'

/** Decide sozinho: "vulnerab" e "xss" só aparecem em pedido de segurança. */
const XSS_TEXT = 'revisa a vulnerabilidade de XSS'

/* ------------------------------ auxiliares ------------------------------ */

interface StubNeedleOptions {
  ready?: boolean
  verdict?: RouteVerdict
  error?: Error
}

/** O degrau 2 roteirizado, com contagem de chamadas. */
function stubNeedle(options: StubNeedleOptions = {}): OrchestratorModel & {
  calls: number
  lastPrompt: string
  lastIDs: string[]
} {
  return {
    calls: 0,
    lastPrompt: '',
    lastIDs: [],
    ready: () => options.ready ?? true,
    health: async () => ({ ok: options.ready ?? true }),
    async route(query: RouteQuery) {
      this.calls++
      this.lastPrompt = query.prompt
      this.lastIDs = query.candidates.map((candidate) => candidate.id)
      if (options.error !== undefined) throw options.error
      return options.verdict ?? { specialist: 'chat', confidence: 0 }
    },
    async orchestrate() {
      throw new Error('orchestrate não participa deste teste')
    },
  }
}

/** O degrau 3 roteirizado. */
function stubClassifier(verdict: RouteVerdict): Classifier & { calls: number; lastPrompt: string; lastIDs: string[] } {
  return {
    calls: 0,
    lastPrompt: '',
    lastIDs: [],
    async classify(prompt, candidates) {
      this.calls++
      this.lastPrompt = prompt
      this.lastIDs = candidates.map((candidate) => candidate.id)
      return verdict
    },
  }
}

/**
 * Degraus PROIBIDOS: reprovam o teste se consultados. `ready` também reprova
 * — só de perguntar se o Needle está pronto o roteador já mostrou que passou
 * do ponto em que a decisão devia ter saído.
 */
function forbiddenNeedle(fail: (message: string) => void): OrchestratorModel {
  return {
    ready: () => {
      fail('o roteador local foi consultado, mas a decisão já estava tomada sem ele')
      return false
    },
    health: async () => ({ ok: false }),
    route: async () => {
      fail('o roteador local classificou, mas a decisão já estava tomada sem ele')
      return { specialist: 'chat', confidence: 0 }
    },
    orchestrate: async () => undefined,
  }
}

function forbiddenClassifier(fail: (message: string) => void): Classifier {
  return {
    classify: async () => {
      fail('o classificador do modelo grande foi consultado, mas a decisão já estava tomada sem ele')
      return { specialist: 'chat', confidence: 0 }
    },
  }
}

function mount(config: RouterConfig = {}): { ctx: Context; registry: SpecialistRegistry; router: RouterService } {
  const ctx = new Context()
  ctx.plugin(SpecialistRegistry, {})
  ctx.plugin(RouterService, config)
  return { ctx, registry: ctx.specialists, router: ctx.router }
}

function requireNoLexicalSignal(registry: SpecialistRegistry, text: string): void {
  expect(score(text, registry.all()), `o texto "${text}" deveria estar sem sinal léxico`).toEqual([])
}

function requireUndecidedLexicon(registry: SpecialistRegistry, text: string): void {
  const scores = score(text, registry.all())
  expect(scores.length, `o cenário exige o léxico com opinião sobre "${text}"`).toBeGreaterThan(0)
  expect((scores[0] as Scored).confidence, `o cenário exige léxico indeciso para "${text}"`).toBeLessThan(MIN_CONFIDENCE)
}

/* ------------------------------ /mode ----------------------------------- */

describe('parseModeCommand', () => {
  const { router } = mount()

  it.each([
    ['comando sozinho', '/mode code', 'code', '', true],
    ['comando com o pedido na mesma linha', '/mode code corrige o login', 'code', 'corrige o login', true],
    // ACEITE E5: corta no primeiro WHITESPACE — Shift+Enter depois do id
    // mandava "office\ncorrige" como candidato e a troca não acontecia.
    ['quebra de linha depois do id', '/mode office\ncorrige o cabeçalho', 'office', 'corrige o cabeçalho', true],
    // ACEITE E5: id inválido devolve o texto INTACTO — engolir "/mode xpto"
    // em silêncio faria a pessoa achar que trocou de modo quando não trocou.
    ['modo inexistente não é comando', '/mode xpto', '', '/mode xpto', false],
    ['o master não é destino de /mode', '/mode master', '', '/mode master', false],
    ['texto sem /mode passa intacto', 'corrige o login', '', 'corrige o login', false],
    ['/mode sem argumento', '/mode', '', '/mode', false],
  ])('%s', (_name, input, wantMode, wantRest, wantOK) => {
    const parsed = router.parseModeCommand(input)
    expect(parsed.ok).toBe(wantOK)
    expect(parsed.mode).toBe(wantMode)
    expect(parsed.rest).toBe(wantRest)
  })
})

/* ------------------------------- rota ------------------------------------ */

describe('cascata', () => {
  it('escolha explícita vence o modo gravado, preservando previous e a superfície', async () => {
    const { router } = mount({ classifier: stubClassifier({ specialist: 'code', confidence: 1 }) })
    const route = await router.route({ text: XSS_TEXT, explicit: 'design', current: 'code' })
    expect(route.reason).toBe('explicit')
    expect(route.specialist).toBe('design')
    expect(route.confidence).toBe(1)
    expect(route.previous).toBe('code')
    expect(route.surface).toBe('canvas')
  })

  it('léxico decisivo não consulta NENHUM degrau de IA', async () => {
    const problems: string[] = []
    const { router } = mount({
      needle: forbiddenNeedle((m) => problems.push(m)),
      classifier: forbiddenClassifier((m) => problems.push(m)),
    })
    const route = await router.route({ text: XSS_TEXT })
    expect(problems).toEqual([])
    expect(route.reason).toBe('heuristic')
    expect(route.specialist).toBe('security')
    expect(route.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE)
    expect(route.signals.length).toBeGreaterThan(0)
  })

  it('ACEITE E5: sticky sai antes de qualquer pontuação — nenhum scorer é chamado', async () => {
    const problems: string[] = []
    let scorerCalls = 0
    const { registry, router } = mount({
      needle: forbiddenNeedle((m) => problems.push(m)),
      classifier: forbiddenClassifier((m) => problems.push(m)),
      scoreFn: (text, candidates, lookup) => {
        scorerCalls++
        return score(text, candidates, lookup)
      },
    })
    requireNoLexicalSignal(registry, NO_SIGNAL_TEXT)

    // O caso que prova a regra: sinal léxico FORTE de outro especialista não
    // arranca a conversa do modo gravado.
    for (const text of [NO_SIGNAL_TEXT, XSS_TEXT]) {
      const route = await router.route({ text, current: 'data' })
      expect(route.reason).toBe('sticky')
      expect(route.specialist).toBe('data')
      expect(route.previous).toBe('data')
      expect(route.confidence).toBe(1)
      expect(route.signals).toEqual([])
      expect(route.surface).toBe('schema')
    }
    expect(scorerCalls).toBe(0)
    expect(problems).toEqual([])
  })

  it('/mode vence o modo gravado e o seletor, sem perguntar a ninguém', async () => {
    const problems: string[] = []
    const command = '/mode security revisa isso aqui'
    const { router } = mount({
      needle: forbiddenNeedle((m) => problems.push(m)),
      classifier: forbiddenClassifier((m) => problems.push(m)),
    })
    for (const input of [
      { text: command, current: 'data' },
      { text: command, explicit: 'design' },
      { text: command, current: 'data', explicit: 'design' },
    ]) {
      const route = await router.route(input)
      expect(route.reason).toBe('explicit')
      expect(route.specialist).toBe('security')
      expect(route.confidence).toBe(1)
      // Previous carrega o modo ANTERIOR — é a faixa "agora é X" da interface.
      expect(route.previous).toBe(input.current ?? '')
      expect(route.surface).toBe('findings')
    }
    expect(problems).toEqual([])
  })

  it('ACEITE E5: modo barrado recusa com sinal e NÃO esvazia o prompt', async () => {
    // Com dono: a conversa fica onde está, com o motivo visível.
    const sticky = mount({})
    const route = await sticky.router.route({
      text: '/mode security revisa isso aqui',
      current: 'data',
      allowed: ['chat', 'code', 'data'],
    })
    expect(route.reason).toBe('sticky')
    expect(route.specialist).toBe('data')
    expect(route.signals).toEqual(['modo security bloqueado pela política desta sessão'])

    // Sem dono e com pedido junto: a cascata decide pelo CONTEÚDO — o degrau
    // do modelo recebe "revisa isso aqui", não uma string vazia.
    const classifier = stubClassifier({ specialist: 'code', confidence: 0.8 })
    const loose = mount({ classifier })
    const decided = await loose.router.route({
      text: '/mode security revisa isso aqui',
      allowed: ['chat', 'code', 'data'],
    })
    expect(classifier.calls).toBe(1)
    expect(classifier.lastPrompt).toBe('revisa isso aqui')
    expect(decided.reason).toBe('model')
    expect(decided.specialist).toBe('code')

    // Sem dono e SEM pedido junto: não há o que classificar — padrão com sinal.
    const empty = mount({})
    const bare = await empty.router.route({ text: '/mode security', allowed: ['chat', 'code'] })
    expect(bare.reason).toBe('fallback')
    expect(bare.specialist).toBe('chat')
    expect(bare.signals).toEqual(['modo security bloqueado pela política desta sessão'])
  })

  it('degrau 2: aceita o veredito do Needle no limiar (>=), sem consultar o modelo grande', async () => {
    const problems: string[] = []
    // O limiar entra na lista: `>=` é a regra — trocar por `>` passaria em
    // qualquer teste que só usasse 0.9.
    for (const reported of [NEEDLE_MIN_CONFIDENCE, 0.9, 1]) {
      const needle = stubNeedle({ verdict: { specialist: 'work', confidence: reported } })
      const { registry, router } = mount({ needle, classifier: forbiddenClassifier((m) => problems.push(m)) })
      requireUndecidedLexicon(registry, AMBIGUOUS_TEXT)

      const route = await router.route({ text: AMBIGUOUS_TEXT })
      expect(needle.calls).toBe(1)
      expect(needle.lastPrompt).toBe(AMBIGUOUS_TEXT)
      expect(route.reason).toBe('needle')
      expect(route.specialist).toBe('work')
      expect(route.confidence).toBe(reported)
      expect(route.surface).toBe('board')
    }
    expect(problems).toEqual([])
  })

  it('degrau 2: o Needle recebe no máximo o orçamento de 5, com o mais pontuado na frente', async () => {
    const needle = stubNeedle({ verdict: { specialist: 'work', confidence: 0.9 } })
    const { registry, router } = mount({ needle })
    requireUndecidedLexicon(registry, AMBIGUOUS_TEXT)
    expect(registry.all().length).toBeGreaterThan(NEEDLE_TOOL_BUDGET)

    await router.route({ text: AMBIGUOUS_TEXT })
    expect(needle.lastIDs.length).toBe(NEEDLE_TOOL_BUDGET)
    const scores = score(AMBIGUOUS_TEXT, registry.all())
    expect(needle.lastIDs[0]).toBe((scores[0] as Scored).id)
    expect(new Set(needle.lastIDs).size).toBe(needle.lastIDs.length)
  })

  it('degrau 2: veredito abaixo do limiar sobe para o modelo grande', async () => {
    for (const reported of [0, 0.4, NEEDLE_MIN_CONFIDENCE - 0.01]) {
      const needle = stubNeedle({ verdict: { specialist: 'work', confidence: reported } })
      const classifier = stubClassifier({ specialist: 'data', confidence: 0.8 })
      const { registry, router } = mount({ needle, classifier })
      requireUndecidedLexicon(registry, AMBIGUOUS_TEXT)

      const route = await router.route({ text: AMBIGUOUS_TEXT })
      expect(needle.calls).toBe(1)
      expect(classifier.calls).toBe(1)
      expect(route.reason).toBe('model')
      expect(route.specialist).toBe('data')
    }
  })

  it('degrau 2: veredito fora da política é descartado e a decisão segue', async () => {
    const needle = stubNeedle({ verdict: { specialist: 'security', confidence: 0.99 } })
    const classifier = stubClassifier({ specialist: 'code', confidence: 0.8 })
    const { router } = mount({ needle, classifier })

    const route = await router.route({ text: AMBIGUOUS_TEXT, allowed: ['chat', 'code'] })
    expect(route.specialist).toBe('code')
    expect(route.reason).toBe('model')
  })

  it('degrau 2: Needle não-pronto é PULADO (nem classifica), a cascata encurta', async () => {
    const needle = stubNeedle({ ready: false, verdict: { specialist: 'work', confidence: 1 } })
    const classifier = stubClassifier({ specialist: 'data', confidence: 0.8 })
    const { registry, router } = mount({ needle, classifier })
    requireUndecidedLexicon(registry, AMBIGUOUS_TEXT)

    const route = await router.route({ text: AMBIGUOUS_TEXT })
    expect(needle.calls).toBe(0)
    expect(route.reason).toBe('model')
    expect(route.specialist).toBe('data')
  })

  it('degrau 2: erro do Needle não derruba o turno — sobe para o modelo grande', async () => {
    const needle = stubNeedle({ error: new Error('a biblioteca nativa não respondeu') })
    const classifier = stubClassifier({ specialist: 'data', confidence: 0.8 })
    const { router } = mount({ needle, classifier })

    const route = await router.route({ text: AMBIGUOUS_TEXT })
    expect(needle.calls).toBe(1)
    expect(route.reason).toBe('model')
    expect(route.specialist).toBe('data')
  })

  it('degrau 2: veredito fraco sem modelo grande cai no PADRÃO, não no veredito fraco', async () => {
    const needle = stubNeedle({ verdict: { specialist: 'work', confidence: 0.3 } })
    const { router } = mount({ needle })
    const route = await router.route({ text: AMBIGUOUS_TEXT })
    expect(route.reason).toBe('fallback')
    expect(route.specialist).toBe('chat')
  })

  it('degrau 3: o modelo grande decide quando o léxico não pode, com todos os candidatos', async () => {
    const classifier = stubClassifier({ specialist: 'work', confidence: 0.8 })
    const { registry, router } = mount({ classifier })
    requireUndecidedLexicon(registry, AMBIGUOUS_TEXT)

    const route = await router.route({ text: AMBIGUOUS_TEXT })
    expect(classifier.calls).toBe(1)
    expect(classifier.lastPrompt).toBe(AMBIGUOUS_TEXT)
    expect(classifier.lastIDs.length).toBe(registry.all().length)
    expect(route.reason).toBe('model')
    expect(route.specialist).toBe('work')
    expect(route.confidence).toBe(0.8)
  })

  it('degrau 3: confiança fora de [0,1] vira desconfiança no número, não erro', async () => {
    const { registry } = mount({})
    requireNoLexicalSignal(registry, NO_SIGNAL_TEXT)
    for (const reported of [0, -1, 1.5]) {
      const { router } = mount({ classifier: stubClassifier({ specialist: 'data', confidence: reported }) })
      const route = await router.route({ text: NO_SIGNAL_TEXT })
      expect(route.reason).toBe('model')
      expect(route.confidence).toBe(MIN_CONFIDENCE)
    }
  })

  it('sem sinal, sem modo e sem classificador: fallback para o chat com 0.25', async () => {
    const { registry, router } = mount({})
    requireNoLexicalSignal(registry, NO_SIGNAL_TEXT)
    const route = await router.route({ text: NO_SIGNAL_TEXT })
    expect(route.reason).toBe('fallback')
    expect(route.specialist).toBe('chat')
    expect(route.confidence).toBe(0.25)
    expect(route.surface).toBe('conversation')
  })

  it('toda rota sai com a superfície do especialista decidido', async () => {
    const { registry, router } = mount({ classifier: stubClassifier({ specialist: 'work', confidence: 0.8 }) })
    const inputs = [
      { text: NO_SIGNAL_TEXT, explicit: 'office' },
      { text: '/mode tune' },
      { text: XSS_TEXT },
      { text: NO_SIGNAL_TEXT },
      { text: NO_SIGNAL_TEXT, current: 'fluxo' },
      { text: NO_SIGNAL_TEXT, explicit: 'nao-existe' },
      { text: XSS_TEXT, allowed: ['nao-existe'] },
    ]
    for (const input of inputs) {
      const route = await router.route(input)
      expect(route.specialist).not.toBe('')
      expect(route.surface).toBe(registry.getOrDefault(route.specialist).surface)
    }
  })

  it('a lista permitida vale para TODOS os degraus', async () => {
    // O léxico não escolhe quem está fora da lista.
    const lexical = await mount({}).router.route({ text: XSS_TEXT, allowed: ['chat', 'office'] })
    expect(lexical.specialist).toBe('chat')

    // Escolha explícita fora da lista é ignorada.
    const explicit = await mount({}).router.route({ text: NO_SIGNAL_TEXT, explicit: 'security', allowed: ['chat', 'code'] })
    expect(explicit.specialist).not.toBe('security')
    expect(explicit.reason).toBe('fallback')

    // Sticky não ressuscita quem saiu da lista.
    const sticky = await mount({}).router.route({ text: NO_SIGNAL_TEXT, current: 'security', allowed: ['chat', 'code'] })
    expect(sticky.specialist).not.toBe('security')
    expect(sticky.reason).toBe('fallback')

    // Veredito do modelo fora da lista é ignorado.
    const model = await mount({ classifier: stubClassifier({ specialist: 'security', confidence: 0.99 }) })
      .router.route({ text: NO_SIGNAL_TEXT, allowed: ['chat', 'code'] })
    expect(model.specialist).not.toBe('security')
    expect(model.reason).toBe('fallback')

    // Sem o padrão na lista cai no primeiro permitido, na ordem do catálogo.
    const first = await mount({}).router.route({ text: NO_SIGNAL_TEXT, allowed: ['office', 'data'] })
    expect(first.specialist).toBe('office')
    expect(first.surface).toBe('document')
  })
})

/* ------------------------------ shortlist -------------------------------- */

describe('shortlistFor', () => {
  const { registry } = mount({})
  const candidates = registry.all()

  it('os mais pontuados vêm primeiro, sem repetição', () => {
    const scores = score(XSS_TEXT, candidates)
    expect(scores.length).toBeGreaterThan(0)
    const shortlist = shortlistFor(scores, candidates, NEEDLE_TOOL_BUDGET)
    expect(shortlist.length).toBe(NEEDLE_TOOL_BUDGET)
    for (const [index, scored] of scores.entries()) {
      if (index >= shortlist.length) break
      expect((shortlist[index] as Definition).id).toBe(scored.id)
    }
    expect(new Set(shortlist.map((definition) => definition.id)).size).toBe(shortlist.length)
  })

  it('completa com a ordem FIXA do catálogo quando o léxico não pontuou ninguém', () => {
    const shortlist = shortlistFor([], candidates, NEEDLE_TOOL_BUDGET)
    expect(shortlist.length).toBe(NEEDLE_TOOL_BUDGET)
    for (const [index, definition] of shortlist.entries()) {
      expect(definition.id).toBe((candidates[index] as Definition).id)
    }
  })

  it('orçamento a partir do tamanho do catálogo devolve todo mundo', () => {
    for (const limit of [candidates.length, candidates.length + 1, 0, -1]) {
      expect(shortlistFor([], candidates, limit).length).toBe(candidates.length)
    }
  })
})

/* ------------------------- desempate e overlay --------------------------- */

describe('score: propriedades que o golden não fixa', () => {
  it('empate de confiança desempata por id — margem não vira sorteio', () => {
    const tied = [
      coerceDefinition({ id: 'zeta', surface: 'conversation', triggers: ['alvo'] }),
      coerceDefinition({ id: 'alpha', surface: 'conversation', triggers: ['alvo'] }),
    ]
    const scores = score('o alvo do teste', tied)
    expect(scores.length).toBe(2)
    expect((scores[0] as Scored).confidence).toBe((scores[1] as Scored).confidence)
    expect(scores.map((s) => s.id)).toEqual(['alpha', 'zeta'])
  })

  it('é determinístico em 50 execuções', () => {
    const { registry } = mount({})
    const text = 'revisa a segurança do código e o schema do banco'
    const first = JSON.stringify(score(text, registry.all()))
    for (let round = 0; round < 50; round++) {
      expect(JSON.stringify(score(text, registry.all()))).toBe(first)
    }
  })
})

describe('onChange do registro alimenta o cache do roteador', () => {
  it('overlay publicado troca os radicais que o Score usa — e o reset devolve', async () => {
    const { registry, router } = mount({})
    const overlay = {
      schemaVersion: 1,
      version: '0.5.0',
      specialists: [
        {
          id: 'chat',
          name: 'Conversa',
          surface: 'conversation',
          rail: 'conversations',
          system: 'prompt',
          avatar: { seed: 1, shape: 'orb', eyes: 'dot', mouth: 'none', accessory: 'none', motion: 'idle', hue: 100, saturation: 50 },
        },
        {
          id: 'jurido',
          name: 'Jurídico',
          surface: 'document',
          rail: 'document',
          system: 'prompt',
          triggers: ['parecer juridico', 'clausula'],
          avatar: { seed: 2, shape: 'chip', eyes: 'arc', mouth: 'line', accessory: 'none', motion: 'idle', hue: 30, saturation: 50 },
        },
      ],
    }
    registry.loadOverlay(JSON.stringify(overlay))

    // O radical NOVO decide — o cache foi reconstruído no gancho.
    const published = await router.route({ text: 'preciso de um parecer jurídico dessa cláusula' })
    expect(published.specialist).toBe('jurido')
    expect(published.surface).toBe('document')

    // E o compilado voltou a valer depois do reset: o id publicado sumiu.
    registry.resetOverlay()
    const reset = await router.route({ text: 'preciso de um parecer jurídico dessa cláusula' })
    expect(reset.specialist).not.toBe('jurido')
  })

  it('o gancho morre com o plugin: unload do roteador não deixa cache órfão', async () => {
    const ctx = new Context()
    ctx.plugin(SpecialistRegistry, {})
    const handle = ctx.plugin(RouterService, {})
    await handle.dispose()
    // Trocar o catálogo depois do unload não pode estourar tentando
    // reconstruir o cache de um roteador que já morreu.
    expect(() => ctx.specialists.resetOverlay()).not.toThrow()
    expect(ctx.get('router')).toBeUndefined()
  })
})

/* ------------------------------ elenco ----------------------------------- */

describe('elenco (cast) nas bordas que o golden não cobre', () => {
  it('a política da sessão filtra o elenco — promessa que o portão quebraria não entra', async () => {
    const full = await mount({}).router.route({ text: 'crie uma aplicação em next.js completa' })
    expect(full.standby.map((s) => s.specialist)).toContain('design')

    const filtered = await mount({}).router.route({
      text: 'crie uma aplicação em next.js completa',
      allowed: ['chat', 'code', 'security'],
    })
    expect(filtered.standby.map((s) => s.specialist)).not.toContain('design')
  })

  it('conversa com dono não recalcula o elenco', async () => {
    const route = await mount({}).router.route({ text: 'crie uma aplicação em next.js completa', current: 'code' })
    expect(route.reason).toBe('sticky')
    expect(route.standby).toEqual([])
  })
})
