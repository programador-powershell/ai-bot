/**
 * Aceite da configuração por ambiente: padrões suficientes, bind validado e —
 * o que importa de verdade — o token materializado UMA vez e nunca regerado
 * (regerar invalidaria o token que o host já leu).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  BIND_PADRAO,
  ConfigInvalidaError,
  ENV_ALLOW_ORIGINS,
  ENV_BIND,
  ENV_DATA_DIR,
  ENV_TOKEN,
  ORIGENS_PADRAO,
  carregarConfig,
  materializarSegredo,
  parseBind,
} from './config.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function novoDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibot2-config-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('parseBind', () => {
  it('separa host e porta e valida a faixa', () => {
    expect(parseBind('127.0.0.1:8799')).toEqual({ host: '127.0.0.1', port: 8799 })
    expect(parseBind(BIND_PADRAO)).toEqual({ host: '127.0.0.1', port: 8799 })
    expect(() => parseBind('semporta')).toThrow(ConfigInvalidaError)
    expect(() => parseBind('host:')).toThrow(ConfigInvalidaError)
    expect(() => parseBind('host:99999')).toThrow(ConfigInvalidaError)
  })
})

describe('token materializado', () => {
  it('primeiro boot sorteia e grava; os seguintes LEEM o mesmo — nunca regerar', () => {
    const dir = novoDataDir()
    const caminho = join(dir, 'token')
    const primeiro = materializarSegredo(caminho, 32)
    expect(primeiro.length).toBeGreaterThan(40) // 32 bytes em base64
    const segundo = materializarSegredo(caminho, 32)
    expect(segundo).toBe(primeiro)
    expect(readFileSync(caminho, 'utf8').trim()).toBe(primeiro)
  })

  it('arquivo de segredo vazio é erro alto, nunca motivo para gerar outro', () => {
    const dir = novoDataDir()
    const caminho = join(dir, 'token')
    writeFileSync(caminho, '   \n')
    expect(() => materializarSegredo(caminho, 32)).toThrow(ConfigInvalidaError)
  })
})

describe('carregarConfig', () => {
  it('sem nenhuma variável (além do dataDir do teste) devolve uma config que sobe', () => {
    const dir = novoDataDir()
    const config = carregarConfig({ [ENV_DATA_DIR]: dir })
    expect(config.dataDir).toBe(dir)
    expect(`${config.host}:${config.port}`).toBe(BIND_PADRAO)
    expect(config.token).not.toBe('')
    expect(config.allowOrigins).toEqual(ORIGENS_PADRAO)
  })

  it('o ambiente vence o padrão: bind, token e origens', () => {
    const dir = novoDataDir()
    const config = carregarConfig({
      [ENV_DATA_DIR]: dir,
      [ENV_BIND]: '127.0.0.1:9123',
      [ENV_TOKEN]: 'token-do-host',
      [ENV_ALLOW_ORIGINS]: 'http://localhost:1421, tauri://localhost',
    })
    expect(config.port).toBe(9123)
    expect(config.token).toBe('token-do-host')
    expect(config.allowOrigins).toEqual(['http://localhost:1421', 'tauri://localhost'])
  })

  it('token do ambiente NÃO materializa arquivo — o segredo do host fica com o host', () => {
    const dir = novoDataDir()
    carregarConfig({ [ENV_DATA_DIR]: dir, [ENV_TOKEN]: 'token-do-host' })
    expect(() => readFileSync(join(dir, 'token'))).toThrow()
  })
})
