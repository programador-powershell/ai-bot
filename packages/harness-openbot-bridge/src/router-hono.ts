/**
 * [Onda 2] A implementação HONO do seam RoteadorHttp — a de PRODUÇÃO do
 * chassis (plano §4.2: "o RoteadorHttp ganha a implementação Hono; o roteador
 * mínimo clean-room vira o dublê de testes").
 *
 * O Hono faz o que ele faz melhor: guardar e despachar os tratadores no mundo
 * fetch. O que fica FORA dele, de propósito, são as três decisões que o
 * oráculo fixou e que não podem depender de default de framework:
 *  - o envelope de erro `{"error":{"code","message"}}` nos 404/405/500 (o
 *    desktop já sabe ler exatamente isso);
 *  - a distinção 404×405 (são diagnósticos diferentes — o Hono sozinho
 *    responde 404 para os dois);
 *  - o CORS com a MESMA régua de origem do WebSocket (aplicarCors), em vez do
 *    middleware de cors do Hono com uma segunda lista.
 *
 * `despacharSeSua` existe para a montagem do chassis: o Bun.serve recebe UM
 * fetch, e as rotas do transporte convivem com as do app forkado — o roteador
 * responde só o que é dele e devolve undefined para o resto seguir adiante.
 */

import { Hono } from 'hono'

import {
  aplicarCors,
  respondeErro,
  type RoteadorHttp,
  type RoteadorOptions,
  type Tratador,
} from './router.js'

export class RoteadorHono implements RoteadorHttp {
  readonly #hono = new Hono()
  /** `METODO caminho` registrados — a colisão é erro de montagem, como no dublê. */
  readonly #rotas = new Set<string>()
  /** Caminhos conhecidos, para o 405 ser 405 e não 404. */
  readonly #caminhos = new Set<string>()
  readonly #allowOrigins: readonly string[]

  constructor(options?: RoteadorOptions) {
    this.#allowOrigins = options?.allowOrigins ?? []
  }

  rota(metodo: string, caminho: string, tratador: Tratador): void {
    const chave = `${metodo.toUpperCase()} ${caminho}`
    if (this.#rotas.has(chave)) {
      throw new Error(`rota duplicada: ${chave} — dois donos para o mesmo caminho é conflito de montagem`)
    }
    this.#rotas.add(chave)
    this.#caminhos.add(caminho)
    this.#hono.on(metodo.toUpperCase(), caminho, async (contexto) => {
      try {
        return await tratador(contexto.req.raw)
      } catch {
        // O detalhe fica no processo, nunca na resposta (a régua do oráculo).
        return respondeErro(500, 'internal', 'erro interno')
      }
    })
  }

  async despachar(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')

    if (req.method === 'OPTIONS') {
      return aplicarCors(new Response(null, { status: 204 }), origin, this.#allowOrigins)
    }

    const caminho = new URL(req.url).pathname
    if (!this.#rotas.has(`${req.method} ${caminho}`)) {
      const recusa = this.#caminhos.has(caminho)
        ? respondeErro(405, 'method_not_allowed', 'método não suportado nesta rota')
        : respondeErro(404, 'not_found', 'rota desconhecida')
      return aplicarCors(recusa, origin, this.#allowOrigins)
    }
    return aplicarCors(await this.#hono.fetch(req), origin, this.#allowOrigins)
  }

  /**
   * Despacha SÓ se a rota é deste roteador (preflight incluso quando o caminho
   * é conhecido); undefined deixa a requisição para o próximo dono no fetch.
   */
  async despacharSeSua(req: Request): Promise<Response | undefined> {
    const caminho = new URL(req.url).pathname
    if (!this.#caminhos.has(caminho)) return undefined
    return this.despachar(req)
  }
}
