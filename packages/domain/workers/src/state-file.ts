/**
 * Persistência da frota em arquivo JSON — porte do writeJSONFile do fleet.go.
 *
 * temp + fsync + rename E fsync ANTES do rename: o lease é o guardião da
 * cerca, e uma época perdida numa queda deixaria um resultado velho passar
 * por atual. A frequência é por tarefa/heartbeat, não por token — o fsync
 * aqui não dói.
 *
 * Windows primeiro (RS6): o descritor é FECHADO antes do rename — rename
 * sobre descritor aberto falha no Windows, e é exatamente o tipo de defeito
 * que só aparece na máquina da casa. Implementado sobre node:fs puro: a
 * disciplina manual documentada do m0 §3.3, mais barata que homologar
 * write-file-atomic.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import type { FleetState, LeaseRecord } from './fleet.js'
import type { WorkerRecord } from './worker.js'

function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp`
  const fd = openSync(temp, 'w')
  try {
    writeSync(fd, JSON.stringify(value, null, 1))
    fsyncSync(fd)
  } finally {
    // Fechar SEMPRE, e antes do rename — a regra do Windows.
    closeSync(fd)
  }
  try {
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // O lixo do temp é melhor-esforço; o erro que importa é o do rename.
    }
    throw error
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    // Arquivo ausente (primeira subida) ou corrompido: começa vazio. Para o
    // LEASE isso é seguro na direção certa — época "perdida" recomeça em 1 e
    // NUNCA valida um plano velho (a cerca compara igualdade, não ordem).
    return fallback
  }
}

/** FleetState em disco, num diretório próprio. */
export class JsonFileFleetState implements FleetState {
  readonly #workersPath: string
  readonly #leasesPath: string

  constructor(dir: string) {
    if (dir.trim() === '') {
      throw new Error('frota sem diretório de dados')
    }
    mkdirSync(dir, { recursive: true })
    this.#workersPath = join(dir, 'workers.json')
    this.#leasesPath = join(dir, 'leases.json')
  }

  loadWorkers(): Record<string, WorkerRecord> {
    return readJson(this.#workersPath, {})
  }

  saveWorkers(workers: Record<string, WorkerRecord>): void {
    writeJsonAtomic(this.#workersPath, workers)
  }

  loadLeases(): Record<string, LeaseRecord> {
    return readJson(this.#leasesPath, {})
  }

  saveLeases(leases: Record<string, LeaseRecord>): void {
    writeJsonAtomic(this.#leasesPath, leases)
  }
}
