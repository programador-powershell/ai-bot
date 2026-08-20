/**
 * Aceite da MONTAGEM (aceite 5 do E3): o server sobe kernel + plugins +
 * transporte com config e a lógica mora nos pacotes — o que se prova aqui é
 * que a composição fecha de ponta a ponta: data dir de verdade, porta de
 * verdade, hello de verdade, e o desligamento desfazendo tudo.
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { StoreInUseError, type Envelope } from '@aibot2/domain-events'
// O cliente WS de teste do bridge (subpath próprio para não poluir o índice
// de produção). Exige o bridge COMPILADO — o tsc --build das references cuida.
import { ClienteWsDeTeste } from '@aibot2/harness-openbot-bridge/teste-cliente-ws'

import { montarServidor, type ServidorMontado } from './montagem.js'
import type { ConfigDoServidor } from './config.js'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function novaConfig(token = 'token-da-montagem'): ConfigDoServidor {
  const dataDir = mkdtempSync(join(tmpdir(), 'aibot2-server-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  return { dataDir, host: '127.0.0.1', port: 0, token, allowOrigins: [] }
}

async function montar(config: ConfigDoServidor): Promise<ServidorMontado> {
  const servidor = await montarServidor(config, { log: () => {} })
  cleanups.push(() => servidor.dispose())
  return servidor
}

describe('montagem do servidor', () => {
  it('sobe com data dir de verdade e responde hello → ready pela porta real', async () => {
    const config = novaConfig()
    const servidor = await montar(config)
    expect(servidor.transporte.porta).toBeGreaterThan(0)
    // O event log nasceu DENTRO do data dir configurado.
    expect(existsSync(join(config.dataDir, 'events.db'))).toBe(true)

    const cliente = await ClienteWsDeTeste.conectar(servidor.transporte.porta)
    cleanups.push(() => cliente.destruir())
    cliente.enviarTexto({
      v: 1,
      id: 'h1',
      ts: new Date().toISOString(),
      seq: 0,
      session: '',
      kind: 'hello',
      from: { kind: 'user' },
      payload: { client: 'teste', version: '0.0.1', token: config.token },
    })
    const ready = (await cliente.proximoJson()) as Envelope
    expect(ready.kind).toBe('ready')
    expect((ready.payload as { seq: number }).seq).toBe(0)
    // [Onda 3] O ready anuncia o catálogo REAL do specialist-registry — a
    // observação do conferente da Onda 2 era exatamente "hoje sai vazio".
    const anunciados = (ready.payload as { specialists: string[] }).specialists
    expect(anunciados).toEqual(servidor.ctx.specialists.ids())
    expect(anunciados.length).toBeGreaterThan(0)
  })

  it('a rota /health responde com a forma do oráculo (contagens, nunca conteúdo)', async () => {
    const servidor = await montar(novaConfig())
    const resposta = await fetch(`http://127.0.0.1:${servidor.transporte.porta}/health`)
    expect(resposta.status).toBe(200)
    expect(await resposta.json()).toEqual({
      status: 'ok',
      product: 'AI-BOT',
      protocol: 1,
      // A contagem é do catálogo compilado do registry (montagem completa da
      // Onda 3) — contagens, nunca conteúdo, continua valendo.
      specialists: servidor.ctx.specialists.ids().length,
      models: 0,
    })
    expect(servidor.ctx.specialists.ids().length).toBeGreaterThan(0)
  })

  it('token errado no hello é 1008 — a config chegou inteira ao transporte', async () => {
    const config = novaConfig()
    const servidor = await montar(config)
    const cliente = await ClienteWsDeTeste.conectar(servidor.transporte.porta)
    cleanups.push(() => cliente.destruir())
    cliente.enviarTexto({
      v: 1,
      id: 'h1',
      ts: new Date().toISOString(),
      seq: 0,
      session: '',
      kind: 'hello',
      from: { kind: 'user' },
      payload: { client: 'teste', version: '0.0.1', token: 'outro-token-de-teste!' },
    })
    expect((await cliente.fim()).codigo).toBe(1008)
  })

  it('token vazio derruba a MONTAGEM — subir sem autenticação não é configuração', async () => {
    await expect(montarServidor(novaConfig('  '), { log: () => {} })).rejects.toThrow(/token/)
  })

  it('duas montagens no MESMO data dir falham na subida (um escritor por store)', async () => {
    const config = novaConfig()
    await montar(config)
    await expect(montarServidor(config, { log: () => {} })).rejects.toThrow(StoreInUseError)
  })

  it('dispose desmonta tudo: a porta recusa conexão nova', async () => {
    const config = novaConfig()
    const servidor = await montarServidor(config, { log: () => {} })
    const porta = servidor.transporte.porta
    await servidor.dispose()
    await expect(ClienteWsDeTeste.conectar(porta)).rejects.toThrow()
    // E o store foi liberado: montar de novo no mesmo dataDir funciona.
    const segundo = await montar(config)
    expect(segundo.transporte.porta).toBeGreaterThan(0)
  })
})
