/**
 * Aceite do seam RoteadorHttp — a MESMA bateria contra as DUAS implementações
 * ([Onda 2] o Hono é a produção do chassis, o MiniRoteador é o dublê): rodar o
 * contrato uma vez por implementação é o que garante que o dublê não minta —
 * despacho literal, 404×405, colisão barulhenta, o envelope de erro do oráculo
 * e o CORS com a MESMA régua de origem do WebSocket.
 */

import { describe, expect, it } from 'vitest'

import { MiniRoteador, respondeErro, respondeJson, type RoteadorHttp } from './router.js'
import { RoteadorHono } from './router-hono.js'

const BASE = 'http://127.0.0.1'

const implementacoes: Array<{
  nome: string
  criar: (opts?: { allowOrigins?: readonly string[] }) => RoteadorHttp
}> = [
  { nome: 'RoteadorHono (produção do chassis)', criar: (opts) => new RoteadorHono(opts) },
  { nome: 'MiniRoteador (dublê clean-room)', criar: (opts) => new MiniRoteador(opts) },
]

for (const { nome, criar } of implementacoes) {
  describe(`despacho — ${nome}`, () => {
    it('rota registrada responde; caminho desconhecido é 404 com o envelope do oráculo', async () => {
      const roteador = criar()
      roteador.rota('GET', '/health', () => respondeJson(200, { status: 'ok' }))

      const ok = await roteador.despachar(new Request(`${BASE}/health`))
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ status: 'ok' })

      const sumida = await roteador.despachar(new Request(`${BASE}/nada`))
      expect(sumida.status).toBe(404)
      expect(await sumida.json()).toEqual({
        error: { code: 'not_found', message: 'rota desconhecida' },
      })
    })

    it('método errado numa rota que EXISTE é 405, não 404 — são diagnósticos diferentes', async () => {
      const roteador = criar()
      roteador.rota('GET', '/health', () => respondeJson(200, {}))
      const resposta = await roteador.despachar(new Request(`${BASE}/health`, { method: 'POST' }))
      expect(resposta.status).toBe(405)
    })

    it('rota duplicada é conflito de MONTAGEM — estoura no registro, não no despacho', () => {
      const roteador = criar()
      roteador.rota('GET', '/x', () => respondeJson(200, {}))
      expect(() => roteador.rota('get', '/x', () => respondeJson(200, {}))).toThrow(/rota duplicada/)
    })

    it('tratador que estoura vira 500 opaco — o detalhe fica no processo, não na resposta', async () => {
      const roteador = criar()
      roteador.rota('GET', '/quebra', () => {
        throw new Error('segredo interno: caminho c:\\dados')
      })
      const resposta = await roteador.despachar(new Request(`${BASE}/quebra`))
      expect(resposta.status).toBe(500)
      const corpo = (await resposta.json()) as { error: { message: string } }
      expect(corpo.error.message).toBe('erro interno')
      expect(corpo.error.message).not.toContain('segredo')
    })

    it('a query não participa do roteamento — só o caminho decide a rota', async () => {
      const roteador = criar()
      roteador.rota('GET', '/health', () => respondeJson(200, { status: 'ok' }))
      const resposta = await roteador.despachar(new Request(`${BASE}/health?x=1`))
      expect(resposta.status).toBe(200)
    })
  })

  describe(`CORS (a mesma régua de origem do WebSocket) — ${nome}`, () => {
    it('origem liberada ganha os cabeçalhos; origem estranha não ganha nada', async () => {
      const roteador = criar({ allowOrigins: ['http://localhost:1421'] })
      roteador.rota('GET', '/health', () => respondeJson(200, {}))

      const liberada = await roteador.despachar(
        new Request(`${BASE}/health`, { headers: { Origin: 'http://localhost:1421' } }),
      )
      expect(liberada.headers.get('access-control-allow-origin')).toBe('http://localhost:1421')

      const estranha = await roteador.despachar(
        new Request(`${BASE}/health`, { headers: { Origin: 'https://mal.example' } }),
      )
      expect(estranha.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('preflight OPTIONS responde 204 sem pertencer a rota nenhuma', async () => {
      const roteador = criar({ allowOrigins: ['http://localhost:1421'] })
      const resposta = await roteador.despachar(
        new Request(`${BASE}/qualquer`, {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:1421' },
        }),
      )
      expect(resposta.status).toBe(204)
      expect(resposta.headers.get('access-control-allow-methods')).toContain('POST')
    })
  })
}

describe('respondeErro', () => {
  it('escreve o envelope {error:{code,message}} que o desktop já sabe ler', async () => {
    const resposta = respondeErro(403, 'forbidden', 'sem acesso')
    expect(resposta.status).toBe(403)
    expect(await resposta.json()).toEqual({ error: { code: 'forbidden', message: 'sem acesso' } })
  })
})

describe('despacharSeSua (a convivência com o app forkado no mesmo Bun.serve)', () => {
  it('responde o que é seu e devolve undefined para o resto seguir ao app', async () => {
    const roteador = new RoteadorHono()
    roteador.rota('GET', '/health', () => respondeJson(200, { status: 'ok' }))

    const sua = await roteador.despacharSeSua(new Request(`${BASE}/health`))
    expect(sua?.status).toBe(200)

    // Método errado num caminho SEU ainda é resposta sua (405): deixar passar
    // faria o app forkado responder por uma rota que não é dele.
    const metodoErrado = await roteador.despacharSeSua(
      new Request(`${BASE}/health`, { method: 'POST' }),
    )
    expect(metodoErrado?.status).toBe(405)

    const alheia = await roteador.despacharSeSua(new Request(`${BASE}/api/agents`))
    expect(alheia).toBeUndefined()
  })
})
