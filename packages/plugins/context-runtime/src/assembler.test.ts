/**
 * O Context Assembler: working set nunca é o histórico bruto completo; system
 * nunca cai; grupos atômicos nunca quebram (o grupo sai INTEIRO e o chamador
 * recebe o que a cápsula ainda não dobrou); o fit ladder degrada NA ORDEM da
 * spec; minKeptMessages=2/floorTokens=256; truncamento no meio com marca;
 * NOTE_1 de emergência com o estado crítico.
 */

import { describe, expect, it } from 'vitest'
import { BudgetManager, FLOOR_TOKENS, NOTE1_MAX_CHARS } from './budget.js'
import { Capsule } from './capsule.js'
import { assemble, buildEmergencyNote, LADDER_ORDER, type AssemblyInput } from './assembler.js'
import { MAX_HISTORY_MESSAGES, tailFromEnvelopes, type TailItem } from './history.js'
import type { Envelope, Kind } from '@aibot2/domain-events'

function envelope(seq: number, kind: Kind, payload: unknown): Envelope {
  return {
    v: 1, id: `e-${seq}`, ts: new Date().toISOString(), seq, session: 's1', kind,
    from: { kind: 'supervisor' }, payload,
  }
}

function message(seq: number, text: string, role: 'user' | 'assistant' = 'user'): TailItem {
  return { role, content: text, seq, source: 'message' }
}

function evidence(seq: number, tool: string, text: string): TailItem {
  return { role: 'user', content: `Resultado das ferramentas:\n\n${tool} =>\n${text}`, seq, source: 'evidence', tool }
}

/** Um orçamento apertado e determinístico: fitBudget = floor(1000*0.65) = 650. */
const TIGHT = new BudgetManager(1000)
const ROOMY = new BudgetManager(1_000_000)

function input(partial: Partial<AssemblyInput>): AssemblyInput {
  return { system: ['instrucoes'], capsule: new Capsule(), tail: [], ...partial }
}

describe('o working set', () => {
  it('NUNCA reenvia o histórico bruto completo — a cauda é capada', () => {
    const envelopes: Envelope[] = []
    for (let seq = 1; seq <= 200; seq++) {
      envelopes.push(envelope(seq, 'message', { role: 'user', text: 'mensagem ' + String(seq) }))
    }
    const tail = tailFromEnvelopes(envelopes)
    expect(tail.length).toBe(MAX_HISTORY_MESSAGES)
    const assembly = assemble(input({ tail }), ROOMY)
    // system(1) + cauda capada — nunca as 200.
    expect(assembly.messages.length).toBe(1 + MAX_HISTORY_MESSAGES)
  })

  it('a ordem é system → cápsula → retrieved → cauda', () => {
    const capsule = new Capsule()
    capsule.fold([envelope(1, 'message', { role: 'user', text: 'objetivo' })])
    const assembly = assemble(
      input({ capsule, retrieved: ['memoria util'], tail: [message(2, 'pergunta atual')] }),
      ROOMY,
    )
    expect(assembly.messages[0]!.content).toBe('instrucoes')
    expect(assembly.messages[1]!.content).toContain('ESTADO DA SESSÃO')
    expect(assembly.messages[2]!.content).toContain('memoria util')
    expect(assembly.messages[3]!.content).toBe('pergunta atual')
    expect(assembly.stepsApplied).toEqual([])
  })
})

describe('o fit ladder (a ordem é contrato)', () => {
  it('degrau 1 — verbatim relevante: o não-relevante antigo sai primeiro', () => {
    const capsule = new Capsule()
    capsule.cursor = 8 // tudo até 8 já dobrado
    const tail: TailItem[] = []
    for (let seq = 1; seq <= 10; seq++) tail.push(message(seq, 'x'.repeat(400) + String(seq)))
    const assembly = assemble(input({ capsule, tail, relevantFromSeq: 8 }), TIGHT)
    expect(assembly.stepsApplied).toEqual(['verbatim-relevante'])
    // Os relevantes (9, 10) ficaram; o corte foi nos antigos.
    const contents = assembly.messages.map((m) => m.content)
    expect(contents.some((c) => c.endsWith('9'))).toBe(true)
    expect(contents.some((c) => c.endsWith('10'))).toBe(true)
    expect(contents.some((c) => c.endsWith('x1'))).toBe(false)
    // Nada não-absorvido foi perdido: os descartados estavam sob o cursor.
    expect(assembly.droppedUnabsorbed).toEqual([])
  })

  it('degrau 2 — histórico absorvido: o que a cápsula dobrou não viaja verbatim', () => {
    const capsule = new Capsule()
    capsule.cursor = 8
    const tail: TailItem[] = []
    for (let seq = 1; seq <= 10; seq++) tail.push(message(seq, 'y'.repeat(400) + String(seq)))
    // relevantFromSeq=0: TUDO é relevante — o degrau 1 não acha candidato.
    const assembly = assemble(input({ capsule, tail, relevantFromSeq: 0 }), TIGHT)
    expect(assembly.stepsApplied).toEqual(['historico-absorvido'])
  })

  it('degrau 3 — projeções são truncadas com marca (o integral está no artifact store)', () => {
    const tail: TailItem[] = [
      evidence(1, 'fs.read', 'a'.repeat(3000)),
      message(2, 'pergunta'),
    ]
    const assembly = assemble(input({ tail, relevantFromSeq: 0 }), TIGHT)
    expect(assembly.stepsApplied).toEqual(['truncar-projecoes'])
    const projected = assembly.messages.find((m) => m.content.includes('fs.read =>'))
    expect(projected).toBeDefined()
    expect(projected!.content).toContain('colagem cortada para caber na janela do modelo')
  })

  it('degrau 4 — passos redundantes: evidência superada pela mesma ferramenta cai', () => {
    const tail: TailItem[] = []
    // 6 execuções da MESMA ferramenta (400 chars: curtas demais para o degrau
    // 3 encolher) — só a última importa.
    for (let seq = 1; seq <= 6; seq++) tail.push(evidence(seq, 'proc.run', 'saida '.repeat(66) + String(seq)))
    tail.push(message(7, 'pergunta'))
    const assembly = assemble(input({ tail, relevantFromSeq: 0 }), TIGHT)
    expect(assembly.stepsApplied).toContain('passos-redundantes')
    const runs = assembly.messages.filter((m) => m.content.includes('proc.run =>'))
    // A última execução fica; as superadas caíram.
    expect(runs.length).toBeLessThan(6)
    expect(runs[runs.length - 1]!.content).toContain('6')
  })

  it('degrau 5 — retrieved cai do menos relevante (o fim da lista)', () => {
    const retrieved = ['mais relevante ' + 'r'.repeat(300), 'menos relevante ' + 'q'.repeat(3000)]
    const assembly = assemble(input({ tail: [message(1, 'pergunta')], retrieved, relevantFromSeq: 0 }), TIGHT)
    expect(assembly.stepsApplied).toEqual(['retrieved'])
    const texts = assembly.messages.map((m) => m.content).join('\n')
    expect(texts).not.toContain('menos relevante')
  })

  it('degrau 6 — minKeptMessages=2 sobrevivem, truncadas com piso de 256 tokens', () => {
    const tail: TailItem[] = [
      message(1, 'colagem gigante ' + 'z'.repeat(9000)),
      message(2, 'pergunta atual ' + 'w'.repeat(9000)),
    ]
    const assembly = assemble(input({ tail, relevantFromSeq: 0 }), TIGHT)
    expect(assembly.stepsApplied).toEqual(['item-recente-menos-importante'])
    // As DUAS últimas ficaram (o piso do fitToContext) — truncadas, com marca.
    const kept = assembly.messages.filter((m) => m.role === 'user')
    expect(kept.length).toBe(2)
    for (const item of kept) {
      expect(item.content).toContain('colagem cortada')
      // floorTokens: mesmo sem orçamento, cada uma recebe >= 256 tokens de espaço.
      expect(item.content.length).toBeGreaterThanOrEqual(FLOOR_TOKENS)
    }
    // A pergunta atual não sumiu.
    expect(kept[1]!.content).toContain('pergunta atual')
  })

  it('os degraus aplicados respeitam a ordem da spec', () => {
    // Um cenário que atravessa vários degraus de uma vez.
    const capsule = new Capsule()
    capsule.cursor = 4
    const tail: TailItem[] = []
    for (let seq = 1; seq <= 4; seq++) tail.push(message(seq, 'antigo ' + 'a'.repeat(400)))
    for (let seq = 5; seq <= 8; seq++) tail.push(evidence(seq, 'fs.read', 'e'.repeat(2500)))
    tail.push(message(9, 'pergunta ' + 'p'.repeat(1200)))
    const assembly = assemble(
      input({ capsule, tail, relevantFromSeq: 4, retrieved: ['r'.repeat(2000)] }),
      TIGHT,
    )
    const order = assembly.stepsApplied.map((step) => LADDER_ORDER.indexOf(step))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(assembly.stepsApplied.length).toBeGreaterThan(1)
  })
})

describe('grupos atômicos', () => {
  it('ToolResult é UMA mensagem user — o orçamento apertado não a parte', () => {
    const tail: TailItem[] = [
      evidence(1, 'fs.read', 'inicio-do-arquivo ' + 'm'.repeat(6000) + ' fim-do-arquivo'),
      message(2, 'pergunta'),
    ]
    const assembly = assemble(input({ tail, relevantFromSeq: 0 }), TIGHT)
    const withTool = assembly.messages.filter((m) => m.content.includes('fs.read =>'))
    // Ou a evidência está inteira NUMA mensagem (truncada por dentro, com
    // marca), ou não está — nunca em duas.
    expect(withTool.length).toBe(1)
    expect(withTool[0]!.role).toBe('user')
    expect(withTool[0]!.content.startsWith('Resultado das ferramentas:')).toBe(true)
  })

  it('o par da delegação sai INTEIRO e o não-absorvido é devolvido ao chamador', () => {
    const capsule = new Capsule() // cursor 0: nada dobrado ainda
    const tail: TailItem[] = [
      { role: 'assistant', content: 'Deleguei ao especialista data: ' + 'g'.repeat(2000), seq: 1, source: 'delegation', groupId: 'delegate:data:1' },
      { role: 'user', content: 'Resultado do especialista data:\n' + 'r'.repeat(2000), seq: 2, source: 'delegation', groupId: 'delegate:data:1' },
      message(3, 'pergunta um'),
      message(4, 'pergunta atual'),
    ]
    const assembly = assemble(input({ capsule, tail, relevantFromSeq: 2 }), TIGHT)
    const parts = assembly.messages.filter(
      (m) => m.content.startsWith('Deleguei') || m.content.startsWith('Resultado do especialista'),
    )
    // Grupo atômico: 2 (inteiro) ou 0 (saiu junto) — nunca 1.
    expect(parts.length === 0 || parts.length === 2).toBe(true)
    expect(parts.length).toBe(0)
    // O grupo tinha seq > cursor: o chamador PRECISA dobrar antes de seguir —
    // é o contrato "o grupo sai e a cápsula guarda a representação".
    expect(assembly.droppedUnabsorbed).toContain(2)
  })
})

describe('emergência (NOTE_1)', () => {
  function overloadedCapsule(): Capsule {
    const capsule = new Capsule()
    const lote: Envelope[] = [envelope(1, 'message', { role: 'user', text: 'migrar o billing para o novo schema' })]
    for (let seq = 2; seq <= 12; seq++) {
      lote.push(envelope(seq, 'delegate', { from: 'a', to: 'bot' + String(seq), goal: 'passo '.repeat(30) + String(seq) }))
    }
    lote.push(envelope(13, 'tool.result', { callId: 'c1', tool: 'proc.run', ok: false, error: 'build vermelho '.repeat(10) }))
    lote.push(envelope(14, 'ask', { askId: 'a1', question: 'posso derrubar a tabela?', blocking: true }))
    capsule.fold(lote)
    capsule.addConstraint('nunca commitar')
    return capsule
  }

  it('quando nem o fit ladder basta, entra a NOTE_1 — e system NUNCA cai', () => {
    const capsule = overloadedCapsule()
    const budget = new BudgetManager(1000) // fitBudget 650 << render da cápsula
    const assembly = assemble(
      input({ capsule, tail: [message(15, 'pergunta atual')], relevantFromSeq: 0, system: ['politica-do-admin'] }),
      budget,
    )
    expect(assembly.emergency).toBe(true)
    expect(assembly.stepsApplied[assembly.stepsApplied.length - 1]).toBe('emergencia')
    // system nunca cai — nem na emergência.
    expect(assembly.messages[0]!.content).toBe('politica-do-admin')
    const note = assembly.messages[1]!.content
    expect(note).toContain('NOTA DE EMERGÊNCIA')
    expect(note).toContain('OBJETIVO: migrar o billing')
    expect(note).toContain('nunca commitar')
    // A pergunta atual sobrevive como último item.
    expect(assembly.messages[assembly.messages.length - 1]!.content).toContain('pergunta atual')
  })

  it('a NOTE_1 carrega o estado crítico e respeita ~12k chars', () => {
    const capsule = overloadedCapsule()
    const note = buildEmergencyNote(capsule, 'pergunta atual')
    expect(note).toContain('OBJETIVO:')
    expect(note).toContain('RESTRIÇÕES')
    expect(note).toContain('DECISÕES:')
    expect(note).toContain('TAREFAS/PENDÊNCIAS:')
    expect(note).toContain('ERROS ABERTOS:')
    expect(note).toContain('TRABALHO ATUAL:')
    expect(note).toContain('PRÓXIMA AÇÃO:')
    expect(note).toContain('PERGUNTA ATUAL:')
    expect(note.length).toBeLessThanOrEqual(NOTE1_MAX_CHARS + 60) // corpo + a marca de corte
  })
})
