/**
 * O PuterFs contra uma conta Puter DE VERDADE, por HTTP (fetch nativo).
 *
 * PENDÊNCIA DECLARADA (spec / plano Onda 6): não há conta nem rede real nesta
 * estação, então este cliente NÃO é exercido pelos testes — quem prova a Onda 6
 * é o FakePuterFs. Ele existe para que a troca "fake → real" seja de UMA linha
 * na montagem, e para dar ao TI/SI algo concreto para revisar.
 *
 * Por que fetch próprio e não o SDK oficial do Puter (`@heyputer/puter` /
 * `puter` no browser): MENOR superfície de homologação. O SDK é orientado a
 * browser (window.puter), traz dependências e um runtime de auth que não cabe
 * num worker headless; nós já precisamos só de mkdir/write/read/readdir/exists.
 * É a MESMA escolha que fizemos no gateway (cliente HTTP stdlib em vez de puxar
 * um SDK) — zero dependência nova, contrato pequeno, revisão barata.
 *
 * As ROTAS abaixo seguem a API de filesystem documentada do Puter, mas estão
 * marcadas como A CONFIRMAR: sem conta real não dá para garantir corpo/rota, e
 * por isso `endpoints` é injetável — uma integração real corrige o mapeamento
 * sem reescrever a lógica. Autentica com Bearer; o token NUNCA vai em URL nem
 * em log (regra da casa: segredo não trafega em query string).
 */

import type { PuterEntry, PuterFs } from '@aibot2/plugin-puter-workspace'

export interface PuterHttpOptions {
  /** Base da API do Puter (ex.: https://api.puter.com). */
  baseUrl: string
  /** Token de conta (Bearer). Fornecido pelo cofre, nunca embutido. */
  token: string
  /** fetch injetável (teste/proxy); default é o global. */
  fetch?: typeof fetch
}

export class HttpPuterFs implements PuterFs {
  readonly #baseUrl: string
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(options: PuterHttpOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async mkdir(path: string): Promise<void> {
    // create_missing_parents = mkdir -p; dedupe_name evita erro se já existe.
    await this.#json('/mkdir', { path, create_missing_parents: true, dedupe_name: false })
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    // O /write do Puter recebe multipart: o caminho e o arquivo. FormData/Blob
    // são nativos no Node 24 — sem dependência de terceiros.
    const form = new FormData()
    form.set('path', path)
    // Buffer.from(uint8array) copia os bytes; Blob(Buffer) evita depender do
    // tipo BlobPart do DOM (este pacote compila só com a lib do Node).
    form.set('file', new Blob([Buffer.from(data)]))
    const response = await this.#fetch(`${this.#baseUrl}/write`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}` },
      body: form,
    })
    await this.#ensureOk(response, 'write', path)
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this.#fetch(`${this.#baseUrl}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    await this.#ensureOk(response, 'read', path)
    return new Uint8Array(await response.arrayBuffer())
  }

  async readdir(path: string): Promise<PuterEntry[]> {
    const items = await this.#json('/readdir', { path })
    if (!Array.isArray(items)) {
      throw new Error(`readdir de "${path}" não devolveu uma lista`)
    }
    // O Puter marca pasta com is_dir; normalizamos para o nosso PuterEntry.
    return items.map((item: { name: string; is_dir?: boolean }) => ({
      name: item.name,
      isDirectory: item.is_dir === true,
    }))
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.#fetch(`${this.#baseUrl}/stat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (response.status === 404) return false
    await this.#ensureOk(response, 'stat', path)
    return true
  }

  /* ------------------------------ internos ------------------------------- */

  async #json(route: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    await this.#ensureOk(response, route, '')
    const text = await response.text()
    return text === '' ? undefined : JSON.parse(text)
  }

  async #ensureOk(response: Response, op: string, path: string): Promise<void> {
    if (response.ok) return
    // A mensagem não vaza o token (só a rota e o alvo): erro é log, log é leitura.
    throw new Error(`Puter ${op} "${path}" falhou: HTTP ${response.status}`)
  }
}
