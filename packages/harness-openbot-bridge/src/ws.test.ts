/**
 * Aceite do WebSocket clean-room (a forma do ws.go do oráculo):
 * handshake com Sec-WebSocket-Accept, máscara obrigatória do cliente,
 * fragmentação na leitura, tetos, close com código+motivo e a rajada
 * byte-idêntica. Tudo contra socket REAL — o parser é código de fronteira e
 * mock de fronteira prova conformidade consigo mesmo.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_MESSAGE,
  OP_TEXT,
  UpgradeRecusadoError,
  WsConn,
  acceptKey,
  checkOrigin,
  sanitizeCloseCode,
  upgradeWebSocket,
} from './ws.js'
import { ClienteWsDeTeste, HandshakeRecusadoError, quadroMascarado } from './teste-cliente-ws.js'

/* ------------------------------ infra de teste ---------------------------- */

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

interface ServidorDeTeste {
  porta: number
  /** As conexões aceitas, na ordem. */
  conexoes: WsConn[]
  fins: Array<{ codigo?: number; motivo?: string; erro?: Error }>
}

/** Sobe um servidor que aceita upgrades e ECOA mensagens de texto. */
function servidorDeEco(allowedOrigins: readonly string[] = []): ServidorDeTeste {
  const estado: ServidorDeTeste = { porta: 0, conexoes: [], fins: [] }
  const http: Server = createServer()
  http.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    try {
      const conn = upgradeWebSocket(req, socket, head, allowedOrigins, { lingerMs: 200 })
      estado.conexoes.push(conn)
      conn.onmessage = (opcode, payload) => {
        if (opcode === OP_TEXT) void conn.writeText(payload).catch(() => {})
      }
      conn.onclose = (fim) => {
        estado.fins.push(fim)
      }
    } catch (erro) {
      const status = erro instanceof UpgradeRecusadoError ? erro.status : 400
      socket.write(`HTTP/1.1 ${status} Recusado\r\nConnection: close\r\n\r\n`)
      socket.end()
    }
  })
  http.listen(0, '127.0.0.1')
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        // Fecha as conexões WS primeiro: sockets de upgrade saem do rastreio
        // do http.Server, então closeAllConnections não os alcança.
        for (const conn of estado.conexoes) {
          conn.close(1001, 'fim do teste')
        }
        http.closeAllConnections()
        http.close(() => resolve())
      }),
  )
  // listen(0) atribui a porta de forma síncrona ao chegar o 'listening'; os
  // testes aguardam via espera abaixo.
  estado.porta = 0
  http.on('listening', () => {
    estado.porta = (http.address() as AddressInfo).port
  })
  return estado
}

async function esperarPorta(servidor: ServidorDeTeste): Promise<number> {
  while (servidor.porta === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return servidor.porta
}

/* --------------------------------- testes --------------------------------- */

describe('handshake (Sec-WebSocket-Accept)', () => {
  it('acceptKey devolve o vetor de exemplo da RFC 6455', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('handshake completo responde 101 com o accept correto (o cliente valida)', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    // conectar() já falha se o accept não bater com a chave enviada.
    const cliente = await ClienteWsDeTeste.conectar(porta)
    cliente.enviarTexto('oi')
    const eco = await cliente.proxima()
    expect(eco).toMatchObject({ tipo: 'mensagem' })
    cliente.destruir()
  })

  it('chave que não é 16 bytes em base64 é recusada com 400', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    // Cliente cru com chave inválida: o helper não permite, então vai na mão.
    const { connect } = await import('node:net')
    const socket = connect(porta, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    socket.write(
      'GET /v1/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: lixo\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    const resposta = await new Promise<string>((resolve) => {
      socket.once('data', (dados: Buffer) => resolve(dados.toString('latin1')))
    })
    expect(resposta).toContain('HTTP/1.1 400')
    socket.destroy()
  })
})

describe('checkOrigin (o ponto de segurança: navegador não aplica CORS a WS)', () => {
  it('sem Origin (cliente nativo) é aceito; com Origin fora da lista é 403', async () => {
    const servidor = servidorDeEco(['http://localhost:1421'])
    const porta = await esperarPorta(servidor)

    const nativo = await ClienteWsDeTeste.conectar(porta)
    nativo.destruir()

    await expect(
      ClienteWsDeTeste.conectar(porta, { origem: 'https://mal.example' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('origem listada é aceita com caixa diferente; lista vazia recusa QUALQUER Origin', () => {
    expect(() => checkOrigin('HTTP://LOCALHOST:1421', ['http://localhost:1421'])).not.toThrow()
    expect(() => checkOrigin('http://localhost:1421', [])).toThrow(UpgradeRecusadoError)
    // Sem Origin passa mesmo com lista vazia: navegador manda SEMPRE, nativo nunca.
    expect(() => checkOrigin(undefined, [])).not.toThrow()
  })
})

describe('frames', () => {
  it('mensagem mascarada do cliente é desmascarada e ecoada intacta (UTF-8 com acento)', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    const cliente = await ClienteWsDeTeste.conectar(porta)
    const texto = 'ação, ünïcödé, 日本語 — e um payload médio: ' + 'x'.repeat(200)
    cliente.enviarTexto(texto)
    const eco = await cliente.proxima()
    expect(eco.tipo).toBe('mensagem')
    if (eco.tipo === 'mensagem') expect(eco.payload.toString('utf8')).toBe(texto)
    cliente.destruir()
  })

  it('frame de cliente SEM máscara derruba com 1002 — aceitar seria aceitar tráfego forjável', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    const cliente = await ClienteWsDeTeste.conectar(porta)
    // Frame de texto sem o bit de máscara: [FIN|texto, tamanho sem 0x80, corpo]
    cliente.enviarBruto(Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from('oi')]))
    const fim = await cliente.fim()
    expect(fim.codigo).toBe(1002)
  })

  it('mensagem fragmentada é remontada; ping no MEIO dos fragmentos é respondido', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    const cliente = await ClienteWsDeTeste.conectar(porta)

    // texto em 3 fragmentos: FIN=0 opcode=1, FIN=0 opcode=0, FIN=1 opcode=0.
    const partes = [Buffer.from('um-'), Buffer.from('dois-'), Buffer.from('três')]
    const semFin = (quadro: Buffer) => {
      const copia = Buffer.from(quadro)
      copia[0] = copia[0]! & 0x7f
      return copia
    }
    cliente.enviarBruto(semFin(quadroMascarado(0x1, partes[0]!)))
    cliente.enviarBruto(semFin(quadroMascarado(0x0, partes[1]!)))
    cliente.enviarBruto(quadroMascarado(0x9, Buffer.from('vivo?'))) // ping no meio
    cliente.enviarBruto(quadroMascarado(0x0, partes[2]!))

    const eco = await cliente.proxima()
    expect(eco.tipo).toBe('mensagem')
    if (eco.tipo === 'mensagem') expect(eco.payload.toString('utf8')).toBe('um-dois-três')
    cliente.destruir()
  })

  it('cabeçalho anunciando mais que o teto derruba com 1009 SEM esperar o corpo', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    const cliente = await ClienteWsDeTeste.conectar(porta)
    // Header de 10 bytes anunciando MAX_MESSAGE+1 — o corpo nunca é enviado.
    const header = Buffer.alloc(14)
    header[0] = 0x81
    header[1] = 0x80 | 127
    const tamanho = MAX_MESSAGE + 1
    header.writeUInt32BE(Math.floor(tamanho / 0x100000000), 2)
    header.writeUInt32BE(tamanho % 0x100000000, 6)
    // máscara (4 bytes) — obrigatória mesmo num frame que será recusado
    header.writeUInt32BE(0xdeadbeef, 10)
    cliente.enviarBruto(header)
    const fim = await cliente.fim()
    expect(fim.codigo).toBe(1009)
  })

  it('close do cliente chega com código e motivo; o eco volta só com o código', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    const cliente = await ClienteWsDeTeste.conectar(porta)
    cliente.fechar(1000, 'até logo')
    const fim = await cliente.fim()
    expect(fim.codigo).toBe(1000)
    // O motivo do CLIENTE não é refletido de volta (bytes não confiáveis).
    expect(fim.motivo).toBe('')
    // E o servidor viu o motivo original no onclose dele.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(servidor.fins[0]).toMatchObject({ codigo: 1000, motivo: 'até logo' })
  })
})

describe('writeTextBurst (a rajada do replay)', () => {
  it('os bytes no fio são IDÊNTICOS aos de escritas individuais — muda só a fronteira', async () => {
    const servidor = servidorDeEco()
    const porta = await esperarPorta(servidor)
    const mensagens = ['a', 'bb'.repeat(100), JSON.stringify({ seq: 3, kind: 'done' })].map(
      (texto) => Buffer.from(texto, 'utf8'),
    )

    async function capturar(escrever: (conn: WsConn) => Promise<void>): Promise<Buffer> {
      const { connect } = await import('node:net')
      const chave = Buffer.alloc(16, 7).toString('base64')
      // O índice da conexão que ESTA chamada vai abrir — pegar "a última" é
      // corrida quando o teste abre duas.
      const indice = servidor.conexoes.length
      const socket = connect(porta, '127.0.0.1')
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      socket.write(
        'GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${chave}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
      const pedacos: Buffer[] = []
      let cabecalhoVisto = false
      socket.on('data', (dados: Buffer) => {
        if (!cabecalhoVisto) {
          const fim = dados.indexOf('\r\n\r\n')
          cabecalhoVisto = true
          pedacos.push(Buffer.from(dados.subarray(fim + 4)))
          return
        }
        pedacos.push(Buffer.from(dados))
      })
      // Espera o servidor aceitar a conexão e escreve por ELA.
      while (servidor.conexoes.length <= indice) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await escrever(servidor.conexoes[indice]!)
      await new Promise((resolve) => setTimeout(resolve, 100))
      socket.destroy()
      return Buffer.concat(pedacos)
    }

    const individuais = await capturar(async (conn) => {
      for (const mensagem of mensagens) await conn.writeText(mensagem)
    })
    const rajada = await capturar(async (conn) => {
      await conn.writeTextBurst(mensagens)
    })
    expect(rajada.equals(individuais)).toBe(true)
    expect(rajada.length).toBeGreaterThan(0)
  })
})

describe('sanitizeCloseCode', () => {
  it('troca os códigos proibidos de trafegar e os fora de faixa', () => {
    expect(sanitizeCloseCode(1005)).toBe(1000)
    expect(sanitizeCloseCode(1006)).toBe(1000)
    expect(sanitizeCloseCode(1015)).toBe(1000)
    expect(sanitizeCloseCode(999)).toBe(1002)
    expect(sanitizeCloseCode(5000)).toBe(1002)
    expect(sanitizeCloseCode(1013)).toBe(1013)
  })
})
