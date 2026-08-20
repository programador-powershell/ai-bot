/**
 * O Artifact Store em disco (aceite E4): content-addressed com o MESMO
 * sha256[:8] do oráculo, fatia obrigatória na leitura e offset negativo lendo
 * do fim (o contrato do context.fetch). Testes de integração reais — arquivo
 * de verdade, Windows primeiro (trilho transversal do plano).
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsArtifactStore, MAX_ARTIFACT_BYTES, safeId } from './artifacts.js'

let root: string
let store: FsArtifactStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aibot2-artifacts-'))
  store = new FsArtifactStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('save', () => {
  it('aceite E4: integral content-addressed com o MESMO sha256[:8] do oráculo', async () => {
    const data = Buffer.from('saída integral da ferramenta\n'.repeat(10), 'utf8')
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)

    const ref = await store.save('sessao-1', 'proc.run', data)
    // O kind passa pelo safeId (proc.run → proc_run) e a referência é estável.
    expect(ref).toBe(`artifact://proc_run/${hash}`)
  })

  it('é idempotente: a mesma saída gravada duas vezes é o mesmo arquivo', async () => {
    const data = Buffer.from('conteúdo repetido', 'utf8')
    const first = await store.save('s', 'fs.read', data)
    const second = await store.save('s', 'fs.read', data)
    expect(second).toBe(first)

    const files = readdirSync(join(root, 'sessions', 's', 'artifacts'))
    expect(files.filter((name) => !name.endsWith('.tmp'))).toHaveLength(1)
  })

  it('conteúdo diferente muda a referência — referência nunca aponta para conteúdo trocado', async () => {
    const a = await store.save('s', 'fs.read', Buffer.from('a'))
    const b = await store.save('s', 'fs.read', Buffer.from('b'))
    expect(a).not.toBe(b)
  })

  it('artefato vazio não é gravado; acima do teto recusa', async () => {
    await expect(store.save('s', 'fs.read', new Uint8Array(0))).rejects.toThrow('artefato vazio')
    await expect(
      store.save('s', 'fs.read', new Uint8Array(MAX_ARTIFACT_BYTES + 1)),
    ).rejects.toThrow('passa do teto')
  })
})

describe('read', () => {
  it('devolve a FATIA pedida e o tamanho total', async () => {
    const data = Buffer.from('0123456789', 'utf8')
    const ref = await store.save('s', 'fs.read', data)

    const slice = await store.read('s', ref, 2, 4)
    expect(slice.chunk).toBe('2345')
    expect(slice.total).toBe(10)
  })

  it('aceite E4: offset negativo lê do FIM — as últimas linhas sem saber o tamanho', async () => {
    const data = Buffer.from('0123456789', 'utf8')
    const ref = await store.save('s', 'fs.read', data)

    const tail = await store.read('s', ref, -3, 100)
    expect(tail.chunk).toBe('789')
    expect(tail.total).toBe(10)

    // Negativo além do começo clampa em zero.
    const all = await store.read('s', ref, -999, 100)
    expect(all.chunk).toBe('0123456789')
  })

  it('offset além do fim devolve fatia vazia com o total; limite <= 0 cai no padrão de 16 KiB', async () => {
    const data = Buffer.alloc(20000, 0x61) // 20000 × "a"
    const ref = await store.save('s', 'fs.read', data)

    const beyond = await store.read('s', ref, 20000, 10)
    expect(beyond.chunk).toBe('')
    expect(beyond.total).toBe(20000)

    const fallback = await store.read('s', ref, 0, 0)
    expect(fallback.chunk).toHaveLength(16 * 1024)
  })

  it('referência inválida ou forjada não escolhe onde ler', async () => {
    await expect(store.read('s', 'lixo://a/b', 0, 10)).rejects.toThrow('referência inválida')
    await expect(store.read('s', 'artifact://sem-barra', 0, 10)).rejects.toThrow('referência inválida')
    // Um "kind" com travessia de diretório não sobrevive ao safeId.
    await expect(store.read('s', 'artifact://../escape/abc', 0, 10)).rejects.toThrow('referência inválida')
    await expect(store.read('s', 'artifact://fs_read/ABC!', 0, 10)).rejects.toThrow('referência inválida')
  })

  it('artefato que não existe nesta conversa falha com nome e endereço', async () => {
    await expect(store.read('s', 'artifact://fs_read/0000000000000000', 0, 10)).rejects.toThrow(
      'não existe nesta conversa',
    )
    // E outra sessão NÃO enxerga o artefato do vizinho.
    const ref = await store.save('s', 'fs.read', Buffer.from('privado'))
    await expect(store.read('outra', ref, 0, 10)).rejects.toThrow('não existe nesta conversa')
  })
})

describe('safeId', () => {
  it('só [a-zA-Z0-9_-]; resto vira _; vazio cai em "sessao"; teto de 96', () => {
    expect(safeId('proc.run')).toBe('proc_run')
    // Um "_" por PONTO DE CÓDIGO (como o range de runas do Go), não por byte.
    expect(safeId('ção')).toBe('__o')
    expect(safeId('ok-id_9')).toBe('ok-id_9')
    expect(safeId('')).toBe('sessao')
    expect(safeId('x'.repeat(200))).toHaveLength(96)
    expect(safeId('../../etc')).toBe('______etc')
  })
})
