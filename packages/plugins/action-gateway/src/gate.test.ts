/**
 * A bateria do permissions_test do oráculo Go traduzida caso a caso (aceite
 * E4), mais o que o E4 ACRESCENTOU ao porte: a política declarada que é LIDA
 * (a memória da casa "política declarada e não lida"), a política ilegível
 * que recusa tudo e o fail-closed do modo "aprovar tudo" para ferramenta não
 * classificada.
 */

import { describe, expect, it } from 'vitest'
import type { Risk } from '@aibot2/domain-events'
import {
  Gate,
  PolicyUnreadableError,
  approvalScope,
  defaultPolicy,
  describeDecision,
  digestOf,
  hostBlocked,
  parsePolicy,
  riskOf,
  riskTableKnows,
  type Decision,
  type Policy,
  type SpecialistDirectory,
} from './gate.js'

/* ------------------------------ auxiliares ------------------------------ */

/** O catálogo dos testes — a forma do specialist.GetOrDefault do oráculo. */
const CATALOGO: Record<string, readonly string[]> = {
  chat: ['fs.read', 'memory.read', 'memory.write', 'web.search', 'web.fetch', 'context.fetch'],
  code: [
    'fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.patch',
    'git.status', 'git.diff', 'git.commit', 'proc.run', 'context.fetch', 'flow.validate',
  ],
  design: ['fs.write', 'design.replicate', 'image.generate'],
  office: ['office.open', 'office.edit'],
  work: ['webhook.post', 'schedule.create', 'schedule.list'],
  security: ['secrets.scan', 'osv.query'],
}

/** getOrDefault NUNCA falha por id desconhecido — cai no padrão (chat). */
function fakeDirectory(): SpecialistDirectory {
  return {
    getOrDefault(id: string) {
      const tools = CATALOGO[id] ?? CATALOGO['chat']!
      return { id, name: id || 'chat', allowsTool: (tool: string) => tools.includes(tool) }
    },
  }
}

function editsGate(overrides?: Partial<Policy>): Gate {
  const policy = defaultPolicy()
  expect(policy.mode).toBe('edits')
  expect(policy.agentTools).toBe(true)
  return new Gate({ ...policy, ...overrides }, fakeDirectory())
}

/** Confere o veredito e devolve o motivo — que nunca pode ser vazio. */
function assertDecision(
  gate: Gate,
  specialistId: string,
  tool: string,
  risk: Risk,
  digest: string,
  want: Decision,
): string {
  const verdict = gate.evaluate(specialistId, tool, risk, digest)
  expect(verdict.decision, `${specialistId}/${tool} (motivo: ${verdict.reason})`).toBe(want)
  expect(verdict.reason.trim()).not.toBe('')
  return verdict.reason
}

/* ----------------------------- hostBlocked ------------------------------ */

describe('hostBlocked respeita a fronteira de rótulo (porte 1:1)', () => {
  const cases: [string, string[] | undefined, string, string, boolean][] = [
    ['apex exato', ['exemplo.com'], 'exemplo.com', 'exemplo.com', true],
    ['subdomínio', ['exemplo.com'], 'a.exemplo.com', 'exemplo.com', true],
    ['subdomínio profundo', ['exemplo.com'], 'b.a.exemplo.com', 'exemplo.com', true],
    ['domínio parecido não casa', ['exemplo.com'], 'malexemplo.com', '', false],
    ['curinga pega o subdomínio', ['*.exemplo.com'], 'a.exemplo.com', '*.exemplo.com', true],
    ['curinga não pega o apex', ['*.exemplo.com'], 'exemplo.com', '', false],
    ['curinga sozinho não bloqueia nada', ['*.'], 'exemplo.com', '', false],
    ['host com porta', ['exemplo.com'], 'exemplo.com:8443', 'exemplo.com', true],
    ['host com ponto final', ['exemplo.com'], 'exemplo.com.', 'exemplo.com', true],
    ['host com ponto final e porta', ['exemplo.com'], 'exemplo.com.:8080', 'exemplo.com', true],
    ['regra em maiúsculas volta minúscula', ['EXEMPLO.COM'], 'a.exemplo.com', 'exemplo.com', true],
    ['regra com espaço em volta', ['  exemplo.com  '], 'exemplo.com', 'exemplo.com', true],
    ['ipv6 entre colchetes', ['[::1]'], '[::1]', '[::1]', true],
    ['lista vazia', undefined, 'exemplo.com', '', false],
    ['host vazio', ['exemplo.com'], '', '', false],
    ['primeira regra que casa é a devolvida', ['outra.com', 'exemplo.com'], 'a.exemplo.com', 'exemplo.com', true],
  ]
  for (const [name, rules, host, wantRule, wantHit] of cases) {
    it(name, () => {
      const [rule, hit] = hostBlocked(rules, host)
      expect(hit).toBe(wantHit)
      expect(rule).toBe(wantRule)
    })
  }
})

/* -------------------------------- riskOf -------------------------------- */

describe('riskOf classifica todas as famílias', () => {
  const cases: [string, Risk][] = [
    ['fs.read', 'read'], ['fs.list', 'read'], ['git.diff', 'read'], ['web.fetch', 'read'],
    ['fs.write', 'write'], ['fs.patch', 'write'], ['git.commit', 'write'], ['image.generate', 'write'],
    ['proc.run', 'execute'], ['term.open', 'execute'], ['task.dispatch', 'execute'],
    ['webhook.post', 'network'], ['mcp.call', 'network'], ['schedule.create', 'network'],
    ['secrets.scan', 'secret'],
    ['FS.READ', 'read'], ['  fs.read  ', 'read'],
  ]
  for (const [tool, want] of cases) {
    it(`${JSON.stringify(tool)} → ${want}`, () => {
      expect(riskOf(tool)).toBe(want)
    })
  }

  it('ferramenta desconhecida cai em execute — o mais restritivo', () => {
    for (const tool of ['', 'ferramenta.que.ninguem.classificou', 'mcp.externo/qualquer']) {
      expect(riskOf(tool)).toBe('execute')
      expect(riskTableKnows(tool)).toBe(false)
    }
  })
})

/* --------------------------- describeDecision ---------------------------- */

it('veredito esquecido nunca é allow (o espelho do zero de Decision)', () => {
  // Em Go o zero do tipo virava "desconhecida"; aqui o análogo é undefined,
  // null ou lixo — nenhum deles compara igual a "allow".
  expect(describeDecision(undefined)).toBe('desconhecida')
  expect(describeDecision(null)).toBe('desconhecida')
  expect(describeDecision(0)).toBe('desconhecida')
  expect(describeDecision('allow')).toBe('allow')
  expect(describeDecision('deny')).toBe('deny')
  expect(describeDecision('ask')).toBe('ask')
})

/* -------------------------------- evaluate ------------------------------- */

describe('evaluate', () => {
  it('recusa ferramenta da lista de recusa — antes de tudo, inclusive de aprovar tudo', () => {
    const gate = editsGate({ deniedTools: ['proc.run'] })
    const reason = assertDecision(gate, 'code', 'proc.run', 'execute', '', 'deny')
    expect(reason).toContain('proc.run')

    gate.setPolicy({ ...defaultPolicy(), mode: 'all', deniedTools: ['proc.run'] })
    assertDecision(gate, 'code', 'proc.run', 'execute', '', 'deny')

    // E não é sensível a caixa: a lista é escrita por gente.
    gate.setPolicy({ ...defaultPolicy(), deniedTools: ['PROC.RUN'] })
    assertDecision(gate, 'code', 'proc.run', 'execute', '', 'deny')
  })

  it('interruptor geral desligado recusa tudo — nem leitura passa', () => {
    const gate = editsGate({ agentTools: false })
    assertDecision(gate, 'code', 'fs.read', 'read', '', 'deny')
    assertDecision(gate, 'code', 'fs.write', 'write', '', 'deny')
  })

  it('recusa ferramenta fora do catálogo do especialista', () => {
    const gate = editsGate()
    // "chat" lê arquivo, mas não roda processo.
    const reason = assertDecision(gate, 'chat', 'proc.run', 'execute', '', 'deny')
    expect(reason).toContain('proc.run')
    assertDecision(gate, 'office', 'fs.write', 'write', '', 'deny')
    // O mesmo pedido com o especialista certo não é recusado.
    assertDecision(gate, 'code', 'proc.run', 'execute', '', 'ask')
  })

  it('recusa especialista fora da política; lista vazia é "todos"', () => {
    const gate = editsGate({ allowedSpecialists: ['chat'] })
    const reason = assertDecision(gate, 'code', 'fs.write', 'write', '', 'deny')
    expect(reason).toContain('code')
    expect(gate.allowsSpecialist('code')).toBe(false)
    expect(gate.allowsSpecialist('chat')).toBe(true)

    expect(editsGate().allowsSpecialist('code')).toBe(true)
  })

  it('modo edits libera leitura e pergunta no que altera, executa ou toca segredo', () => {
    const gate = editsGate()
    const cases: [string, string, Risk, Decision][] = [
      ['code', 'fs.read', 'read', 'allow'],
      ['code', 'git.diff', 'read', 'allow'],
      ['work', 'webhook.post', 'network', 'allow'],
      ['code', 'fs.write', 'write', 'ask'],
      ['code', 'fs.patch', 'write', 'ask'],
      ['code', 'proc.run', 'execute', 'ask'],
      ['security', 'secrets.scan', 'secret', 'ask'],
    ]
    for (const [specialist, tool, risk, want] of cases) {
      assertDecision(gate, specialist, tool, risk, '', want)
    }
  })

  it('modo ask pergunta até em leitura; modo desconhecido é tratado como ask', () => {
    const gate = editsGate()
    gate.setPolicy({ ...defaultPolicy(), mode: 'ask' })
    assertDecision(gate, 'code', 'fs.read', 'read', '', 'ask')

    gate.setPolicy({ ...defaultPolicy(), mode: 'modo-que-ninguem-conhece' })
    const reason = assertDecision(gate, 'code', 'fs.read', 'read', '', 'ask')
    expect(reason).toContain('desconhecida')

    gate.setPolicy({ ...defaultPolicy(), mode: 'all' })
    assertDecision(gate, 'code', 'proc.run', 'execute', '', 'allow')
  })

  it('aceite E4: ferramenta não classificada pergunta MESMO no modo aprovar tudo', () => {
    const gate = editsGate({ mode: 'all' })
    // O catálogo do code não a tem — usa um catálogo de teste que a inclua.
    const directory: SpecialistDirectory = {
      getOrDefault: (id) => ({ id, name: id, allowsTool: () => true }),
    }
    const aberto = new Gate({ ...defaultPolicy(), mode: 'all' }, directory)
    const reason = assertDecision(aberto, 'code', 'ferramenta.nova', 'execute', '', 'ask')
    expect(reason).toContain('não está classificada')
    // Enquanto a classificada continua liberada.
    assertDecision(gate, 'code', 'proc.run', 'execute', '', 'allow')
  })
})

/* --------------------------------- grant --------------------------------- */

describe('grant', () => {
  it('digest destrava só os MESMOS argumentos — o "sim" não vira cheque em branco', () => {
    const gate = editsGate()
    const tool = 'fs.write'
    const digest = 'aprovado0001'
    const other = 'outrodigest2'

    assertDecision(gate, 'code', tool, 'write', digest, 'ask')
    gate.grant('digest', 'code', tool, digest)

    const reason = assertDecision(gate, 'code', tool, 'write', digest, 'allow')
    expect(reason).toContain('mesmos argumentos')

    assertDecision(gate, 'code', tool, 'write', other, 'ask')
    assertDecision(gate, 'code', tool, 'write', '', 'ask')
    // Nem para outra ferramenta com o mesmo digest.
    assertDecision(gate, 'code', 'fs.patch', 'write', digest, 'ask')
  })

  it('ignora escopos que alargariam o sim (once, digest vazio, escopo desconhecido, ferramenta vazia)', () => {
    const gate = editsGate()
    const digest = 'aprovado0001'

    gate.grant('once', 'code', 'fs.write', digest)
    assertDecision(gate, 'code', 'fs.write', 'write', digest, 'ask')

    gate.grant('digest', 'code', 'fs.write', '   ')
    assertDecision(gate, 'code', 'fs.write', 'write', digest, 'ask')

    gate.grant('para-sempre', 'code', 'fs.write', digest)
    assertDecision(gate, 'code', 'fs.write', 'write', digest, 'ask')

    gate.grant('session', 'code', '   ', digest)
    expect(gate.granted()).toEqual([])
  })

  it('escopo session é mais largo e revoke apaga tudo', () => {
    const gate = editsGate()
    const tool = 'fs.write'

    gate.grant('session', 'code', tool, '')
    const reason = assertDecision(gate, 'code', tool, 'write', 'qualquer-digest', 'allow')
    expect(reason).toContain('nesta sessão')

    gate.grant('digest', 'code', 'fs.patch', 'aprovado0001')
    expect(gate.granted()).toHaveLength(2)

    gate.revoke()
    assertDecision(gate, 'code', tool, 'write', 'qualquer-digest', 'ask')
    assertDecision(gate, 'code', 'fs.patch', 'write', 'aprovado0001', 'ask')
    expect(gate.granted()).toEqual([])
  })

  it('aceite E4: concessão de sessão não atravessa especialista', () => {
    const gate = editsGate()
    gate.grant('session', 'code', 'fs.write', '')
    // Quem recebeu passa.
    assertDecision(gate, 'code', 'fs.write', 'write', 'qualquer', 'allow')
    // Quem NÃO recebeu continua perguntando, mesmo com a ferramenta no catálogo.
    assertDecision(gate, 'design', 'fs.write', 'write', 'qualquer', 'ask')
  })
})

/* --------------------------------- policy -------------------------------- */

describe('policy', () => {
  it('policy() devolve cópia — a lista de recusa não se reescreve por fora', () => {
    const gate = editsGate({ deniedTools: ['proc.run'] })
    const copied = gate.policy()
    copied.deniedTools![0] = 'fs.read'

    assertDecision(gate, 'code', 'proc.run', 'execute', '', 'deny')
    assertDecision(gate, 'code', 'fs.read', 'read', '', 'allow')
  })

  it('allowedModels: lista vazia continua vazia (nenhum) e ausente continua ausente (todos)', () => {
    const gate = new Gate({ ...defaultPolicy(), allowedModels: [] }, fakeDirectory())
    const got = gate.policy()
    expect(got.allowedModels).not.toBeUndefined()
    expect(got.allowedModels).toHaveLength(0)

    const aberta = editsGate().policy()
    expect(aberta.allowedModels).toBeUndefined()
  })

  it('allowedModels: a cópia isola a lista', () => {
    const gate = new Gate({ ...defaultPolicy(), allowedModels: ['gpt-5'] }, fakeDirectory())
    const copied = gate.policy()
    copied.allowedModels![0] = 'qualquer-um'
    expect(gate.policy().allowedModels![0]).toBe('gpt-5')
  })
})

/* ---------------- política declarada: lida ou recusa alta ---------------- */

describe('parsePolicy — campo declarado é LIDO; inválido derruba a política inteira', () => {
  it('campos ausentes caem no padrão', () => {
    const policy = parsePolicy({})
    expect(policy).toEqual(defaultPolicy())
  })

  it('campo presente e inválido é PolicyUnreadableError, nunca default silencioso', () => {
    const invalidas: unknown[] = [
      null,
      'texto',
      [],
      { mode: 42 },
      { mode: '' },
      { agentTools: 'sim' },
      { maxDepth: -1 },
      { maxTotal: 2.5 },
      { deniedTools: 'proc.run' },
      { allowedModels: [42] },
      { toolRules: ['fs.read'] },
      { toolRules: { 'fs.read': 'liberar' } },
    ]
    for (const raw of invalidas) {
      expect(() => parsePolicy(raw), JSON.stringify(raw)).toThrowError(PolicyUnreadableError)
    }
  })

  it('campos declarados válidos entram inteiros', () => {
    const policy = parsePolicy({
      mode: 'all',
      agentTools: true,
      maxDepth: 2,
      deniedTools: ['webhook.post'],
      allowedModels: [],
      toolRules: { 'fs.read': 'deny', 'code:fs.write': 'allow' },
    })
    expect(policy.mode).toBe('all')
    expect(policy.maxDepth).toBe(2)
    expect(policy.deniedTools).toEqual(['webhook.post'])
    expect(policy.allowedModels).toEqual([])
    expect(policy.toolRules).toEqual({ 'fs.read': 'deny', 'code:fs.write': 'allow' })
  })
})

describe('Gate.loadPolicy — o teste-prova da memória "política declarada e não lida"', () => {
  it('política ilegível envenena o portão: TUDO recusa até corrigirem', () => {
    const gate = editsGate()
    gate.loadPolicy({ mode: 42 })
    expect(gate.unreadableReason).toBeDefined()

    const reason = assertDecision(gate, 'code', 'fs.read', 'read', '', 'deny')
    expect(reason).toContain('não pôde ser lida')

    // Corrigir a política destrava.
    gate.loadPolicy({ mode: 'edits' })
    expect(gate.unreadableReason).toBeUndefined()
    assertDecision(gate, 'code', 'fs.read', 'read', '', 'allow')
  })

  it('o override toolRules declarado é LIDO: deny vale por cima do modo aprovar tudo', () => {
    const gate = editsGate()
    gate.loadPolicy({ mode: 'all', toolRules: { 'fs.read': 'deny' } })
    const reason = assertDecision(gate, 'code', 'fs.read', 'read', '', 'deny')
    expect(reason).toContain('regra declarada')
    // E o resto do modo continua valendo — o override não é a política inteira.
    assertDecision(gate, 'code', 'proc.run', 'execute', '', 'allow')
  })

  it('toolRules allow dispensa a pergunta do modo edits; ask força a pergunta até em leitura', () => {
    const gate = editsGate()
    gate.loadPolicy({ mode: 'edits', toolRules: { 'fs.write': 'allow', 'fs.read': 'ask' } })
    assertDecision(gate, 'code', 'fs.write', 'write', '', 'allow')
    assertDecision(gate, 'code', 'fs.read', 'read', '', 'ask')
  })

  it('a regra escopada (especialista:ferramenta) vence a genérica', () => {
    const gate = editsGate()
    gate.loadPolicy({
      mode: 'edits',
      toolRules: { 'fs.write': 'deny', 'code:fs.write': 'allow' },
    })
    // Para o code vale a escopada (allow); para o design vale a genérica (deny).
    assertDecision(gate, 'code', 'fs.write', 'write', '', 'allow')
    assertDecision(gate, 'design', 'fs.write', 'write', '', 'deny')
  })

  it('a concessão NÃO fura a regra declarada deny (a ordem de avaliação)', () => {
    const gate = editsGate()
    gate.grant('session', 'code', 'fs.write', '')
    gate.loadPolicy({ mode: 'edits', toolRules: { 'fs.write': 'deny' } })
    assertDecision(gate, 'code', 'fs.write', 'write', 'qualquer', 'deny')
  })
})

/* --------------------------------- digest -------------------------------- */

describe('digestOf e approvalScope', () => {
  it('o digest muda com o escopo: outro projeto (ou outro especialista) não herda o sim', () => {
    const args = '{"path":"deploy/ci.yml"}'
    const noRepoA = digestOf(approvalScope('C:/repo-a', 'code'), 'fs.write', args)
    const noRepoB = digestOf(approvalScope('C:/repo-b', 'code'), 'fs.write', args)
    const outroEspecialista = digestOf(approvalScope('C:/repo-a', 'design'), 'fs.write', args)
    expect(noRepoA).not.toBe(noRepoB)
    expect(noRepoA).not.toBe(outroEspecialista)
    expect(noRepoA).toMatch(/^[0-9a-f]{16}$/)
  })

  it('sessão sem projeto cai na marca fixa — e não empresta para quem TEM projeto', () => {
    expect(approvalScope(undefined, 'chat')).toBe('sem-projeto\x00chat')
    expect(approvalScope('   ', 'chat')).toBe('sem-projeto\x00chat')
    expect(approvalScope('C:/repo', 'chat')).toBe('C:/repo\x00chat')
  })

  it('compat: reproduz o digest que o oráculo gravou na fixture ferramenta-aprovada', () => {
    // O valor veio do log.jsonl real (tool.call seq 4): scope sem-projeto+chat,
    // memory.write, argumentos exatamente como o modelo os emitiu.
    const raw =
      '{"kind":"fact","title":"Backup semanal","content":"O backup roda toda sexta às 18h."}'
    expect(digestOf(approvalScope(undefined, 'chat'), 'memory.write', raw)).toBe('6591da7d7de03a3c')
  })
})
