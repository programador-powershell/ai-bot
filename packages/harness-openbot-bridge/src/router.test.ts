/**
 * Aceite do roteador mínimo (o seam que o Hono, se homologado, substituirá):
 * despacho literal, 404×405, colisão barulhenta, o envelope de erro do oráculo
 * e o CORS com a MESMA régua de origem do WebSocket.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { MiniRoteador, respondeErro, respondeJson } from './router.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function servir(roteador: MiniRoteador): Promise<number> {
  const http: Server = createServer((req, res) => {
    void roteador.despachar(req, res).catch(() => {})
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections()
        http.close(() => resolve())
      }),
  )
  return (http.address() as AddressInfo).port
}

describe('despacho', () => {
  it('rota registrada responde; caminho desconhecido é 404 com o envelope do oráculo', async () => {
    const roteador = new MiniRoteador()
    roteador.rota('GET', '/health', (_req, res) => respondeJson(res, 200, { status: 'ok' }))
    const porta = await servir(roteador)

    const ok = await fetch(`http://127.0.0.1:${porta}/health`)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ status: 'ok' })

    const sumida = await fetch(`http://127.0.0.1:${porta}/nada`)
    expect(sumida.status).toBe(404)
    expect(await sumida.json()).toEqual({
      error: { code: 'not_found', message: 'rota desconhecida' },
    })
  })

  it('método errado numa rota que EXISTE é 405, não 404 — são diagnósticos diferentes', async () => {
    const roteador = new MiniRoteador()
    roteador.rota('GET', '/health', (_req, res) => respondeJson(res, 200, {}))
    const porta = await servir(roteador)
    const resposta = await fetch(`http://127.0.0.1:${porta}/health`, { method: 'POST' })
    expect(resposta.status).toBe(405)
  })

  it('rota duplicada é conflito de MONTAGEM — estoura no registro, não no despacho', () => {
    const roteador = new MiniRoteador()
    roteador.rota('GET', '/x', () => {})
    expect(() => roteador.rota('get', '/x', () => {})).toThrow(/rota duplicada/)
  })

  it('tratador que estoura vira 500 opaco — o detalhe fica no processo, não na resposta', async () => {
    const roteador = new MiniRoteador()
    roteador.rota('GET', '/quebra', () => {
      throw new Error('segredo interno: caminho c:\\dados')
    })
    const porta = await servir(roteador)
    const resposta = await fetch(`http://127.0.0.1:${porta}/quebra`)
    expect(resposta.status).toBe(500)
    const corpo = (await resposta.json()) as { error: { message: string } }
    expect(corpo.error.message).toBe('erro interno')
    expect(corpo.error.message).not.toContain('segredo')
  })
})

describe('CORS (a mesma régua de origem do WebSocket)', () => {
  it('origem liberada ganha os cabeçalhos; origem estranha não ganha nada', async () => {
    const roteador = new MiniRoteador({ allowOrigins: ['http://localhost:1421'] })
    roteador.rota('GET', '/health', (_req, res) => respondeJson(res, 200, {}))
    const porta = await servir(roteador)

    const liberada = await fetch(`http://127.0.0.1:${porta}/health`, {
      headers: { Origin: 'http://localhost:1421' },
    })
    expect(liberada.headers.get('access-control-allow-origin')).toBe('http://localhost:1421')

    const estranha = await fetch(`http://127.0.0.1:${porta}/health`, {
      headers: { Origin: 'https://mal.example' },
    })
    expect(estranha.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('preflight OPTIONS responde 204 sem pertencer a rota nenhuma', async () => {
    const roteador = new MiniRoteador({ allowOrigins: ['http://localhost:1421'] })
    const porta = await servir(roteador)
    const resposta = await fetch(`http://127.0.0.1:${porta}/qualquer`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:1421' },
    })
    expect(resposta.status).toBe(204)
    expect(resposta.headers.get('access-control-allow-methods')).toContain('POST')
  })
})

describe('respondeErro', () => {
  it('escreve o envelope {error:{code,message}} que o desktop já sabe ler', async () => {
    const roteador = new MiniRoteador()
    roteador.rota('GET', '/negado', (_req, res) => respondeErro(res, 403, 'forbidden', 'sem acesso'))
    const porta = await servir(roteador)
    const resposta = await fetch(`http://127.0.0.1:${porta}/negado`)
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toEqual({ error: { code: 'forbidden', message: 'sem acesso' } })
  })
})
