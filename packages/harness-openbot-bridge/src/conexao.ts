/**
 * O SEAM de conexão do protocolo de stream (Onda 2 da integração,
 * docs/integracao-openbot.md §5).
 *
 * O StreamServer carrega as invariantes do protocolo (as três ordens do E3, o
 * hello com prazo, a contrapressão) — e nada disso depende de QUEM enquadra os
 * bytes no fio. Esta interface é a fronteira: de um lado o protocolo, do outro
 * o transporte físico. Hoje há duas implementações, de propósito:
 *
 *  - `WsConn` (ws.ts): o RFC 6455 clean-room sobre node:http/Duplex. Com o Bun
 *    homologado ele deixa de ser o transporte de produção e vira o DUBLÊ de
 *    teste (a decisão do plano §3) — os testes do protocolo continuam rodando
 *    sobre ele no runtime Node, sem processo Bun de pé.
 *  - o adaptador do `ServerWebSocket` do Bun (server/src/stream/conexao-bun.ts):
 *    a produção do chassis, servida pelo Bun.serve.
 *
 * A interface é EXATAMENTE a fatia do WsConn que o StreamServer usa — nem um
 * método a mais. Alargar o seam antes da necessidade seria desenhar para um
 * transporte imaginário (a mesma regra do RoteadorHttp).
 */

/** O que o dono da conexão recebe quando ela acaba (a forma do fim do WsConn). */
export interface FimDaConexao {
  codigo?: number
  motivo?: string
  /** Presente quando o fim foi violação de protocolo ou queda, não um close educado. */
  erro?: Error
}

export interface ConexaoDeStream {
  /**
   * Mensagens completas da aplicação, na ordem do fio. O opcode viaja junto
   * porque o protocolo só aceita texto (OP_TEXT) — binário é ignorado pela
   * fila de entrada, nunca punido, e a decisão é do protocolo, não do
   * transporte.
   */
  onmessage: ((opcode: number, payload: Buffer) => void) | undefined
  /** Disparado UMA vez, quando a conexão acaba (close educado, erro ou queda). */
  onclose: ((fim: FimDaConexao) => void) | undefined

  /**
   * Escreve UMA mensagem de texto. A promise só assenta quando o transporte
   * DRENOU (ou enfileirou dentro do teto dele): é essa espera que faz a
   * contrapressão existir — um cliente que parou de ler segura o escritor
   * aqui, a fila do barramento enche e o `atrasado` derruba com 1013.
   */
  writeText(payload: Buffer): Promise<void>

  /**
   * Escreve VÁRIOS frames de texto de uma vez (a rajada do replay). Os bytes
   * no fio são idênticos aos de N writeText — muda só a fronteira das
   * syscalls.
   */
  writeTextBurst(payloads: readonly Buffer[]): Promise<void>

  /** Ping de vida. Falha não é fatal — o fim de verdade chega pelo onclose. */
  ping(): Promise<void>

  /** Envia o close frame (código + motivo) e encerra. Idempotente. */
  close(codigo: number, motivo: string): void
}
