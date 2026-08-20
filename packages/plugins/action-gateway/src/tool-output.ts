/**
 * O Tool Output Gateway — porte do `internal/supervisor/tool_gateway.go` do
 * oráculo: nenhuma ferramenta despeja saída ilimitada na janela do modelo.
 *
 * A saída que passa do teto inline vira artefato integral no store, e o modelo
 * recebe uma PROJEÇÃO: início + fim + referência + tamanho. Ele pode pedir o
 * resto por `context.fetch`, em fatias — recuperação sob demanda, nunca dump.
 *
 * A política de corte é POR TIPO de ferramenta, porque a informação não mora
 * no mesmo lugar: em compilador, teste e log, o fim carrega o erro final; em
 * listagem e busca, o começo carrega o que foi pedido.
 *
 * TODA a aritmética aqui é em BYTES (UTF-8), não em unidades de string do JS:
 * o Go mede `len(output)` em bytes e o aceite E4 exige a projeção
 * byte-a-byte idêntica — medir em UTF-16 deslocaria cada corte numa saída com
 * qualquer acento.
 */

import type { ArtifactStore } from './artifacts.js'

/**
 * O teto do que volta inline ao modelo e ao log. Acima disso, projeção +
 * artefato. Bem menor que o truncate antigo (20 000): o integral agora tem
 * para onde ir, então a janela não precisa carregá-lo.
 */
export const INLINE_TOOL_LIMIT = 12 << 10 // 12 KiB

/**
 * As fatias da projeção — o exemplo da especificação: 1500 do começo, 3000 do
 * fim (o erro final de um build mora no fim).
 */
export const PROJECTION_HEAD = 1500
export const PROJECTION_TAIL = 3000

/**
 * O teto inline da ferramenta. As de CONTRATO ESTRUTURADO — cuja saída é um
 * JSON que uma superfície parseia inteiro — ganham o teto antigo do log
 * (20 000): projetá-las em início+fim entregaria à tela um JSON picotado que
 * não parseia. Acima disso o comportamento é o mesmo de antes do gateway
 * existir (o truncate do log), e a busca do integral por artifactRef na tela
 * fica como evolução registrada.
 */
export function inlineLimitFor(tool: string): number {
  switch (tool) {
    case 'schema.export':
    case 'sql.render':
    case 'design.replicate':
    case 'flow.validate':
    case 'secrets.scan':
    case 'osv.query':
    case 'finetune.status':
      return 20000
  }
  return INLINE_TOOL_LIMIT
}

/** Diz se o FIM da saída importa mais que o começo para esta ferramenta. */
export function tailHeavy(tool: string): boolean {
  switch (tool) {
    case 'proc.run':
    case 'diagnostics.run':
    case 'git.commit':
    case 'git.diff':
      return true
  }
  return false
}

/** O desfecho da projeção — os quatro retornos do projectToolOutput do Go. */
export interface Projection {
  projected: string
  /** Vazio quando o integral não pôde ser guardado. */
  ref: string
  rawBytes: number
  truncated: boolean
}

/**
 * Aplica o gateway: saída pequena passa intacta; grande vira artefato +
 * projeção. Falha ao gravar o artefato NÃO derruba a ferramenta — cai no
 * truncamento antigo (projeção sem referência), que era o comportamento de
 * antes do gateway existir. Store ausente é o mesmo caso: projeta sem guardar.
 */
export async function projectToolOutput(
  artifacts: ArtifactStore | undefined,
  sessionId: string,
  tool: string,
  output: string,
): Promise<Projection> {
  const bytes = Buffer.from(output, 'utf8')
  if (bytes.length <= inlineLimitFor(tool)) {
    return { projected: output, ref: '', rawBytes: bytes.length, truncated: false }
  }
  const rawBytes = bytes.length

  let ref = ''
  if (artifacts !== undefined) {
    try {
      ref = await artifacts.save(sessionId, tool, bytes)
    } catch {
      // O integral não coube (ou o disco recusou) — a projeção segue sem
      // referência, como o `if err == nil` do oráculo.
    }
  }

  let head = PROJECTION_HEAD
  let tail = PROJECTION_TAIL
  if (!tailHeavy(tool)) {
    // Inversão deliberada: quando o começo importa mais, a fatia GRANDE vai
    // para ele (o mesmo swap do Go).
    head = PROJECTION_TAIL
    tail = PROJECTION_HEAD
  }
  if (head + tail > bytes.length) {
    head = Math.floor(bytes.length / 2)
    tail = bytes.length - head
  }

  let out = `SAÍDA GRANDE (${Math.floor(rawBytes / 1024)} KB) — projetada. `
  if (ref !== '') {
    out +=
      `Integral em ${ref}: peça context.fetch {"ref":"${ref}","offset":N,"maxBytes":M} ` +
      'para ler qualquer trecho (offset negativo lê do fim).'
  } else {
    out += 'O integral não pôde ser guardado; só esta projeção existe.'
  }
  out += '\n\n[início]\n'
  out += safeCut(bytes.subarray(0, head))
  out += `\n\n[… ${Math.floor((bytes.length - head - tail) / 1024)} KB omitidos …]\n\n[fim]\n`
  out += safeCutStart(bytes.subarray(bytes.length - tail))
  return { projected: out, ref, rawBytes, truncated: true }
}

/**
 * Apara o fim para não terminar no meio de um caractere UTF-8. Porte literal
 * do safeCut do oráculo, inclusive na miudeza: um caractere multibyte
 * COMPLETO no fim também cai (as continuações somem no laço e o byte-líder
 * cai no if) — compat byte-a-byte vence elegância.
 */
function safeCut(bytes: Uint8Array): string {
  let cut = bytes.length
  while (cut > 0 && (bytes[cut - 1]! & 0xc0) === 0x80) {
    cut--
  }
  if (cut > 0 && (bytes[cut - 1]! & 0x80) !== 0) {
    cut--
  }
  return Buffer.from(bytes.subarray(0, cut)).toString('utf8')
}

/** Apara o começo pelo mesmo motivo: pula os bytes de continuação órfãos. */
function safeCutStart(bytes: Uint8Array): string {
  let start = 0
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) {
    start++
  }
  return Buffer.from(bytes.subarray(start)).toString('utf8')
}

/**
 * O truncate do log — porte do `truncate` do supervisor.go. Corta em BYTES,
 * em fronteira de caractere (cortar no meio produz U+FFFD no meio da saída e
 * confunde quem lê o log), e anuncia o corte na própria string.
 */
export function truncate(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) {
    return text
  }
  let cut = limit
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut--
  }
  return (
    Buffer.from(bytes.subarray(0, cut)).toString('utf8') +
    `\n… (cortado em ${cut} de ${bytes.length} bytes)`
  )
}

/**
 * O resumo que a pessoa lê no cartão de aprovação — porte do `summarize` do
 * supervisor.go. Resolvido pelo SERVIDOR a partir dos argumentos CRUS, nunca
 * de um rótulo que o modelo tenha mandado: mostra os campos que dizem O QUE
 * vai acontecer, na ordem em que uma pessoa lê. Um resumo com o JSON inteiro
 * não é resumo — e um resumo ditado pelo modelo é teatro (a lição do govern()
 * do openbot: "never click Submit" se contorna mandando outro rótulo).
 */
export function summarize(tool: string, rawArgs: string): string {
  let fields: unknown
  try {
    fields = JSON.parse(rawArgs)
  } catch {
    return tool
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return tool
  }
  const record = fields as Record<string, unknown>
  if (Object.keys(record).length === 0) {
    return tool
  }
  for (const key of ['path', 'command', 'url', 'file', 'query', 'message']) {
    if (key in record) {
      return `${tool} — ${formatValue(record[key])}`
    }
  }
  return tool
}

/** O análogo do %v do Go para os valores que aparecem em resumo. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return '<nil>'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
