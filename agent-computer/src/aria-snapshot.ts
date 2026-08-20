/**
 * O snapshot ARIA vira a lista plana de elementos que o contrato de tools
 * publica — porte adaptado de agent-computer/src/aria-snapshot.ts do openbot
 * (MIT, pin 06a1a84; ver THIRD_PARTY_NOTICES.md).
 *
 * O `ariaSnapshot({ mode: "ai" })` do Playwright devolve YAML: cada entrada é
 * `- descritor` ou `- descritor: valor`, aninhada por indentação. O openbot
 * parseia com o pacote `yaml` — aqui NÃO: a política da casa homologa
 * dependência por dependência, e as aprovadas de hoje são playwright e
 * dockerode. O que este módulo lê não é "YAML qualquer": é a saída de UM
 * serializador conhecido (o do Playwright), um subconjunto pequeno e estável —
 * listas indentadas, chave opcionalmente single-quoted, valor escalar (plano,
 * double-quoted ou bloco |/>). O leitor abaixo cobre exatamente esse
 * subconjunto e nada além; snapshot que não parseia devolve lista vazia em vez
 * de estourar (o próximo passo do chamador é tirar outro snapshot).
 *
 * O descritor (`textbox "Nome do cliente:" [ref=e5] [checked]`) é escaneado à
 * mão, nunca com uma regex única: as partes podem conter umas às outras — um
 * nome acessível pode ter colchete e um valor de flag pode ter aspa.
 *
 * Este módulo não importa Playwright: os testes do parser rodam sem browser.
 */

/** Teto de elementos por snapshot (E8): a lista vai para contexto de modelo. */
export const SNAPSHOT_ELEMENT_LIMIT = 200

/**
 * As roles que valem a pena entregar a um bot que quer AGIR.
 *
 * Allowlist por role ARIA, não por tag: o `mode: "ai"` devolve a árvore
 * acessível inteira (headings, parágrafos, containers genéricos), e o que um
 * bot precisa para preencher um formulário são os CONTROLES — um
 * `div[role=button]` é botão aqui, e o Playwright já decidiu qual é qual.
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
])

/**
 * Roles cujo estado "desmarcado" significa alguma coisa: a ausência de
 * `[checked]` nelas é false, não desconhecido — sem isso o bot não distingue
 * caixa desmarcada de controle que nem marca.
 */
const CHECKABLE_ROLES = new Set([
  'checkbox',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'switch',
])

/** Uma coisa na página sobre a qual o bot pode agir. */
export interface SnapshotElement {
  /** A referência e{N} do Playwright — válida só contra o snapshot mais recente. */
  ref: string
  role: string
  name: string
  /** Presente em controles de formulário: campo vazio ≠ campo preenchido. */
  value?: string
  disabled?: boolean
  checked?: boolean
}

/** A metade descritor de uma entrada: tudo antes do dois-pontos. */
interface Descriptor {
  role: string
  name: string
  flags: Map<string, string>
}

/**
 * Lê `textbox "Nome do cliente:" [ref=e5] [checked]`.
 *
 * Escaneado da esquerda para a direita porque as partes se contêm: nome
 * acessível com colchete, flag com aspa. Uma expressão única que cubra toda
 * página não é sustentável (a lição literal do openbot).
 */
export function parseDescriptor(text: string): Descriptor | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  // A role vai até o primeiro espaço, aspa ou colchete.
  let index = 0
  while (
    index < trimmed.length &&
    trimmed[index] !== ' ' &&
    trimmed[index] !== '"' &&
    trimmed[index] !== '['
  ) {
    index += 1
  }
  const role = trimmed.slice(0, index)
  if (role === '') return null

  let name = ''
  const flags = new Map<string, string>()

  while (index < trimmed.length) {
    const char = trimmed[index]

    if (char === '"') {
      // O nome acessível, consumindo escapes para que um nome com aspa
      // sobreviva inteiro.
      index += 1
      let collected = ''
      while (index < trimmed.length && trimmed[index] !== '"') {
        if (trimmed[index] === '\\' && index + 1 < trimmed.length) {
          collected += trimmed[index + 1]
          index += 2
          continue
        }
        collected += trimmed[index]
        index += 1
      }
      index += 1
      name = collected
      continue
    }

    if (char === '[') {
      index += 1
      let collected = ''
      while (index < trimmed.length && trimmed[index] !== ']') {
        collected += trimmed[index]
        index += 1
      }
      index += 1
      const equals = collected.indexOf('=')
      if (equals === -1) {
        flags.set(collected.trim(), '')
      } else {
        flags.set(collected.slice(0, equals).trim(), collected.slice(equals + 1).trim())
      }
      continue
    }

    index += 1
  }

  return { role, name, flags }
}

/** Monta o elemento a partir de descritor + valor, ou null se não é acionável. */
function toElement(descriptor: Descriptor, value: string | undefined): SnapshotElement | null {
  if (!INTERACTIVE_ROLES.has(descriptor.role)) return null

  const ref = descriptor.flags.get('ref')
  // Sem ref não há o que fazer com ele — é ruído numa lista cujo propósito
  // inteiro é agir.
  if (ref === undefined || ref === '') return null

  const element: SnapshotElement = {
    ref,
    role: descriptor.role,
    name: descriptor.name.slice(0, 200),
  }

  if (value !== undefined) {
    const text = value.trim()
    if (text !== '') element.value = text.slice(0, 200)
  }

  if (descriptor.flags.has('disabled')) element.disabled = true

  // O Playwright só emite `[checked]` quando algo está marcado; a ausência,
  // sozinha, é ambígua. Reportamos false para as roles marcáveis e omitimos
  // para as que não marcam.
  if (descriptor.flags.has('checked')) {
    element.checked = descriptor.flags.get('checked') !== 'false'
  } else if (CHECKABLE_ROLES.has(descriptor.role)) {
    element.checked = false
  }

  return element
}

/* ------------------------- leitor do subconjunto --------------------------- */

/**
 * Uma entrada de lista do serializador do Playwright, já separada em
 * descritor + valor inline (o valor de bloco chega resolvido pelo chamador).
 */
interface Entry {
  descriptor: string
  value: string | undefined
}

/**
 * Desfaz as aspas de um escalar double-quoted (`"a \"b\""`) ou single-quoted
 * (`'a ''b'''`, o escape do YAML é aspa dobrada). Escalar sem aspas volta
 * aparado — o serializador do Playwright nunca emite âncoras/tags/fluxo.
 */
function unquoteScalar(raw: string): string {
  const text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    let out = ''
    for (let index = 1; index < text.length - 1; index++) {
      if (text[index] === '\\' && index + 1 < text.length - 1) {
        const next = text[index + 1]!
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next
        index += 1
        continue
      }
      out += text[index]
    }
    return out
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'")
  }
  return text
}

/**
 * Separa `descritor: valor` no dois-pontos ESTRUTURAL: fora de aspas duplas
 * (com escape \"), fora de single-quote (com escape '') e fora de colchetes —
 * um nome acessível "Nome do cliente:" ou uma flag [url=http://x] não podem
 * quebrar a entrada no lugar errado.
 */
function splitEntry(content: string): Entry {
  // Chave single-quoted inteira: o serializador do Playwright envolve o
  // descritor em 'aspas simples' quando ele precisaria de escape YAML.
  if (content.startsWith("'")) {
    let index = 1
    while (index < content.length) {
      if (content[index] === "'") {
        if (content[index + 1] === "'") {
          index += 2
          continue
        }
        break
      }
      index += 1
    }
    const descriptor = content.slice(1, index).replaceAll("''", "'")
    const rest = content.slice(index + 1).trim()
    if (rest.startsWith(':')) {
      const value = rest.slice(1).trim()
      return { descriptor, value: value === '' ? undefined : value }
    }
    return { descriptor, value: undefined }
  }

  let inDouble = false
  let inBracket = 0
  for (let index = 0; index < content.length; index++) {
    const char = content[index]
    if (inDouble) {
      if (char === '\\') index += 1
      else if (char === '"') inDouble = false
      continue
    }
    if (char === '"') {
      inDouble = true
      continue
    }
    if (char === '[') inBracket += 1
    else if (char === ']' && inBracket > 0) inBracket -= 1
    else if (char === ':' && inBracket === 0) {
      // Dois-pontos estrutural exige fim de linha ou espaço em seguida —
      // `http://x` num escalar plano não separa nada.
      const next = content[index + 1]
      if (next === undefined || next === ' ') {
        const value = content.slice(index + 1).trim()
        return {
          descriptor: content.slice(0, index),
          value: value === '' ? undefined : value,
        }
      }
    }
  }
  return { descriptor: content, value: undefined }
}

/** Largura da indentação (a posição do hífen). Linha sem hífen não é entrada. */
function dashColumn(line: string): number | null {
  let index = 0
  while (index < line.length && line[index] === ' ') index += 1
  if (line[index] === '-' && (line[index + 1] === ' ' || index + 1 === line.length)) {
    return index
  }
  return null
}

/**
 * Transforma o snapshot ARIA (mode "ai") na lista plana de elementos.
 *
 * A profundidade não importa para o resultado — a ordem das linhas JÁ É a
 * ordem depth-first da árvore —, então o leitor caminha linha a linha: cada
 * `- entrada` vira descritor+valor; valor de bloco (`|`/`>`) consome as linhas
 * mais indentadas que o seguem. Entrada cuja role não está na allowlist (ou
 * sem ref) é descartada mas os FILHOS continuam sendo lidos: um
 * `group "Tamanho da pizza"` não é acionável e os radios dele são.
 */
export function parseAriaSnapshot(yaml: string): {
  elements: SnapshotElement[]
  truncated: boolean
} {
  const elements: SnapshotElement[] = []
  let truncated = false
  const lines = yaml.split('\n')

  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const column = dashColumn(line)
    if (column === null) {
      // Linha que não é entrada de lista: continuação de bloco órfã, vazio,
      // ou algo que o serializador de amanhã inventou — tolerada, pulada.
      index += 1
      continue
    }
    const content = line.slice(column + 2).trim()
    index += 1
    if (content === '') continue

    const entry = splitEntry(content)
    let value = entry.value

    if (value !== undefined && /^[|>][+-]?$/.test(value)) {
      // Escalar de bloco: as linhas seguintes mais indentadas são o valor.
      const literal = value.startsWith('|')
      const collected: string[] = []
      while (index < lines.length) {
        const raw = lines[index]!
        if (raw.trim() === '') {
          collected.push('')
          index += 1
          continue
        }
        const indent = raw.length - raw.trimStart().length
        if (indent <= column) break
        collected.push(raw.trim())
        index += 1
      }
      value = collected.join(literal ? '\n' : ' ').trim()
    } else if (value !== undefined) {
      value = unquoteScalar(value)
    }

    const descriptor = parseDescriptor(entry.descriptor)
    const element = descriptor === null ? null : toElement(descriptor, value)
    if (element !== null) {
      if (elements.length >= SNAPSHOT_ELEMENT_LIMIT) {
        truncated = true
      } else {
        elements.push(element)
      }
    }
  }

  return { elements, truncated }
}
