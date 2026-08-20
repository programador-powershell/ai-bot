/**
 * APOIO DE TESTE — um cliente WebSocket mínimo, clean-room, sobre net.Socket.
 *
 * Existe porque os testes do transporte precisam do que o WebSocket global do
 * Node não dá: pausar a LEITURA do socket de verdade (o teste de contrapressão
 * exige um cliente lento real, não um mock de relógio), mandar bytes crus
 * malformados (os testes de violação de protocolo) e inspecionar o close
 * frame (código + motivo). Não é código de produto: quem fala com servidor
 * externo usa fetch/undici.
 *
 * O cliente cumpre a parte DELE da RFC: mascara tudo que envia (o servidor
 * derruba frame sem máscara, de propósito) e responde ping com pong.
 */

import { randomBytes, createHash } from 'node:crypto'
import { connect, type Socket } from 'node:net'

const GUID_DO_WEBSOCKET = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface FimDoCliente {
  /** Código do close frame do servidor; undefined quando o socket caiu sem close. */
  codigo?: number
  motivo?: string
}

export type ItemDoCliente =
  | { tipo: 'mensagem'; opcode: number; payload: Buffer }
  | { tipo: 'fim'; fim: FimDoCliente }
  | { tipo: 'prazo' }

/** Handshake recusado pelo servidor — guarda o status HTTP para asserção. */
export class HandshakeRecusadoError extends Error {
  override name = 'HandshakeRecusadoError'
  constructor(
    readonly status: number,
    readonly corpo: string,
  ) {
    super(`handshake recusado com HTTP ${status}`)
  }
}

export interface OpcoesDoCliente {
  caminho?: string
  host?: string
  /** Cabeçalho Origin — presente só quando o teste finge ser navegador. */
  origem?: string
}

export class ClienteWsDeTeste {
  readonly #socket: Socket
  readonly #itens: Array<{ opcode: number; payload: Buffer }> = []
  #fim: FimDoCliente | undefined
  #acordar: (() => void) | undefined

  /** Bytes recebidos e ainda não consumidos pelo parser. */
  #pendente: Buffer

  private constructor(socket: Socket, sobra: Buffer) {
    this.#socket = socket
    this.#pendente = sobra
    socket.on('data', (pedaco: Buffer) => {
      this.#pendente =
        this.#pendente.length === 0 ? pedaco : Buffer.concat([this.#pendente, pedaco])
      this.#consumir()
    })
    socket.on('close', () => {
      this.#fim ??= {}
      this.#despertar()
    })
    socket.on('error', () => {
      this.#fim ??= {}
      this.#despertar()
    })
    if (this.#pendente.length > 0) queueMicrotask(() => this.#consumir())
  }

  /** Abre a conexão e valida o 101 + Sec-WebSocket-Accept. */
  static async conectar(porta: number, opcoes?: OpcoesDoCliente): Promise<ClienteWsDeTeste> {
    const host = opcoes?.host ?? '127.0.0.1'
    const caminho = opcoes?.caminho ?? '/v1/stream'
    const chave = randomBytes(16).toString('base64')
    const socket = connect(porta, host)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    const linhas = [
      `GET ${caminho} HTTP/1.1`,
      `Host: ${host}:${porta}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${chave}`,
      'Sec-WebSocket-Version: 13',
    ]
    if (opcoes?.origem !== undefined) {
      linhas.push(`Origin: ${opcoes.origem}`)
    }
    socket.write(linhas.join('\r\n') + '\r\n\r\n')

    // Lê até o fim dos cabeçalhos; o que vier depois já é frame.
    const resposta = await lerCabecalhos(socket)
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(resposta.texto)?.[1] ?? '0')
    if (status !== 101) {
      // O corpo pode vir junto da sobra; lê mais um instante para a asserção.
      const corpo = resposta.sobra.toString('utf8')
      socket.destroy()
      throw new HandshakeRecusadoError(status, corpo)
    }
    const aceite = /sec-websocket-accept:\s*(\S+)/i.exec(resposta.texto)?.[1]
    const esperado = createHash('sha1')
      .update(chave + GUID_DO_WEBSOCKET)
      .digest('base64')
    if (aceite !== esperado) {
      socket.destroy()
      throw new Error(`Sec-WebSocket-Accept errado: ${String(aceite)} (esperado ${esperado})`)
    }
    return new ClienteWsDeTeste(socket, resposta.sobra)
  }

  /* -------------------------------- escrita ------------------------------- */

  /** Envia texto num frame MASCARADO (obrigação do cliente pela RFC). */
  enviarTexto(conteudo: string | object): void {
    const texto = typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo)
    this.#socket.write(quadroMascarado(0x1, Buffer.from(texto, 'utf8')))
  }

  /** Bytes crus, sem enquadramento — para os testes de violação de protocolo. */
  enviarBruto(bytes: Buffer): void {
    this.#socket.write(bytes)
  }

  /** Envia o close frame do cliente (código + motivo) e meia-fecha o socket. */
  fechar(codigo = 1000, motivo = ''): void {
    const texto = Buffer.from(motivo, 'utf8')
    const corpo = Buffer.alloc(2 + texto.length)
    corpo.writeUInt16BE(codigo, 0)
    texto.copy(corpo, 2)
    this.#socket.write(quadroMascarado(0x8, corpo))
  }

  destruir(): void {
    this.#socket.destroy()
  }

  /* -------------------------------- leitura ------------------------------- */

  /** PAUSA a leitura do socket de verdade — o kernel para de drenar o buffer. */
  pausarLeitura(): void {
    this.#socket.pause()
  }

  retomarLeitura(): void {
    this.#socket.resume()
  }

  /** Espera a próxima mensagem (texto/binário), o fim, ou o prazo. */
  async proxima(prazoMs = 5_000): Promise<ItemDoCliente> {
    const limite = Date.now() + prazoMs
    for (;;) {
      const item = this.#itens.shift()
      if (item !== undefined) return { tipo: 'mensagem', ...item }
      if (this.#fim !== undefined) return { tipo: 'fim', fim: this.#fim }
      if (Date.now() >= limite) return { tipo: 'prazo' }
      let timer: NodeJS.Timeout | undefined
      await new Promise<void>((resolve) => {
        this.#acordar = resolve
        timer = setTimeout(resolve, Math.max(0, limite - Date.now()))
      })
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Açúcar: próxima mensagem de TEXTO já decodificada de JSON. */
  async proximoJson(prazoMs = 5_000): Promise<unknown> {
    const item = await this.proxima(prazoMs)
    if (item.tipo !== 'mensagem') {
      throw new Error(`esperava mensagem, veio ${item.tipo}: ${JSON.stringify(item)}`)
    }
    return JSON.parse(item.payload.toString('utf8'))
  }

  /** Espera o fim da conexão (close frame ou queda). */
  async fim(prazoMs = 5_000): Promise<FimDoCliente> {
    const limite = Date.now() + prazoMs
    while (this.#fim === undefined) {
      if (Date.now() >= limite) throw new Error('prazo esperando o fim da conexão')
      let timer: NodeJS.Timeout | undefined
      await new Promise<void>((resolve) => {
        this.#acordar = resolve
        timer = setTimeout(resolve, Math.max(0, limite - Date.now()))
      })
      if (timer !== undefined) clearTimeout(timer)
    }
    return this.#fim
  }

  /* -------------------------------- interno ------------------------------- */

  #consumir(): void {
    for (;;) {
      const frame = this.#lerFrame()
      if (frame === undefined) return
      const { opcode, payload } = frame
      if (opcode === 0x9) {
        // ping do servidor → pong na hora, mascarado.
        this.#socket.write(quadroMascarado(0xa, payload))
        continue
      }
      if (opcode === 0xa) continue // pong: nada a fazer
      if (opcode === 0x8) {
        const fim: FimDoCliente = {}
        if (payload.length >= 2) {
          fim.codigo = payload.readUInt16BE(0)
          fim.motivo = payload.subarray(2).toString('utf8')
        }
        this.#fim ??= fim
        this.#despertar()
        continue
      }
      this.#itens.push({ opcode, payload })
      this.#despertar()
    }
  }

  /** Parser de frames do SERVIDOR (sem máscara; o servidor nunca fragmenta). */
  #lerFrame(): { opcode: number; payload: Buffer } | undefined {
    const dados = this.#pendente
    if (dados.length < 2) return undefined
    const opcode = dados[0]! & 0x0f
    let tamanho = dados[1]! & 0x7f
    let cursor = 2
    if (tamanho === 126) {
      if (dados.length < 4) return undefined
      tamanho = dados.readUInt16BE(2)
      cursor = 4
    } else if (tamanho === 127) {
      if (dados.length < 10) return undefined
      tamanho = dados.readUInt32BE(2) * 0x100000000 + dados.readUInt32BE(6)
      cursor = 10
    }
    if (dados.length < cursor + tamanho) return undefined
    const payload = Buffer.from(dados.subarray(cursor, cursor + tamanho))
    this.#pendente = dados.subarray(cursor + tamanho)
    return { opcode, payload }
  }

  #despertar(): void {
    const acordar = this.#acordar
    this.#acordar = undefined
    acordar?.()
  }
}

/** Monta um frame de cliente: FIN=1 e MASCARADO (a obrigação da RFC). */
export function quadroMascarado(opcode: number, payload: Buffer): Buffer {
  const mascara = randomBytes(4)
  const corpo = Buffer.from(payload)
  for (let i = 0; i < corpo.length; i++) {
    corpo[i]! ^= mascara[i % 4]!
  }
  let header: Buffer
  if (corpo.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | corpo.length])
  } else if (corpo.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(corpo.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeUInt32BE(Math.floor(corpo.length / 0x100000000), 2)
    header.writeUInt32BE(corpo.length % 0x100000000, 6)
  }
  return Buffer.concat([header, mascara, corpo])
}

/** Lê a resposta HTTP até a linha em branco; devolve o texto e a sobra binária. */
async function lerCabecalhos(socket: Socket): Promise<{ texto: string; sobra: Buffer }> {
  let acumulado = Buffer.alloc(0)
  return new Promise((resolve, reject) => {
    const aoReceber = (pedaco: Buffer) => {
      acumulado = Buffer.concat([acumulado, pedaco])
      const fim = acumulado.indexOf('\r\n\r\n')
      if (fim === -1) return
      socket.off('data', aoReceber)
      socket.off('error', aoFalhar)
      socket.off('close', aoFechar)
      resolve({
        texto: acumulado.subarray(0, fim).toString('latin1'),
        sobra: acumulado.subarray(fim + 4),
      })
    }
    const aoFalhar = (erro: Error) => reject(erro)
    const aoFechar = () => {
      // Resposta curta que coube toda antes do FIN (um 4xx com Connection:
      // close): entrega o que veio para o chamador ler o status.
      const fim = acumulado.indexOf('\r\n\r\n')
      if (fim !== -1) {
        resolve({
          texto: acumulado.subarray(0, fim).toString('latin1'),
          sobra: acumulado.subarray(fim + 4),
        })
      } else {
        reject(new Error('conexão fechada antes dos cabeçalhos'))
      }
    }
    socket.on('data', aoReceber)
    socket.once('error', aoFalhar)
    socket.once('close', aoFechar)
  })
}
