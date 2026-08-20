/**
 * O snapshot em duas camadas: BASE RUNTIME + DEPENDENCY SNAPSHOT
 * (arquitetura-cluster.md, "Snapshot em duas camadas").
 *
 * Três decisões do desenho, cada uma com o porquê:
 *
 * - **A chave inclui a base.** `8ac927` sozinho colidiria entre python-3.12 e
 *   python-3.11 — a chave é o PAR (`python-3.12/8ac927`), e a base também
 *   entra no hash para que a mesma lista de locks sob bases diferentes não
 *   produza o mesmo digest.
 * - **A impressão digital é do LOCK, não do manifesto solto.** requirements.txt
 *   com `>=` não determina o que foi instalado; o lockfile sim. Por isso
 *   `pickLockFiles` filtra e o fingerprint só aceita o que determina versões.
 * - **Nunca é fonte de verdade.** O snapshot é cache descartável: sumir é
 *   sempre seguro (a próxima tarefa reinstala). Nenhum segredo entra no hash —
 *   quem chama passa manifests de dependência, e a lista fechada de locks
 *   garante que um .env passado por engano é IGNORADO, não fingerprintado.
 */

import { createHash } from 'node:crypto'

/** Um arquivo candidato ao fingerprint. */
export interface ManifestFile {
  /** Nome-base do arquivo ("pnpm-lock.yaml"), sem caminho. */
  name: string
  content: string
}

/** O snapshot resolvido: a chave de cache que o inventário por PC indexa. */
export interface SnapshotKey {
  base: string
  digest: string
  /** `base/digest` — a chave completa, como o inventário e o scheduler a usam. */
  key: string
}

/**
 * Metadado de snapshot no estado compartilhado (o índice). A IMAGEM é
 * descartável; este registro diz onde ela está aquecida — é dado de
 * escalonamento (localidade), nunca verdade sobre o trabalho.
 */
export interface SnapshotIndexEntry {
  base: string
  digest: string
  image?: string
  lastUsedAt?: string
  /** Em quais PCs a imagem já está em cache. */
  workers?: string[]
}

/**
 * A lista FECHADA de arquivos que determinam dependências instaladas. Fechada
 * de propósito: "não classificado positivamente como lock = não entra" é a
 * mesma régua fail-closed do catálogo MCP — e é o que impede um arquivo com
 * segredo de entrar no hash por engano.
 */
export const LOCK_FILES: readonly string[] = Object.freeze([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'requirements.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'go.sum',
  'Cargo.lock',
  'gradle.lockfile',
  'composer.lock',
  'Gemfile.lock',
])

const lockSet: ReadonlySet<string> = new Set(LOCK_FILES)

/** Filtra os arquivos que PODEM alimentar o fingerprint (só locks). */
export function pickLockFiles(files: readonly ManifestFile[]): ManifestFile[] {
  return files.filter((file) => lockSet.has(file.name))
}

/**
 * Calcula a chave de snapshot de uma base + locks.
 *
 * Determinística por construção: os locks entram ORDENADOS por nome (a ordem
 * de quem chamou não pode mudar o digest) e cada entrada é separada por NUL
 * (nome e conteúdo concatenados sem separador colidiriam: "a"+"bc" == "ab"+"c").
 * O digest é curto (6 hex) porque a chave é de CACHE com a base junto — não é
 * endereçamento de conteúdo de verdade, e o exemplo do desenho
 * (`python-3.12/8ac927`) fixa a largura.
 */
export function snapshotFingerprint(base: string, files: readonly ManifestFile[]): SnapshotKey {
  const trimmedBase = base.trim()
  if (trimmedBase === '') {
    throw new Error('fingerprint sem base runtime — a chave é o par base/digest')
  }
  const locks = pickLockFiles(files)
  if (locks.length === 0) {
    throw new Error(
      'fingerprint sem lockfile — manifesto solto (>=) não determina o que foi instalado',
    )
  }
  const hash = createHash('sha256')
  hash.update(trimmedBase)
  hash.update('\0')
  for (const lock of [...locks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(lock.name)
    hash.update('\0')
    hash.update(lock.content)
    hash.update('\0')
  }
  const digest = hash.digest('hex').slice(0, 6)
  return { base: trimmedBase, digest, key: `${trimmedBase}/${digest}` }
}
