/**
 * O roteador HTTP mínimo — e o SEAM para o dia em que o Hono for homologado.
 *
 * O m1-plano citava Hono, mas hono/@hono/* aguardam parecer TI/SI e a regra da
 * casa é homologação por dependência: o transporte nasce DEP-FREE sobre
 * node:http. Este arquivo é deliberadamente pequeno porque a nossa necessidade
 * é pequena (rotas literais, sem params, sem middleware em árvore), e porque
 * ele é o que será SUBSTITUÍDO: os consumidores (plugin.ts e quem vier)
 * dependem de `RoteadorHttp`, nunca do MiniRoteador — quando/se o Hono entrar,
 * um adapter implementa a interface sobre ele e nenhuma linha de transporte
 * muda. É a mesma regra de dependência do harness: consumidor depende do seam.
 *
 * O formato dos corpos JSON (ok/fail) é o do transport/http.go do oráculo —
 * `{"error":{"code","message"}}` — porque o desktop atual já sabe ler esse
 * envelope de erro e a paridade da E9 compara telas, não gostos.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Um tratador de rota. Erro não capturado aqui vira 500 no despacho. */
export type Tratador = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * O seam de roteamento. É de propósito o MENOR contrato que atende o
 * transporte de hoje: registrar rota literal e despachar. Params de caminho
 * ({id}) entram aqui quando a primeira rota precisar deles — alargar o seam
 * antes da necessidade é desenhar para um Hono imaginário.
 */
export interface RoteadorHttp {
  rota(metodo: string, caminho: string, tratador: Tratador): void
  /** Despacha a requisição. A resposta SEMPRE sai daqui (404/405 inclusos). */
  despachar(req: IncomingMessage, res: ServerResponse): Promise<void>
}

/** Escreve uma resposta JSON de sucesso (a forma do `ok` do oráculo). */
export function respondeJson(res: ServerResponse, status: number, valor: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(valor))
}

/** Escreve o envelope de erro que o desktop já sabe ler (a forma do `fail` do oráculo). */
export function respondeErro(res: ServerResponse, status: number, code: string, message: string): void {
  respondeJson(res, status, { error: { code, message } })
}

export interface MiniRoteadorOptions {
  /**
   * Origens liberadas no CORS das rotas HTTP. A MESMA lista do WebSocket, de
   * propósito: duas listas para a mesma pergunta ("essa página pode falar com
   * o servidor?") divergem — e a divergência aqui é falha de segurança.
   */
  allowOrigins?: readonly string[]
}

export class MiniRoteador implements RoteadorHttp {
  /** `METODO caminho` → tratador. Rotas são literais e a colisão é erro de montagem. */
  readonly #rotas = new Map<string, Tratador>()
  /** Caminhos conhecidos, para distinguir 404 (rota não existe) de 405 (método errado). */
  readonly #caminhos = new Set<string>()
  readonly #allowOrigins: readonly string[]

  constructor(options?: MiniRoteadorOptions) {
    this.#allowOrigins = options?.allowOrigins ?? []
  }

  rota(metodo: string, caminho: string, tratador: Tratador): void {
    const chave = `${metodo.toUpperCase()} ${caminho}`
    if (this.#rotas.has(chave)) {
      throw new Error(`rota duplicada: ${chave} — dois donos para o mesmo caminho é conflito de montagem`)
    }
    this.#rotas.set(chave, tratador)
    this.#caminhos.add(caminho)
  }

  async despachar(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS antes de tudo: o preflight OPTIONS não pertence a rota nenhuma.
    const origin = primeiro(req.headers.origin)
    if (origin !== undefined && origemLiberada(origin, this.#allowOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, accept')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Só o caminho decide a rota — query não participa do roteamento.
    const caminho = (req.url ?? '/').split('?', 1)[0]!
    const tratador = this.#rotas.get(`${req.method ?? 'GET'} ${caminho}`)
    if (tratador === undefined) {
      if (this.#caminhos.has(caminho)) {
        respondeErro(res, 405, 'method_not_allowed', 'método não suportado nesta rota')
      } else {
        respondeErro(res, 404, 'not_found', 'rota desconhecida')
      }
      return
    }
    try {
      await tratador(req, res)
    } catch (erro) {
      // O detalhe do erro fica no processo, não na resposta: mensagem interna
      // detalhada é ajuda para quem está sondando.
      if (!res.headersSent) {
        respondeErro(res, 500, 'internal', 'erro interno')
      } else {
        res.end()
      }
      throw erro
    }
  }
}

function primeiro(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header
}

/** A comparação do cors do oráculo: caixa livre e barra final tolerada. */
function origemLiberada(origin: string, allowed: readonly string[]): boolean {
  const alvo = origin.replace(/\/+$/, '').toLowerCase()
  return allowed.some((candidata) => candidata.replace(/\/+$/, '').toLowerCase() === alvo)
}
