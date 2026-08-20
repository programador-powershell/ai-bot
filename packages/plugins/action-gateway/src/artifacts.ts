/**
 * O Artifact Store: a saída INTEGRAL das ferramentas, fora da janela do modelo.
 *
 * Porte do `internal/store/artifacts.go` do oráculo. Endereçado por CONTEÚDO
 * (sha256 curto) de propósito: a mesma saída gravada duas vezes vira o mesmo
 * arquivo (idempotente, sem relógio), e uma referência nunca aponta para
 * conteúdo trocado — se o conteúdo mudou, a referência muda.
 *
 * A interface é o seam; a implementação em disco mora AQUI DENTRO por enquanto
 * (decisão do E4) — quando o provider definitivo nascer, ela muda de pacote
 * sem mudar nenhum consumidor.
 */

import { createHash } from 'node:crypto'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** O prefixo das referências: artifact://<tipo>/<hash>. */
export const ARTIFACT_SCHEME = 'artifact://'

/**
 * O teto de UM artefato. Acima disso a gravação recusa: um artefato de
 * gigabytes não é saída de ferramenta, é um arquivo do projeto — e o lugar
 * dele é o workspace.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024 // 64 MiB

/** Uma fatia do artefato e o tamanho total dele. */
export interface ArtifactSlice {
  chunk: string
  total: number
}

/** O seam que o Tool Output Gateway e o context.fetch consomem. */
export interface ArtifactStore {
  /** Grava o conteúdo integral e devolve a referência estável (artifact://tipo/hash). */
  save(sessionId: string, kind: string, data: Uint8Array): Promise<string>
  /**
   * Devolve uma FATIA (offset em bytes; NEGATIVO lê do fim) e o tamanho total.
   * A fatia é obrigatória: devolver o integral recolocaria na janela
   * exatamente o que a projeção tirou dela.
   */
  read(sessionId: string, ref: string, offset: number, limit: number): Promise<ArtifactSlice>
}

/**
 * Impede que um id vindo do cliente escape do diretório de dados — porte do
 * safeID do oráculo: só [a-zA-Z0-9_-], resto vira '_', vazio cai em "sessao",
 * teto de 96. É o único ponto em que id de fora encosta no sistema de arquivos.
 */
export function safeId(id: string): string {
  let out = ''
  for (const symbol of id) {
    out += /[a-zA-Z0-9_-]/.test(symbol) ? symbol : '_'
  }
  if (out === '') return 'sessao'
  return out.length > 96 ? out.slice(0, 96) : out
}

/** O Artifact Store em disco — mesma disposição de diretórios do oráculo. */
export class FsArtifactStore implements ArtifactStore {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  #sessionDir(sessionId: string): string {
    return join(this.#root, 'sessions', safeId(sessionId))
  }

  async save(sessionId: string, kind: string, data: Uint8Array): Promise<string> {
    if (data.length === 0) {
      throw new Error('artefato vazio não é gravado')
    }
    if (data.length > MAX_ARTIFACT_BYTES) {
      throw new Error(`artefato de ${data.length} bytes passa do teto de ${MAX_ARTIFACT_BYTES}`)
    }
    // No oráculo havia um fallback "saida" para kind vazio, mas safeID nunca
    // devolve vazio (cai em "sessao") — o fallback era código morto e não é
    // portado; o comportamento OBSERVÁVEL (kind vazio → "sessao") é o mesmo.
    const cleanKind = safeId(kind)
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 16) // sha256[:8] em hex

    const dir = join(this.#sessionDir(sessionId), 'artifacts')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${cleanKind}-${hash}.txt`)
    const ref = `${ARTIFACT_SCHEME}${cleanKind}/${hash}`

    // Endereçado por conteúdo: se o arquivo já existe, é ESTE conteúdo.
    try {
      await stat(path)
      return ref
    } catch {
      // não existe ainda — grava
    }
    // Escrita em dois tempos: o vizinho que ler no meio não vê metade.
    const temp = path + '.tmp'
    await writeFile(temp, data)
    try {
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    return ref
  }

  async read(sessionId: string, ref: string, offset: number, limit: number): Promise<ArtifactSlice> {
    const trimmed = ref.trim()
    if (!trimmed.startsWith(ARTIFACT_SCHEME)) {
      throw new Error(`referência inválida: "${ref}" (esperava ${ARTIFACT_SCHEME}<tipo>/<hash>)`)
    }
    const rest = trimmed.slice(ARTIFACT_SCHEME.length)
    const slash = rest.indexOf('/')
    if (slash < 0) {
      throw new Error(`referência inválida: "${ref}"`)
    }
    const kind = rest.slice(0, slash)
    const hash = rest.slice(slash + 1)
    // Uma referência vinda de fora não escolhe onde ler: se o safeId mudaria o
    // nome, a referência não é legítima.
    if (safeId(kind) !== kind || safeId(hash) !== hash) {
      throw new Error(`referência inválida: "${ref}"`)
    }
    const path = join(this.#sessionDir(sessionId), 'artifacts', `${kind}-${hash}.txt`)

    // Abre e LÊ SÓ A FATIA — nunca o arquivo inteiro (a lição de heap do
    // oráculo: 60 MB por fetch de 16 KiB). O stat dá o total (e resolve o
    // offset negativo) sem ler um byte; o artefato é imutável depois do
    // rename, então não há corrida com escritor.
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`artefato ${trimmed} não existe nesta conversa`)
      }
      throw error
    }
    try {
      const info = await handle.stat()
      const total = info.size
      if (offset < 0) {
        // Offset negativo lê do FIM — o jeito natural de pedir "as últimas N
        // linhas do log" sem saber o tamanho.
        offset = total + offset
      }
      if (offset < 0) offset = 0
      if (offset >= total) return { chunk: '', total }
      if (limit <= 0) limit = 16 * 1024
      const end = Math.min(offset + limit, total)
      const buffer = Buffer.alloc(end - offset)
      await handle.read(buffer, 0, buffer.length, offset)
      return { chunk: buffer.toString('utf8'), total }
    } finally {
      await handle.close()
    }
  }
}
