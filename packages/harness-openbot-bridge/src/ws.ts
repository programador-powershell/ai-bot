/**
 * Servidor WebSocket (RFC 6455), na mão e só com a stdlib do Node.
 *
 * Escrever isto à mão parece exagero até lembrar QUEM é este processo: o
 * servidor carrega a conversa inteira do usuário e o direito de executar
 * ferramenta na máquina dele. `ws`/`@hono/node-ws` são boas bibliotecas, mas
 * seriam dependência de terceiro exatamente aqui — e, pela política da casa,
 * teriam de passar por TI/SI antes de entrar. O subconjunto que o AI-BOT usa
 * cabe em um arquivo (a mesma decisão do ws.go do oráculo Go, portada como
 * FORMA, nunca linha): servidor (nunca cliente), sem extensões, sem
 * permessage-deflate, texto e binário, ping/pong e close.
 *
 * O que deliberadamente NÃO existe aqui, e por quê:
 *   - compressão: economizaria banda em loopback, onde banda não é problema,
 *     e traria uma máquina de estado inteira (e CVEs) junto;
 *   - fragmentação na escrita: o servidor sempre escreve a mensagem completa;
 *     na LEITURA a fragmentação é aceita, porque o cliente pode fragmentar;
 *   - cliente WebSocket: quem fala com provedor externo usa fetch/undici.
 */

import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/** Opcodes que o servidor usa. Os reservados não aparecem de propósito: receber um deles é erro de protocolo, não um caso a tratar. */
export const OP_TEXT = 0x1
export const OP_BINARY = 0x2
export const OP_CLOSE = 0x8
export const OP_PING = 0x9
export const OP_PONG = 0xa

/** opcode 0x0: "continua a mensagem que já começou". */
const OP_CONTINUATION = 0x0

/**
 * Teto de uma mensagem remontada. Frame ou mensagem maior derruba a conexão
 * com 1009. Existe porque o tamanho vem no cabeçalho e é escolhido pelo
 * cliente: sem teto, um único frame anunciando 2^40 bytes faria o servidor
 * alocar até morrer — negação de serviço de graça.
 */
export const MAX_MESSAGE = 8 << 20 // 8 MiB

/** Limite da RFC para o payload de frames de controle. */
const MAX_CONTROL_PAYLOAD = 125

/** Códigos de fechamento usados pelo transporte (RFC 6455 §7.4.1). */
export const CLOSE_NORMAL = 1000
export const CLOSE_GOING_AWAY = 1001
export const CLOSE_PROTOCOL_ERROR = 1002
export const CLOSE_POLICY = 1008
export const CLOSE_TOO_BIG = 1009
export const CLOSE_INTERNAL = 1011
/** "Tente de novo mais tarde" — é o código do cliente atrasado que refaz o replay. */
export const CLOSE_TRY_AGAIN_LATER = 1013

/** A constante mágica do handshake, fixada pela RFC 6455. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Quanto tempo o socket sobrevive depois do frame de close antes do destroy.
 * O close é escrito no buffer e o FIN só sai quando o cliente drena — um
 * cliente que nunca mais lê prenderia o descritor para sempre sem este prazo.
 */
const DEFAULT_LINGER_MS = 5_000

/** Escrita em conexão já fechada. Erro próprio para o chamador distinguir "acabou" de "quebrou". */
export class ConexaoFechadaError extends Error {
  override name = 'ConexaoFechadaError'
  constructor() {
    super('conexão websocket fechada')
  }
}

/** Handshake recusado. `status` diz como responder o HTTP: 400 (malformado) ou 403 (origem). */
export class UpgradeRecusadoError extends Error {
  override name = 'UpgradeRecusadoError'
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message)
  }
}

/**
 * acceptKey devolve a prova de que o servidor entendeu o handshake.
 *
 * SHA-1 aqui não é escolha de segurança e não guarda segredo nenhum: é o
 * algoritmo fixado pela RFC 6455, e trocá-lo quebraria todo cliente do mundo.
 */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64')
}

/**
 * checkOrigin decide se a página que abriu o socket tem direito de falar com o
 * servidor.
 *
 * Este é o ponto de segurança mais importante do arquivo. O navegador NÃO
 * aplica CORS a WebSocket: qualquer aba aberta na estação pode dar
 * `new WebSocket("ws://127.0.0.1:.../v1/stream")` e conversar com o servidor
 * em loopback. Sem esta checagem, um site qualquer manda o AI-BOT executar
 * ferramenta na máquina do usuário — é CSRF, com o agravante de o alvo ser um
 * executor de comandos.
 *
 * Requisição SEM Origin é aceita porque cliente nativo (o app Tauri, a CLI, o
 * teste) não manda o cabeçalho, enquanto navegador manda SEMPRE. Lista vazia
 * recusa tudo que mandar Origin, e de propósito não existe curinga: liberar
 * "*" aqui seria desfazer o parágrafo acima com uma linha de configuração.
 */
export function checkOrigin(origin: string | undefined, allowedOrigins: readonly string[]): void {
  const value = (origin ?? '').trim()
  if (value === '') return
  for (const allowed of allowedOrigins) {
    if (allowed.trim().toLowerCase() === value.toLowerCase()) return
  }
  throw new UpgradeRecusadoError(`origem recusada: ${JSON.stringify(value)}`, 403)
}

/** Procura um token num cabeçalho de lista separada por vírgula, ignorando caixa e espaço. */
function headerHasToken(header: string | string[] | undefined, token: string): boolean {
  const values = header === undefined ? [] : Array.isArray(header) ? header : [header]
  for (const value of values) {
    for (const part of value.split(',')) {
      if (part.trim().toLowerCase() === token) return true
    }
  }
  return false
}

/**
 * Valida o handshake e assume o socket.
 *
 * Em caso de erro NADA foi escrito no socket: quem chama continua dono dele e
 * deve responder 400 (ou 403, no caso de origem recusada) e destruí-lo. Em
 * caso de sucesso o inverso vale — a resposta 101 já foi enviada e o chamador
 * é dono do `WsConn`, devendo fechá-lo inclusive quando o fim vier do cliente.
 *
 * `head` são os bytes que o node:http leu adiantado depois dos cabeçalhos.
 * Descartá-lo e ler só do socket perderia o primeiro frame — por isso ele
 * entra no parser antes de qualquer byte novo (o mesmo cuidado do Hijack do
 * oráculo com o bufio.ReadWriter).
 */
export function upgradeWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  allowedOrigins: readonly string[],
  options?: WsConnOptions,
): WsConn {
  if (req.method !== 'GET') {
    throw new UpgradeRecusadoError(`upgrade websocket exige GET, veio ${req.method}`, 400)
  }
  // Connection é lista de tokens ("keep-alive, Upgrade") e a caixa é livre;
  // comparar a string inteira reprova clientes legítimos.
  if (!headerHasToken(req.headers.connection, 'upgrade')) {
    throw new UpgradeRecusadoError('cabeçalho Connection não pede upgrade', 400)
  }
  if ((req.headers.upgrade ?? '').trim().toLowerCase() !== 'websocket') {
    throw new UpgradeRecusadoError('cabeçalho Upgrade não é websocket', 400)
  }
  const version = (first(req.headers['sec-websocket-version']) ?? '').trim()
  if (version !== '13') {
    throw new UpgradeRecusadoError(`versão de websocket não suportada: ${JSON.stringify(version)}`, 400)
  }

  const key = (first(req.headers['sec-websocket-key']) ?? '').trim()
  if (key === '') {
    throw new UpgradeRecusadoError('cabeçalho Sec-WebSocket-Key ausente', 400)
  }
  // A chave tem de ser 16 bytes em base64. Conferir tamanho E grafia separa um
  // cliente WebSocket de verdade de um GET comum com cabeçalhos copiados —
  // Buffer.from ignora lixo em silêncio, então a grafia é conferida à parte.
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
    throw new UpgradeRecusadoError('cabeçalho Sec-WebSocket-Key não é 16 bytes em base64', 400)
  }

  checkOrigin(first(req.headers.origin), allowedOrigins)

  // Extensões (permessage-deflate e afins) são simplesmente ignoradas: não
  // ecoar Sec-WebSocket-Extensions na resposta é, pela RFC, recusá-las.

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  )

  return new WsConn(socket, head, options)
}

function first(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header
}

/** O que o dono da conexão recebe quando ela acaba. `codigo` é o do frame de close, quando houve um. */
export interface FimDaConexao {
  codigo?: number
  motivo?: string
  /** Presente quando o fim foi violação de protocolo ou queda do socket, não um close educado. */
  erro?: Error
}

export interface WsConnOptions {
  /** Prazo entre o close e o destroy do socket (ver DEFAULT_LINGER_MS). Configurável para teste. */
  lingerMs?: number
}

/**
 * Conn é uma conexão WebSocket já negociada.
 *
 * Contrato de concorrência (a tradução do "um leitor, N escritores" do
 * oráculo): a LEITURA é dirigida por evento e entrega mensagens completas, em
 * ordem, via `onmessage`; as ESCRITAS podem vir de qualquer lugar porque cada
 * frame é montado num Buffer único e sai em UMA chamada de write — o kernel
 * preserva a ordem das chamadas e nenhum byte de frames diferentes se
 * intercala. É o que dispensa o writeMu do Go sem reabrir o bug clássico de
 * quem escreve WebSocket na mão.
 */
export class WsConn {
  /** Mensagens completas da aplicação (texto/binário). Fragmentos nunca chegam aqui. */
  onmessage: ((opcode: number, payload: Buffer) => void) | undefined
  /** Disparado UMA vez, quando a conexão acaba (close educado, erro de protocolo ou queda). */
  onclose: ((fim: FimDaConexao) => void) | undefined

  readonly #socket: Duplex
  readonly #lingerMs: number

  /** Bytes recebidos e ainda não consumidos pelo parser. */
  #pendente: Buffer
  /** Opcode da mensagem fragmentada em montagem; 0 = nenhuma aberta (dado é sempre 1 ou 2). */
  #fragmentOp = 0
  #fragmentos: Buffer[] = []
  #fragmentoTotal = 0

  #fechada = false
  #fimEntregue = false
  #lingerTimer: NodeJS.Timeout | undefined

  /** guardado na criação porque depois do destroy o endereço do socket já não é confiável. */
  readonly remoteAddr: string

  constructor(socket: Duplex, head: Buffer, options?: WsConnOptions) {
    this.#socket = socket
    this.#pendente = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
    this.#lingerMs = options?.lingerMs ?? DEFAULT_LINGER_MS
    const addr = socket as { remoteAddress?: string; remotePort?: number }
    this.remoteAddr = addr.remoteAddress !== undefined ? `${addr.remoteAddress}:${addr.remotePort ?? 0}` : '(desconhecido)'

    socket.on('data', (chunk: Buffer) => {
      this.#pendente = this.#pendente.length === 0 ? chunk : Buffer.concat([this.#pendente, chunk])
      this.#consumir()
    })
    socket.on('error', (erro: Error) => {
      this.#terminar({ erro })
    })
    socket.on('end', () => {
      // FIN do par sem close frame: para o WebSocket a conversa ACABOU — não
      // existe meia-conexão útil aqui. Sem este listener, um socket com
      // allowHalfOpen (o caso dos sockets vindos de upgrade) ficaria
      // meio-aberto para sempre, segurando o descritor E o close() do
      // servidor HTTP no encerramento.
      this.#terminar({})
    })
    socket.on('close', () => {
      // O par sumiu entre frames: fim normal (o io.EOF do oráculo).
      this.#terminar({})
    })
    // O head chegou junto do handshake — pode já conter o primeiro frame.
    if (this.#pendente.length > 0) queueMicrotask(() => this.#consumir())
  }

  get fechada(): boolean {
    return this.#fechada
  }

  /* ------------------------------- escrita ------------------------------- */

  /**
   * Escreve uma mensagem completa em um único frame. O servidor NÃO mascara (a
   * máscara é obrigação exclusiva do cliente); mascarar aqui faria todo
   * cliente conforme derrubar a conexão.
   *
   * A promise assenta quando o frame coube no buffer do socket — e ESPERA o
   * `drain` quando não coube. É essa espera que faz a contrapressão existir:
   * um cliente que parou de ler segura o escritor aqui, a fila do barramento
   * enche, e o `lagged` derruba com 1013 em vez de a memória crescer sem teto.
   */
  async writeMessage(opcode: number, payload: Buffer): Promise<void> {
    if ((opcode & 0x08) !== 0 && payload.length > MAX_CONTROL_PAYLOAD) {
      throw new Error(
        `frame de controle 0x${opcode.toString(16)} com ${payload.length} bytes, máximo ${MAX_CONTROL_PAYLOAD}`,
      )
    }
    if (this.#fechada) throw new ConexaoFechadaError()
    await this.#despachar(montarFrame(opcode, payload))
  }

  async writeText(payload: string | Buffer): Promise<void> {
    await this.writeMessage(OP_TEXT, typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload)
  }

  /**
   * Escreve VÁRIOS frames de texto em uma única ida ao socket.
   *
   * Existe para o replay: escrever envelope a envelope custa um write() por
   * frame — milhares de idas para abrir uma conversa longa. Aqui os frames são
   * concatenados e saem juntos; os bytes no fio são IDÊNTICOS, frame a frame —
   * só a fronteira das syscalls muda (a mesma decisão do WriteTextBurst do
   * oráculo, provada por teste de igualdade byte a byte).
   */
  async writeTextBurst(payloads: readonly Buffer[]): Promise<void> {
    if (this.#fechada) throw new ConexaoFechadaError()
    if (payloads.length === 0) return
    await this.#despachar(Buffer.concat(payloads.map((payload) => montarFrame(OP_TEXT, payload))))
  }

  /** Ping sem corpo: descobre conexão morta em NAT que não avisa ninguém. */
  async ping(): Promise<void> {
    await this.writeMessage(OP_PING, Buffer.alloc(0))
  }

  /**
   * Envia o frame de fechamento e encerra o socket. Idempotente: a segunda
   * chamada não faz nada, porque close costuma sair pelo caminho normal E pelo
   * caminho de erro ao mesmo tempo.
   */
  close(codigo: number, motivo: string): void {
    if (this.#fechada) return
    this.#fechada = true

    // Corpo do close: código em uint16 big-endian ANTES do motivo. Trocar a
    // ordem faz o cliente ler os dois primeiros bytes do texto como código.
    const texto = truncarMotivo(motivo)
    const corpo = Buffer.alloc(2 + texto.length)
    corpo.writeUInt16BE(codigo, 0)
    texto.copy(corpo, 2)

    try {
      this.#socket.write(montarFrame(OP_CLOSE, corpo))
    } catch {
      // O par já sumiu; o destroy abaixo resolve.
    }
    // end() deixa o close (e o que estiver bufferizado) sair quando o cliente
    // drenar; o timer garante que um cliente que nunca mais lê não prende o
    // descritor para sempre.
    this.#socket.end()
    this.#lingerTimer = setTimeout(() => this.#socket.destroy(), this.#lingerMs)
    // unref: um timer de faxina não pode segurar o processo vivo.
    this.#lingerTimer.unref?.()
  }

  async #despachar(bytes: Buffer): Promise<void> {
    const coube = this.#socket.write(bytes)
    if (coube) return
    // O buffer do socket encheu: espera o kernel drenar OU a conexão acabar —
    // sem a segunda perna, um cliente que caiu deixaria o escritor pendurado.
    await new Promise<void>((resolve, reject) => {
      const socket = this.#socket
      const drenar = () => {
        limpar()
        resolve()
      }
      const acabar = () => {
        limpar()
        reject(new ConexaoFechadaError())
      }
      const limpar = () => {
        socket.off('drain', drenar)
        socket.off('close', acabar)
        socket.off('error', acabar)
      }
      socket.on('drain', drenar)
      socket.on('close', acabar)
      socket.on('error', acabar)
    })
  }

  /* ------------------------------- leitura ------------------------------- */

  /** Consome frames completos do buffer pendente; para no primeiro incompleto. */
  #consumir(): void {
    for (;;) {
      if (this.#fimEntregue) return
      const frame = this.#lerFrame()
      if (frame === undefined) return
      if (frame === 'falha') return
      this.#tratarFrame(frame.fin, frame.opcode, frame.payload)
    }
  }

  /**
   * Lê um frame do buffer, devolvendo o payload já desmascarado; `undefined`
   * quando ainda faltam bytes, `'falha'` quando a conexão caiu por violação.
   */
  #lerFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined | 'falha' {
    const dados = this.#pendente
    if (dados.length < 2) return undefined

    const fin = (dados[0]! & 0x80) !== 0
    // RSV1..3 ligados só fazem sentido com extensão negociada, e não
    // negociamos nenhuma — interpretar seria adivinhar.
    if ((dados[0]! & 0x70) !== 0) {
      return this.#falhar(CLOSE_PROTOCOL_ERROR, 'bits RSV ligados sem extensão negociada')
    }
    const opcode = dados[0]! & 0x0f
    const mascarado = (dados[1]! & 0x80) !== 0
    let tamanho = dados[1]! & 0x7f
    let cursor = 2

    // Tamanho em três degraus: 0..125 direto, 126 => uint16, 127 => uint64.
    if (tamanho === 126) {
      if (dados.length < 4) return undefined
      tamanho = dados.readUInt16BE(2)
      cursor = 4
    } else if (tamanho === 127) {
      if (dados.length < 10) return undefined
      const alto = dados.readUInt32BE(2)
      const baixo = dados.readUInt32BE(6)
      // A RFC exige o bit mais significativo em 0; ligado, o valor não cabe em
      // inteiro com sinal e vira número negativo em quem converter sem olhar.
      if ((alto & 0x80000000) !== 0) {
        return this.#falhar(CLOSE_PROTOCOL_ERROR, 'bit mais significativo do tamanho de 64 bits ligado')
      }
      tamanho = alto * 0x100000000 + baixo
      cursor = 10
    }

    // Cliente é OBRIGADO a mascarar. Aceitar frame sem máscara é aceitar
    // tráfego que um proxy pode ter forjado a partir de conteúdo controlado
    // pelo atacante (é para isso que a máscara existe, não para privacidade).
    if (!mascarado) {
      return this.#falhar(CLOSE_PROTOCOL_ERROR, 'frame de cliente sem máscara')
    }

    if ((opcode & 0x08) !== 0) {
      // Controle não fragmenta e não passa de 125 bytes: precisa poder ser
      // tratado no meio de uma mensagem grande.
      if (!fin) return this.#falhar(CLOSE_PROTOCOL_ERROR, 'frame de controle fragmentado')
      if (tamanho > MAX_CONTROL_PAYLOAD) {
        return this.#falhar(CLOSE_PROTOCOL_ERROR, 'frame de controle acima de 125 bytes')
      }
    }

    // O teto é conferido ANTES de esperar o payload: um cabeçalho anunciando
    // gigabytes cai aqui, sem alocar nada.
    if (tamanho > MAX_MESSAGE) {
      return this.#falhar(CLOSE_TOO_BIG, 'frame acima do teto de mensagem')
    }

    if (dados.length < cursor + 4 + tamanho) return undefined
    const mascara = dados.subarray(cursor, cursor + 4)
    const payload = Buffer.from(dados.subarray(cursor + 4, cursor + 4 + tamanho))
    // A máscara é cíclica de 4 bytes e recomeça em 0 a cada frame (frame
    // fragmentado tem cada um a sua). O laço byte a byte basta aqui: o gargalo
    // do produto é o modelo, não o XOR — a otimização por palavra do oráculo
    // só pagava em Go porque lá o transporte é medido por benchmark próprio.
    for (let i = 0; i < payload.length; i++) {
      payload[i]! ^= mascara[i % 4]!
    }
    this.#pendente = dados.subarray(cursor + 4 + tamanho)
    return { fin, opcode, payload }
  }

  /** Remonta fragmentos e responde controle — quem ouve `onmessage` nunca vê frame pela metade. */
  #tratarFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_PING:
        // Responder na hora e voltar a ler: ping é sinal de vida, não é
        // assunto da aplicação.
        void this.writeMessage(OP_PONG, payload).catch(() => {})
        return

      case OP_PONG:
        // Resposta ao nosso ping. Quem mede latência é a camada de cima.
        return

      case OP_CLOSE: {
        let codigo = CLOSE_NORMAL
        let motivo = ''
        if (payload.length >= 2) {
          codigo = sanitizeCloseCode(payload.readUInt16BE(0))
          motivo = payload.subarray(2).toString('utf8')
        }
        // Eco sem motivo: devolver o texto do cliente seria refletir bytes
        // não confiáveis, e a RFC só exige o código.
        this.close(codigo, '')
        this.#terminar({ codigo, motivo })
        return
      }

      case OP_TEXT:
      case OP_BINARY:
        if (this.#fragmentOp !== 0) {
          this.#falhar(CLOSE_PROTOCOL_ERROR, 'mensagem nova no meio de outra fragmentada')
          return
        }
        if (fin) {
          this.onmessage?.(opcode, payload)
          return
        }
        this.#fragmentOp = opcode
        this.#fragmentos = [payload]
        this.#fragmentoTotal = payload.length
        return

      case OP_CONTINUATION: {
        if (this.#fragmentOp === 0) {
          this.#falhar(CLOSE_PROTOCOL_ERROR, 'frame de continuação sem mensagem aberta')
          return
        }
        // O teto vale para a mensagem REMONTADA: sem isto, mil frames de
        // 8 MiB passariam um a um e estourariam a memória juntos.
        if (this.#fragmentoTotal + payload.length > MAX_MESSAGE) {
          this.#falhar(CLOSE_TOO_BIG, 'mensagem remontada acima do teto')
          return
        }
        this.#fragmentos.push(payload)
        this.#fragmentoTotal += payload.length
        if (fin) {
          const inteiro = Buffer.concat(this.#fragmentos)
          const tipo = this.#fragmentOp
          this.#fragmentOp = 0
          this.#fragmentos = []
          this.#fragmentoTotal = 0
          this.onmessage?.(tipo, inteiro)
        }
        return
      }

      default:
        this.#falhar(CLOSE_PROTOCOL_ERROR, `opcode reservado 0x${opcode.toString(16).toUpperCase()}`)
    }
  }

  /** Fecha com o código dado e entrega o fim como erro de protocolo. */
  #falhar(codigo: number, motivo: string): 'falha' {
    this.close(codigo, motivo)
    this.#terminar({ codigo, erro: new Error(`protocolo websocket violado: ${motivo}`) })
    return 'falha'
  }

  /** Entrega o fim UMA vez — close educado, violação e queda convergem aqui. */
  #terminar(fim: FimDaConexao): void {
    if (this.#fimEntregue) return
    this.#fimEntregue = true
    this.#fechada = true
    if (this.#lingerTimer !== undefined) clearTimeout(this.#lingerTimer)
    // O socket cai de qualquer jeito: deixar o descritor aberto vazaria
    // conexão a cada erro. destroy depois do end é inofensivo.
    queueMicrotask(() => this.#socket.destroy())
    this.onclose?.(fim)
  }
}

/** Monta um frame de SAÍDA (FIN=1, RSV zerados, sem máscara — nunca fragmentamos na escrita). */
function montarFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    // Mensagem nossa nunca passa de 2^53 (teto prático do Buffer é muito
    // antes): escrever os 8 bytes a partir do number é seguro.
    header.writeUInt32BE(Math.floor(payload.length / 0x100000000), 2)
    header.writeUInt32BE(payload.length % 0x100000000, 6)
  }
  return Buffer.concat([header, payload])
}

/**
 * Encaixa o motivo nos 123 bytes que sobram do frame de controle depois do
 * código, sem cortar caractere no meio: o corpo do close tem de ser UTF-8
 * válido, e meio caractere derruba o cliente por outro motivo.
 */
function truncarMotivo(motivo: string): Buffer {
  const max = MAX_CONTROL_PAYLOAD - 2
  let corte = Buffer.from(motivo, 'utf8')
  if (corte.length > max) corte = corte.subarray(0, max)
  while (corte.length > 0 && !isUtf8(corte)) {
    corte = corte.subarray(0, corte.length - 1)
  }
  return corte
}

/**
 * Troca por 1000 os códigos que a RFC proíbe de trafegar (1005, 1006 e 1015 só
 * existem dentro da API) e por 1002 os que não fazem sentido no fio. Ecoar um
 * deles seria erro de protocolo nosso ao responder o do outro.
 */
export function sanitizeCloseCode(codigo: number): number {
  if (codigo === 1005 || codigo === 1006 || codigo === 1015) return CLOSE_NORMAL
  if (codigo < 1000 || codigo >= 5000) return CLOSE_PROTOCOL_ERROR
  return codigo
}
