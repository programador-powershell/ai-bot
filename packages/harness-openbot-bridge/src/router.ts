/**
 * O seam de roteamento HTTP — e as suas DUAS implementações.
 *
 * [Onda 2 da integração] Com o Bun 1.4 e o fork do chassis homologados, o Hono
 * entrou (plano §4.2): `RoteadorHono` (router-hono.ts) é a implementação de
 * PRODUÇÃO, e o `MiniRoteador` clean-room deste arquivo vira o dublê de teste
 * — exatamente a troca que o seam existia para permitir. O contrato mudou de
 * node:http (IncomingMessage/ServerResponse) para fetch (Request/Response) no
 * mesmo passo, porque o chassis serve por `Bun.serve` e o Hono fala fetch
 * nativamente; o transporte Node (plugin.ts, hoje dublê) adapta na borda dele.
 *
 * O formato dos corpos JSON (ok/fail) é o do transport/http.go do oráculo —
 * `{"error":{"code","message"}}` — porque o desktop atual já sabe ler esse
 * envelope de erro e a paridade compara telas, não gostos.
 */

/** Um tratador de rota. Erro não capturado aqui vira 500 opaco no despacho. */
export type Tratador = (req: Request) => Response | Promise<Response>

/**
 * O seam de roteamento. É de propósito o MENOR contrato que atende o
 * transporte de hoje: registrar rota literal e despachar. Params de caminho
 * ({id}) entram aqui quando a primeira rota precisar deles — alargar o seam
 * antes da necessidade é desenhar para necessidades imaginárias.
 */
export interface RoteadorHttp {
  rota(metodo: string, caminho: string, tratador: Tratador): void
  /** Despacha a requisição. A resposta SEMPRE sai daqui (404/405 inclusos). */
  despachar(req: Request): Promise<Response>
}

/** Escreve uma resposta JSON de sucesso (a forma do `ok` do oráculo). */
export function respondeJson(status: number, valor: unknown): Response {
  return new Response(JSON.stringify(valor), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** O envelope de erro que o desktop já sabe ler (a forma do `fail` do oráculo). */
export function respondeErro(status: number, code: string, message: string): Response {
  return respondeJson(status, { error: { code, message } })
}

export interface RoteadorOptions {
  /**
   * Origens liberadas no CORS das rotas HTTP. A MESMA lista do WebSocket, de
   * propósito: duas listas para a mesma pergunta ("essa página pode falar com
   * o servidor?") divergem — e a divergência aqui é falha de segurança.
   */
  allowOrigins?: readonly string[]
}

/** A comparação do cors do oráculo: caixa livre e barra final tolerada. */
export function origemLiberada(origin: string, allowed: readonly string[]): boolean {
  const alvo = origin.replace(/\/+$/, '').toLowerCase()
  return allowed.some((candidata) => candidata.replace(/\/+$/, '').toLowerCase() === alvo)
}

/**
 * Os cabeçalhos de CORS numa resposta já montada. Compartilhado entre as duas
 * implementações do seam para a régua ser UMA — um MiniRoteador que liberasse
 * uma origem que o RoteadorHono nega tornaria o dublê de teste uma mentira.
 */
export function aplicarCors(
  resposta: Response,
  origin: string | null,
  allowOrigins: readonly string[],
): Response {
  if (origin === null || !origemLiberada(origin, allowOrigins)) return resposta
  resposta.headers.set('Access-Control-Allow-Origin', origin)
  resposta.headers.set('Vary', 'Origin')
  resposta.headers.set('Access-Control-Allow-Headers', 'authorization, content-type, accept')
  resposta.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  return resposta
}

/**
 * O roteador mínimo clean-room — hoje o DUBLÊ de teste do seam (e o roteador
 * do transporte Node, que é ele próprio o dublê do transporte do chassis).
 * Deliberadamente pequeno: rotas literais, sem params, sem middleware.
 */
export class MiniRoteador implements RoteadorHttp {
  /** `METODO caminho` → tratador. Rotas são literais e a colisão é erro de montagem. */
  readonly #rotas = new Map<string, Tratador>()
  /** Caminhos conhecidos, para distinguir 404 (rota não existe) de 405 (método errado). */
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
    this.#rotas.set(chave, tratador)
    this.#caminhos.add(caminho)
  }

  async despachar(req: Request): Promise<Response> {
    const origin = req.headers.get('origin')

    // CORS antes de tudo: o preflight OPTIONS não pertence a rota nenhuma.
    if (req.method === 'OPTIONS') {
      return aplicarCors(new Response(null, { status: 204 }), origin, this.#allowOrigins)
    }

    // Só o caminho decide a rota — query não participa do roteamento.
    const caminho = new URL(req.url).pathname
    const tratador = this.#rotas.get(`${req.method} ${caminho}`)
    if (tratador === undefined) {
      const recusa = this.#caminhos.has(caminho)
        ? respondeErro(405, 'method_not_allowed', 'método não suportado nesta rota')
        : respondeErro(404, 'not_found', 'rota desconhecida')
      return aplicarCors(recusa, origin, this.#allowOrigins)
    }
    let resposta: Response
    try {
      resposta = await tratador(req)
    } catch {
      // O detalhe do erro fica no processo, não na resposta: mensagem interna
      // detalhada é ajuda para quem está sondando.
      resposta = respondeErro(500, 'internal', 'erro interno')
    }
    return aplicarCors(resposta, origin, this.#allowOrigins)
  }
}
