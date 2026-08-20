/**
 * Compat da projeção do Tool Output Gateway (aceite E4): 1500 de cabeça +
 * 3000 de cauda com a inversão tailHeavy, contagem do omitido, isenções por
 * ferramenta e a FORMA byte-a-byte da mensagem que o oráculo escreve.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsArtifactStore, type ArtifactStore } from './artifacts.js'
import {
  INLINE_TOOL_LIMIT,
  PROJECTION_HEAD,
  PROJECTION_TAIL,
  inlineLimitFor,
  projectToolOutput,
  summarize,
  tailHeavy,
  truncate,
} from './tool-output.js'

let root: string
let store: FsArtifactStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aibot2-toolout-'))
  store = new FsArtifactStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Saída sintética com posição legível em cada byte — os cortes ficam auditáveis. */
function synthetic(length: number): string {
  let out = ''
  while (out.length < length) {
    out += `[${String(out.length).padStart(8, '0')}]`
  }
  return out.slice(0, length)
}

describe('tetos por ferramenta', () => {
  it('o teto inline é 12 KiB; as ferramentas de contrato estruturado ganham 20000', () => {
    expect(INLINE_TOOL_LIMIT).toBe(12 * 1024)
    expect(inlineLimitFor('fs.read')).toBe(12 * 1024)
    for (const tool of [
      'schema.export', 'sql.render', 'design.replicate',
      'flow.validate', 'secrets.scan', 'osv.query', 'finetune.status',
    ]) {
      expect(inlineLimitFor(tool), tool).toBe(20000)
    }
  })

  it('tailHeavy: em compilador, teste e log o fim carrega o erro final', () => {
    for (const tool of ['proc.run', 'diagnostics.run', 'git.commit', 'git.diff']) {
      expect(tailHeavy(tool), tool).toBe(true)
    }
    expect(tailHeavy('fs.read')).toBe(false)
    expect(tailHeavy('fs.list')).toBe(false)
  })
})

describe('projectToolOutput', () => {
  it('saída pequena passa intacta — sem artefato, sem truncamento', async () => {
    const output = synthetic(1000)
    const projection = await projectToolOutput(store, 's', 'fs.read', output)
    expect(projection).toEqual({ projected: output, ref: '', rawBytes: 1000, truncated: false })
  })

  it('aceite E4: compat byte-a-byte da projeção — a FORMA exata do oráculo', async () => {
    const output = synthetic(20000)
    const bytes = Buffer.from(output, 'utf8')
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const ref = `artifact://fs_read/${hash}`

    const projection = await projectToolOutput(store, 's', 'fs.read', output)

    // fs.read NÃO é tailHeavy: a fatia grande (3000) vai para o começo.
    const head = output.slice(0, PROJECTION_TAIL)
    const tail = output.slice(20000 - PROJECTION_HEAD)
    const expected =
      `SAÍDA GRANDE (19 KB) — projetada. ` +
      `Integral em ${ref}: peça context.fetch {"ref":"${ref}","offset":N,"maxBytes":M} ` +
      `para ler qualquer trecho (offset negativo lê do fim).` +
      `\n\n[início]\n${head}` +
      `\n\n[… 15 KB omitidos …]\n\n[fim]\n${tail}`
    expect(projection.projected).toBe(expected)
    expect(projection.ref).toBe(ref)
    expect(projection.rawBytes).toBe(20000)
    expect(projection.truncated).toBe(true)

    // E o integral está recuperável do store, byte a byte.
    const slice = await store.read('s', ref, 0, 20000)
    expect(slice.chunk).toBe(output)
  })

  it('aceite E4: inversão tailHeavy — proc.run leva a fatia grande para o FIM', async () => {
    const output = synthetic(20000)
    const projection = await projectToolOutput(store, 's', 'proc.run', output)
    expect(projection.projected).toContain(`[início]\n${output.slice(0, PROJECTION_HEAD)}\n\n[…`)
    expect(projection.projected.endsWith(`[fim]\n${output.slice(20000 - PROJECTION_TAIL)}`)).toBe(true)
  })

  it('as isenções valem: schema.export de 15000 bytes fica inline; acima de 20000 projeta', async () => {
    const inline = await projectToolOutput(store, 's', 'schema.export', synthetic(15000))
    expect(inline.truncated).toBe(false)

    const projected = await projectToolOutput(store, 's', 'schema.export', synthetic(20001))
    expect(projected.truncated).toBe(true)
  })

  it('logo acima do teto a projeção já vale: 3000+1500 com o omitido contado', async () => {
    // 13000 > 12 KiB — projeta; as fatias nunca passam do total (o guard de
    // repartição do oráculo é inalcançável com estas constantes, e fica no
    // código pelo mesmo motivo que lá: defesa contra recalibração futura).
    const output = synthetic(13000)
    const projection = await projectToolOutput(store, 's', 'fs.read', output)
    expect(projection.projected).toContain(`[início]\n${output.slice(0, 3000)}`)
    expect(projection.projected).toContain('[… 8 KB omitidos …]')
    expect(projection.projected.endsWith(`[fim]\n${output.slice(13000 - 1500)}`)).toBe(true)
  })

  it('nunca corta um caractere UTF-8 ao meio — nada de U+FFFD na projeção', async () => {
    // "é" tem 2 bytes; o "x" na frente desloca a paridade para que o corte de
    // 3000 bytes caia exatamente no MEIO de um caractere.
    const output = 'x' + 'é'.repeat(10000)
    const projection = await projectToolOutput(store, 's', 'fs.read', output)
    expect(projection.projected).not.toContain('�')
    expect(projection.rawBytes).toBe(20001)
    // O corte por bytes (não por unidades de string): 2999 bytes úteis na
    // cabeça = "x" + 1499 "é" (o byte-líder órfão do 1500º caiu).
    expect(projection.projected).toContain(`[início]\nx${'é'.repeat(1499)}\n\n[…`)
    // A cauda são os últimos 1500 bytes = 750 "é" inteiros.
    expect(projection.projected.endsWith(`[fim]\n${'é'.repeat(750)}`)).toBe(true)
  })

  it('falha ao gravar o artefato NÃO derruba a ferramenta — projeta sem referência', async () => {
    const quebrado: ArtifactStore = {
      save: () => Promise.reject(new Error('disco recusou')),
      read: () => Promise.reject(new Error('não implementado')),
    }
    const projection = await projectToolOutput(quebrado, 's', 'fs.read', synthetic(20000))
    expect(projection.ref).toBe('')
    expect(projection.truncated).toBe(true)
    expect(projection.projected).toContain('O integral não pôde ser guardado; só esta projeção existe.')
  })

  it('sem store é o mesmo caso: projeção sem integral', async () => {
    const projection = await projectToolOutput(undefined, 's', 'fs.read', synthetic(20000))
    expect(projection.ref).toBe('')
    expect(projection.projected).toContain('só esta projeção existe')
  })
})

describe('truncate', () => {
  it('abaixo do limite devolve intacto', () => {
    expect(truncate('curto', 100)).toBe('curto')
  })

  it('acima do limite corta em BYTES e anuncia o corte', () => {
    const text = synthetic(30000)
    const cut = truncate(text, 20000)
    expect(cut).toBe(text.slice(0, 20000) + '\n… (cortado em 20000 de 30000 bytes)')
  })

  it('corta em fronteira de caractere — sem U+FFFD no meio do log', () => {
    const text = 'é'.repeat(10) // 20 bytes
    const cut = truncate(text, 5)
    expect(cut).toBe('éé\n… (cortado em 4 de 20 bytes)')
    expect(cut).not.toContain('�')
  })
})

describe('summarize — o alvo resolvido pelo SERVIDOR', () => {
  it('mostra o campo que diz O QUE vai acontecer, na ordem de leitura', () => {
    expect(summarize('fs.write', '{"path":"a.txt","content":"x"}')).toBe('fs.write — a.txt')
    expect(summarize('proc.run', '{"command":"go test","cwd":"."}')).toBe('proc.run — go test')
    // path vence command quando os dois existem (a ordem do oráculo).
    expect(summarize('x', '{"command":"b","path":"a"}')).toBe('x — a')
  })

  it('um rótulo mandado pelo modelo NÃO vira resumo — só os campos do contrato', () => {
    expect(summarize('proc.run', '{"label":"leitura inofensiva","command":"rm -rf x"}')).toBe(
      'proc.run — rm -rf x',
    )
    expect(summarize('fs.write', '{"label":"nada de mais"}')).toBe('fs.write')
  })

  it('JSON quebrado, vazio ou não-objeto cai no nome da ferramenta', () => {
    expect(summarize('fs.read', '')).toBe('fs.read')
    expect(summarize('fs.read', '{')).toBe('fs.read')
    expect(summarize('fs.read', '{}')).toBe('fs.read')
    expect(summarize('fs.read', '[1,2]')).toBe('fs.read')
    expect(summarize('fs.read', '"texto"')).toBe('fs.read')
  })
})
