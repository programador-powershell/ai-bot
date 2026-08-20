/**
 * A bateria do motor de regras clean-room (§4.5 — cel-js fora, motor nosso).
 *
 * O teste central é o da memória da casa "política declarada e não lida":
 * TODA regra declarada é lida por inteiro — sintaxe quebrada falha SEMPRE
 * (mesmo em ramo que o curto-circuito não visitaria), identificador ausente
 * falha fora do curto-circuito, e falha NUNCA vira um false permissivo mudo
 * (quem decide o que a falha significa é a lista: deny quebrado nega, allow
 * quebrado não permite — provado nas fixtures do govern do chassis).
 */

import { describe, expect, it } from 'vitest'

import { RuleError, evaluateRule } from './rules.js'

const contexto = {
  tool: { name: 'computer_click' },
  bot: { id: 'risk-analyst' },
  actor: { id: 'dev-local-user' },
  page: { url: 'https://example.com/order', host: 'example.com' },
  element: { ref: 'e13', role: 'button', name: 'Submit order' },
}

describe('evaluateRule — o subconjunto que as regras do produto usam', () => {
  it('literais e comparação estrita', () => {
    expect(evaluateRule('true', contexto)).toBe(true)
    expect(evaluateRule('false', contexto)).toBe(false)
    expect(evaluateRule('tool.name == "computer_click"', contexto)).toBe(true)
    expect(evaluateRule('tool.name != "computer_type"', contexto)).toBe(true)
    // Sem coerção implícita: número não é igual a texto num portão.
    expect(evaluateRule('1 == "1"', contexto)).toBe(false)
  })

  it('contains é caso-insensível nos dois lados', () => {
    expect(evaluateRule('contains(element.name, "submit")', contexto)).toBe(true)
    expect(evaluateRule('contains(element.name, "SUBMIT")', contexto)).toBe(true)
    expect(evaluateRule('contains(element.name, "cancel")', contexto)).toBe(false)
  })

  it('matches usa regex caso-insensível e regex inválida é erro, nunca false', () => {
    expect(evaluateRule('matches(page.host, "^example\\\\.")', contexto)).toBe(true)
    expect(() => evaluateRule('matches(page.host, "[")', contexto)).toThrow(RuleError)
  })

  it('&& liga mais forte que || (a precedência do CEL)', () => {
    // false && true || true → (false && true) || true → true.
    expect(evaluateRule('false && true || true', contexto)).toBe(true)
    // Com parênteses invertendo: false && (true || true) → false.
    expect(evaluateRule('false && (true || true)', contexto)).toBe(false)
  })

  it('identificador ausente é ERRO — a regra que nomeia o que a chamada não trouxe falha fechado', () => {
    // `key` só existe em pressionamento de tecla; numa navegação a regra crua
    // tem de falhar (e o chamador nega), não virar false silencioso.
    expect(() => evaluateRule('key == "Enter"', contexto)).toThrow(RuleError)
    expect(() => evaluateRule('contains(mcp.tool, "edit")', contexto)).toThrow(RuleError)
  })

  it('curto-circuito absorve SÓ erro de resolução do ramo não visitado', () => {
    // O guarda pelo nome da ferramenta: falso à esquerda decide sem olhar o
    // campo que esta chamada não tem — é o que deixa a regra escopada do
    // preset conviver com ações que não têm `key`.
    expect(evaluateRule('tool.name == "computer_key" && key == "Enter"', contexto)).toBe(false)
    expect(evaluateRule('true || chave_que_nao_existe == "x"', contexto)).toBe(true)
    // Visitado, o mesmo erro continua sendo erro.
    expect(() =>
      evaluateRule('tool.name == "computer_click" && key == "Enter"', contexto),
    ).toThrow(RuleError)
  })

  it('sintaxe quebrada falha SEMPRE — mesmo atrás de curto-circuito (política declarada é lida inteira)', () => {
    expect(() => evaluateRule('this is not ( valid cel', contexto)).toThrow(RuleError)
    expect(() => evaluateRule('also not ( valid', contexto)).toThrow(RuleError)
    // O parse é inteiro ANTES da avaliação: o ramo que o false esconderia
    // ainda é lido, e lido quebrado derruba a regra inteira.
    expect(() => evaluateRule('false && (isto nao parseia', contexto)).toThrow(RuleError)
    expect(() => evaluateRule('true || funcao_desconhecida(1)', contexto)).toThrow(RuleError)
  })

  it('regra vazia e sobra depois da expressão são erro', () => {
    expect(() => evaluateRule('   ', contexto)).toThrow(RuleError)
    expect(() => evaluateRule('true true', contexto)).toThrow(RuleError)
  })

  it('negação: !true é false e !erro continua erro', () => {
    expect(evaluateRule('!false', contexto)).toBe(true)
    expect(() => evaluateRule('!campo_ausente', contexto)).toThrow(RuleError)
  })
})
