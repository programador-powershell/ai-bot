/**
 * Um Puter FALSO em memória — fiel ao CONTRATO, não à rede. É com ele que a
 * Onda 6 se prova: não há conta nem rede real (pendência declarada), então o
 * fake é o oráculo do que o backend faz. Fica AQUI, junto do contrato, para o
 * provider reusar sem inverter a dependência (o provider depende do plugin,
 * não o contrário).
 *
 * Fidelidade que importa para os aceites: `readFile`/`readdir` LANÇAM no que
 * não existe (nada de vazio silencioso mascarando um "não promoveu"), e
 * `paths()` deixa o teste afirmar "o promovido apareceu e o descartável NUNCA".
 */

import type { PuterEntry, PuterFs } from './fs.js'

/** Normaliza para caminho absoluto, barra `/`, sem barra final (exceto raiz). */
function norm(path: string): string {
  let s = path.replaceAll('\\', '/')
  if (!s.startsWith('/')) s = `/${s}`
  s = s.replace(/\/+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}

function baseName(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

export class FakePuterFs implements PuterFs {
  readonly #files = new Map<string, Uint8Array>()
  readonly #dirs = new Set<string>(['/'])

  async mkdir(path: string): Promise<void> {
    let cur = norm(path)
    // Sobe até a raiz criando cada ancestral — mkdir recursivo, idempotente.
    for (;;) {
      this.#dirs.add(cur)
      if (cur === '/') break
      cur = parentOf(cur)
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const p = norm(path)
    if (this.#dirs.has(p)) {
      throw new Error(`"${p}" é uma pasta, não dá para escrever como arquivo`)
    }
    await this.mkdir(parentOf(p))
    // Cópia defensiva: o chamador não muda o byte já "gravado" por referência.
    this.#files.set(p, Uint8Array.from(data))
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = norm(path)
    const found = this.#files.get(p)
    if (found === undefined) {
      throw new Error(`arquivo inexistente no Puter: ${p}`)
    }
    return Uint8Array.from(found)
  }

  async readdir(path: string): Promise<PuterEntry[]> {
    const p = norm(path)
    if (!this.#dirs.has(p)) {
      throw new Error(`pasta inexistente no Puter: ${p}`)
    }
    const byName = new Map<string, PuterEntry>()
    for (const dir of this.#dirs) {
      if (dir !== p && parentOf(dir) === p) {
        byName.set(baseName(dir), { name: baseName(dir), isDirectory: true })
      }
    }
    for (const file of this.#files.keys()) {
      if (parentOf(file) === p && !byName.has(baseName(file))) {
        byName.set(baseName(file), { name: baseName(file), isDirectory: false })
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async exists(path: string): Promise<boolean> {
    const p = norm(path)
    return this.#files.has(p) || this.#dirs.has(p)
  }

  /* --------- ajudas de teste (não fazem parte do contrato PuterFs) -------- */

  /** Todos os caminhos de ARQUIVO, ordenados — o retrato para afirmar o que subiu. */
  paths(): string[] {
    return [...this.#files.keys()].sort()
  }

  /** O conteúdo de um arquivo como texto UTF-8 (conveniência de asserção). */
  text(path: string): string {
    const found = this.#files.get(norm(path))
    if (found === undefined) {
      throw new Error(`arquivo inexistente no Puter: ${norm(path)}`)
    }
    return new TextDecoder().decode(found)
  }
}
