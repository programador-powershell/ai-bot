/**
 * Bateria do parser de snapshot ARIA — SEM browser (o módulo não importa
 * Playwright de propósito). Os aceites E8 aqui: allowlist de roles, teto de
 * 200 elementos, refs e{N}, valor/disabled/checked fiéis ao descritor.
 */

import { describe, expect, it } from 'vitest'
import { SNAPSHOT_ELEMENT_LIMIT, parseAriaSnapshot, parseDescriptor } from './aria-snapshot.js'

describe('parseDescriptor', () => {
  it('lê role, nome e flags de um descritor comum', () => {
    const descriptor = parseDescriptor('textbox "Nome do cliente:" [ref=e5] [checked]')
    expect(descriptor).not.toBeNull()
    expect(descriptor!.role).toBe('textbox')
    expect(descriptor!.name).toBe('Nome do cliente:')
    expect(descriptor!.flags.get('ref')).toBe('e5')
    expect(descriptor!.flags.has('checked')).toBe(true)
  })

  it('sobrevive a aspa escapada dentro do nome acessível', () => {
    const descriptor = parseDescriptor('button "Diga \\"olá\\"" [ref=e2]')
    expect(descriptor!.name).toBe('Diga "olá"')
    expect(descriptor!.flags.get('ref')).toBe('e2')
  })

  it('sobrevive a colchete dentro do nome acessível', () => {
    const descriptor = parseDescriptor('link "Item [1] da lista" [ref=e9]')
    expect(descriptor!.name).toBe('Item [1] da lista')
    expect(descriptor!.flags.get('ref')).toBe('e9')
  })

  it('descritor vazio é null, não exceção', () => {
    expect(parseDescriptor('   ')).toBeNull()
  })
})

describe('parseAriaSnapshot', () => {
  const sample = [
    '- generic [ref=e1]:',
    '  - heading "Pedido" [level=1]',
    '  - textbox "Nome do cliente:" [ref=e3]: Alice',
    '  - checkbox "Aceito os termos" [ref=e4]',
    '  - checkbox "Newsletter" [ref=e5] [checked]',
    '  - button "Enviar" [ref=e6]',
    '  - button "Cancelar" [ref=e7] [disabled]',
    '  - link "Ajuda" [ref=e8] [cursor=pointer]:',
    '    - /url: https://exemplo.com/ajuda',
    '  - text: Texto solto que não age',
  ].join('\n')

  it('só devolve as roles da allowlist, e só com ref', () => {
    const { elements, truncated } = parseAriaSnapshot(sample)
    expect(truncated).toBe(false)
    // heading, /url e text ficam de fora; generic tem ref mas não é interativo.
    expect(elements.map((each) => each.role)).toEqual([
      'textbox',
      'checkbox',
      'checkbox',
      'button',
      'button',
      'link',
    ])
    expect(elements.every((each) => /^e\d+$/.test(each.ref))).toBe(true)
  })

  it('captura valor, disabled e checked como o contrato pede', () => {
    const { elements } = parseAriaSnapshot(sample)
    const byRef = new Map(elements.map((each) => [each.ref, each]))
    expect(byRef.get('e3')!.value).toBe('Alice')
    // Ausência de [checked] numa role marcável é false, não desconhecido.
    expect(byRef.get('e4')!.checked).toBe(false)
    expect(byRef.get('e5')!.checked).toBe(true)
    expect(byRef.get('e6')!.checked).toBeUndefined()
    expect(byRef.get('e7')!.disabled).toBe(true)
    expect(byRef.get('e6')!.disabled).toBeUndefined()
  })

  it('desce em containers não acionáveis: os radios de um group aparecem', () => {
    const yaml = [
      '- group "Tamanho da pizza":',
      '  - radio "Média" [ref=e2]',
      '  - radio "Grande" [ref=e3] [checked]',
    ].join('\n')
    const { elements } = parseAriaSnapshot(yaml)
    expect(elements.map((each) => each.name)).toEqual(['Média', 'Grande'])
  })

  it('nome com dois-pontos não quebra a entrada no lugar errado', () => {
    const yaml = '- textbox "Endereço: rua e número" [ref=e2]: Rua A, 10'
    const { elements } = parseAriaSnapshot(yaml)
    expect(elements).toHaveLength(1)
    expect(elements[0]!.name).toBe('Endereço: rua e número')
    expect(elements[0]!.value).toBe('Rua A, 10')
  })

  it('chave single-quoted (o escape do serializador) é desfeita', () => {
    const yaml = "- 'button \"Confirmar\" [ref=e4]'"
    const { elements } = parseAriaSnapshot(yaml)
    expect(elements).toHaveLength(1)
    expect(elements[0]!.ref).toBe('e4')
    expect(elements[0]!.name).toBe('Confirmar')
  })

  it('valor double-quoted perde as aspas e resolve escapes', () => {
    const yaml = '- textbox "Obs" [ref=e2]: "com \\"aspas\\" dentro"'
    const { elements } = parseAriaSnapshot(yaml)
    expect(elements[0]!.value).toBe('com "aspas" dentro')
  })

  it('valor de bloco (|) junta as linhas indentadas', () => {
    const yaml = ['- textbox "Notas" [ref=e2]: |', '    primeira linha', '    segunda linha'].join(
      '\n',
    )
    const { elements } = parseAriaSnapshot(yaml)
    expect(elements[0]!.value).toBe('primeira linha\nsegunda linha')
  })

  it(`trunca em ${SNAPSHOT_ELEMENT_LIMIT} elementos e avisa`, () => {
    const lines: string[] = []
    for (let index = 1; index <= SNAPSHOT_ELEMENT_LIMIT + 50; index++) {
      lines.push(`- button "Botão ${index}" [ref=e${index}]`)
    }
    const { elements, truncated } = parseAriaSnapshot(lines.join('\n'))
    expect(elements).toHaveLength(SNAPSHOT_ELEMENT_LIMIT)
    expect(truncated).toBe(true)
  })

  it('nome e valor são limitados a 200 caracteres', () => {
    const long = 'x'.repeat(400)
    const yaml = `- textbox "${long}" [ref=e2]: ${long}`
    const { elements } = parseAriaSnapshot(yaml)
    expect(elements[0]!.name).toHaveLength(200)
    expect(elements[0]!.value).toHaveLength(200)
  })

  it('snapshot ilegível devolve lista vazia em vez de estourar', () => {
    const { elements, truncated } = parseAriaSnapshot('%%% nada disso é yaml {{{')
    expect(elements).toEqual([])
    expect(truncated).toBe(false)
  })
})
