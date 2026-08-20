/**
 * [Onda 2] O ServerWebSocket do Bun vestindo o seam ConexaoDeStream.
 *
 * É a metade "produção" do seam: o protocolo (StreamServer) continua um só e
 * as invariantes E3 valem aqui porque valem LÁ — este arquivo só traduz três
 * coisas do mundo uWS/Bun para o contrato:
 *
 *  1. `send()` devolve um NÚMERO, não uma promise: -1 é "enfileirado com
 *     contrapressão", 0 é "descartado" (conexão encerrando) e >0 é "coube".
 *     O writeText do seam PROMETE só assentar quando drenou — então o -1 vira
 *     uma espera pelo evento `drain`, e é essa espera que segura a bomba do
 *     stream quando o cliente para de ler (a cadeia física do 1013).
 *  2. Texto tem de ir como STRING: Buffer no send() do Bun vira frame BINÁRIO,
 *     e o protocolo é texto (o cliente do desktop ignora binário).
 *  3. Os eventos do Bun (message/close/drain) chegam por handlers do servidor,
 *     não da conexão — o transporte (transporte.ts) os encaminha para cá.
 */

import type { ServerWebSocket } from "bun";

import {
  OP_BINARY,
  OP_TEXT,
  type ConexaoDeStream,
  type FimDaConexao,
} from "@aibot2/harness-openbot-bridge";

/** O resultado 0 do send() do uWS: a mensagem NÃO foi nem enfileirada. */
const ENVIO_DESCARTADO = 0;
/** O resultado -1: enfileirada, mas o cliente não está drenando. */
const ENVIO_COM_CONTRAPRESSAO = -1;

/**
 * Passo do POLLING de drenagem. Existe porque o evento `drain` do Bun perde a
 * borda: escrever de novo DE DENTRO do callback de drain (o que a bomba faz ao
 * acordar) reestabelece a contrapressão antes de o uWS rearmar o aviso, e o
 * próximo drain nunca dispara — visto em sonda nesta estação (Bun 1.4,
 * Windows): 40 frames de 128 KiB paravam no 5º com o escritor pendurado para
 * sempre. O evento continua sendo o caminho RÁPIDO; o relógio é o backstop
 * que transforma "aviso perdido" em "10ms de atraso" em vez de deadlock.
 */
const PASSO_DO_POLL_DE_DRENAGEM_MS = 10;

/**
 * Quanto o close espera a fila do socket esvaziar antes de fechar mesmo assim.
 * O ws.close() do Bun NÃO drena o que está enfileirado (sonda: fechar com
 * 5 MB pendentes entregou 2 frames e um 1006 ao cliente) — e o contrato do
 * protocolo é o oposto: o prefixo contíguo TEM de sair antes do close frame
 * (o 1013 do atrasado é "reconecte com replay", não "perdi o que você já
 * tinha"). Mesmo papel do DEFAULT_LINGER_MS do transporte clean-room.
 */
const LINGER_DO_CLOSE_MS = 5_000;

export class ConexaoBunWs implements ConexaoDeStream {
  onmessage: ((opcode: number, payload: Buffer) => void) | undefined;
  onclose: ((fim: FimDaConexao) => void) | undefined;

  readonly #ws: ServerWebSocket<unknown>;
  #fechada = false;
  #fimEntregue = false;
  /** Escritores esperando o `drain` do Bun. */
  #esperandoDrenar: Array<() => void> = [];

  constructor(ws: ServerWebSocket<unknown>) {
    this.#ws = ws;
  }

  /* ---------------- os eventos do Bun, encaminhados pelo transporte --------- */

  aoReceber(mensagem: string | Buffer): void {
    // String = frame de texto no Bun; Buffer = binário. O protocolo só fala
    // texto — o binário sobe com o opcode certo e a fila de entrada o ignora,
    // a MESMA decisão do transporte clean-room.
    if (typeof mensagem === "string") {
      this.onmessage?.(OP_TEXT, Buffer.from(mensagem, "utf8"));
    } else {
      this.onmessage?.(OP_BINARY, Buffer.from(mensagem));
    }
  }

  aoFechar(codigo: number, motivo: string): void {
    this.#fechada = true;
    // Quem espera drain de uma conexão morta esperaria para sempre: acorda
    // todo mundo — o #enviar reconfere #fechada e falha com erro, não em
    // silêncio.
    this.#drenar();
    if (this.#fimEntregue) return;
    this.#fimEntregue = true;
    this.onclose?.({ codigo, motivo });
  }

  aoDrenar(): void {
    this.#drenar();
  }

  /* ------------------------------- o seam ---------------------------------- */

  async writeText(payload: Buffer): Promise<void> {
    await this.#enviar(payload.toString("utf8"));
  }

  async writeTextBurst(payloads: readonly Buffer[]): Promise<void> {
    // Frame a frame, com a MESMA espera de drain: a rajada do clean-room era
    // otimização de syscall do node:net; aqui o uWS já agrega — o que não pode
    // se perder é a contrapressão no meio do lote.
    for (const payload of payloads) {
      await this.#enviar(payload.toString("utf8"));
    }
  }

  async ping(): Promise<void> {
    if (this.#fechada) return;
    this.#ws.ping();
  }

  close(codigo: number, motivo: string): void {
    if (this.#fechada) return;
    this.#fechada = true;
    // Acorda escritores pendurados — eles releem #fechada e falham com erro.
    this.#drenar();
    // O close DRENA antes de fechar (ver LINGER_DO_CLOSE_MS): fire-and-forget
    // porque o seam pede close síncrono e idempotente; o fim de verdade chega
    // pelo aoFechar do Bun.
    void this.#fecharDrenado(codigo, motivo);
  }

  async #fecharDrenado(codigo: number, motivo: string): Promise<void> {
    const limite = Date.now() + LINGER_DO_CLOSE_MS;
    while (
      this.#ws.readyState === WebSocket.OPEN &&
      this.#ws.getBufferedAmount() > 0 &&
      Date.now() < limite
    ) {
      await new Promise((resolve) => setTimeout(resolve, PASSO_DO_POLL_DE_DRENAGEM_MS));
    }
    try {
      this.#ws.close(codigo, motivo);
    } catch {
      // Socket já morto por baixo: o aoFechar do Bun entrega o fim.
    }
  }

  async #enviar(texto: string): Promise<void> {
    if (this.#fechada) {
      throw new Error("conexão fechada — escrita recusada");
    }
    const resultado = this.#ws.send(texto);
    if (resultado === ENVIO_DESCARTADO) {
      throw new Error("escrita descartada — a conexão está encerrando");
    }
    if (resultado === ENVIO_COM_CONTRAPRESSAO) {
      // Enfileirado, não entregue: a promise fica presa até o socket drenar —
      // o writeDeadline do StreamServer é quem decide desistir, não nós.
      await this.#aguardarDrenagem();
      if (this.#fechada) {
        throw new Error("a conexão caiu antes de drenar a escrita");
      }
    }
  }

  /**
   * Espera a fila do socket esvaziar: o evento drain é o caminho rápido e o
   * polling é o backstop da borda perdida (ver PASSO_DO_POLL_DE_DRENAGEM_MS).
   */
  async #aguardarDrenagem(): Promise<void> {
    while (!this.#fechada && this.#ws.getBufferedAmount() > 0) {
      let relogio: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.#esperandoDrenar.push(resolve);
        relogio = setTimeout(resolve, PASSO_DO_POLL_DE_DRENAGEM_MS);
      });
      if (relogio !== undefined) clearTimeout(relogio);
    }
  }

  #drenar(): void {
    if (this.#esperandoDrenar.length === 0) return;
    const esperando = this.#esperandoDrenar;
    this.#esperandoDrenar = [];
    // MACROTASK de propósito, nunca resolve inline: acordado DENTRO do
    // dispatch do drain, o escritor faz o próximo send ainda no callback
    // nativo — e o uWS desta versão (Bun 1.4/Windows) ENCRAVA depois disso:
    // o buffered congela e nem drain nem polling voltam a andar (visto em
    // sonda; foi o defeito real da contrapressão do chassis). Um turno de
    // relógio fora do callback custa ~0ms e desarma a mina.
    setTimeout(() => {
      for (const acordar of esperando) acordar();
    }, 0);
  }
}
