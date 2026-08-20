/**
 * O tratamento de texto do roteador — porte BYTE-exato do Go.
 *
 * O detalhe que não é óbvio: o oráculo opera sobre BYTES UTF-8 (strings.Index
 * devolve offset de byte; `text[pos-1]` lê UM byte e o classifica como runa).
 * Para "mesmas rotas e mesmas confianças, tolerância zero" (aceite E5), este
 * módulo reproduz essa aritmética sobre Buffer em vez de code units UTF-16 —
 * no corpus pt-BR normalizado os dois dariam igual, mas parity que depende de
 * "provavelmente dá igual" não é parity.
 */

/**
 * As letras acentuadas dobradas para a forma sem acento — o MESMO mapa do
 * oráculo (português + as do espanhol que aparecem em texto colado). Feito à
 * mão lá porque normalização Unicode custaria uma dependência; aqui fica à
 * mão pela mesma razão de paridade: Intl/normalize dobraria MAIS letras que o
 * Go dobra, e o léxico mudaria de resposta.
 */
const FOLD: ReadonlyMap<number, number> = new Map(
  Object.entries({
    'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
    'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
    'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
    'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
    'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
    'ç': 'c', 'ñ': 'n', 'ý': 'y',
  }).map(([from, to]) => [from.codePointAt(0) as number, to.codePointAt(0) as number]),
)

/**
 * unicode.IsSpace do Go é a tabela White_Space — que NÃO é o \s do JS: o Go
 * inclui U+0085 (NEL) e exclui U+FEFF (BOM), o \s faz o contrário. A tabela
 * explícita evita a divergência silenciosa.
 */
export function isSpaceCodePoint(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) || cp === 0x20 || cp === 0x85 || cp === 0xa0 ||
    cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000
  )
}

/**
 * ToLower simples (1:1) como o unicode.ToLower do Go: quando o mapeamento
 * completo do JS expande (İ → i + ◌̇), fica o primeiro ponto — que é o que o
 * mapeamento simples devolve.
 */
function lowerCodePoint(cp: number): number {
  const lowered = String.fromCodePoint(cp).toLowerCase()
  return lowered.codePointAt(0) as number
}

/**
 * Deixa o texto comparável: minúsculas, sem acento, espaços colapsados. É o
 * MESMO tratamento aplicado a texto e radicais — se só um lado fosse dobrado,
 * "segurança" nunca casaria com "seguranc".
 */
export function normalize(text: string): string {
  let out = ''
  let space = false
  for (const ch of text) {
    let cp = lowerCodePoint(ch.codePointAt(0) as number)
    // O mapa só é consultado fora do ASCII — toda chave de FOLD é acentuada.
    if (cp > 0x7f) {
      cp = FOLD.get(cp) ?? cp
    }
    if (isSpaceCodePoint(cp)) {
      space = true
      continue
    }
    if (space && out.length > 0) {
      out += ' '
    }
    space = false
    out += String.fromCodePoint(cp)
  }
  return out
}

/** TrimSpace com a MESMA tabela do Go (o .trim() do JS corta FEFF a mais). */
export function goTrimSpace(text: string): string {
  let start = 0
  let end = text.length
  while (start < end) {
    const cp = text.codePointAt(start) as number
    if (!isSpaceCodePoint(cp)) break
    start += cp > 0xffff ? 2 : 1
  }
  while (end > start) {
    const cp = text.codePointAt(end - 1) as number
    // Par substituto: o code unit final de um astral não é espaço — parar.
    if (cp >= 0xdc00 && cp <= 0xdfff) {
      const full = end >= 2 ? (text.codePointAt(end - 2) as number) : cp
      if (full > 0xffff) {
        if (!isSpaceCodePoint(full)) break
        end -= 2
        continue
      }
    }
    if (!isSpaceCodePoint(cp)) break
    end -= 1
  }
  return text.slice(start, end)
}

/** Índice (em code units) do primeiro whitespace — o IndexFunc do Go. */
export function indexOfSpace(text: string): number {
  let index = 0
  for (const ch of text) {
    if (isSpaceCodePoint(ch.codePointAt(0) as number)) return index
    index += ch.length
  }
  return -1
}

/* ------------------------------ nível de byte ---------------------------- */

export function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

/**
 * unicode.IsLetter(rune(byte)) do Go, tabulado para 0..255: no oráculo o
 * vizinho do casamento é lido como UM byte e promovido a runa, então a tabela
 * certa é a do Latin-1 — A–Z, a–z, ª (0xAA), µ (0xB5), º (0xBA) e os blocos
 * acentuados, MENOS × (0xD7) e ÷ (0xF7).
 */
function isByteLetter(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0xaa || byte === 0xb5 || byte === 0xba ||
    (byte >= 0xc0 && byte <= 0xd6) || (byte >= 0xd8 && byte <= 0xf6) || byte >= 0xf8
  )
}

/** unicode.IsDigit(rune(byte)): no Latin-1 só 0–9 são Nd (¹²³ são No). */
function isByteDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39
}

/** Diz se a posição (em bytes) começa uma palavra. */
export function isWordStart(bytes: Buffer, position: number): boolean {
  if (position === 0) return true
  const previous = bytes[position - 1] as number
  return !isByteLetter(previous) && !isByteDigit(previous)
}

/**
 * Diz se o radical casou como PALAVRA, e não como pedaço de outra. O ponto
 * NÃO conta como letra — é por isso que "next.js" casa inteiro.
 */
export function isWholeWord(bytes: Buffer, position: number, length: number): boolean {
  if (!isWordStart(bytes, position)) return false
  const end = position + length
  if (end >= bytes.length) return true
  const next = bytes[end] as number
  return !isByteLetter(next) && !isByteDigit(next)
}
