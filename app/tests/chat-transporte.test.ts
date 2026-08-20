/**
 * [Onda 2] O transporte do app fala o protocolo do gateway: token no PRIMEIRO
 * frame (nunca na URL), resumeFrom que continua a resposta (aplica primeiro,
 * avança o marco depois) e reconexão depois do 1013 pedindo replay de onde
 * parou — o outro lado deste contrato é provado pelo chassis em
 * server/tests/stream-contrapressao.test.ts.
 *
 * O socket é um DUBLÊ roteirizado: o que se prova aqui é o comportamento do
 * cliente, frame a frame; o fio de verdade é provado do lado do servidor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Envelope } from "@/lib/chat/protocolo";
import {
  criarTransporteDaConversa,
  NOME_DO_CLIENTE,
  type SocketDaConversa,
  type StatusDaConversa,
} from "@/lib/chat/transporte";

class SocketDuble implements SocketDaConversa {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 0;
  enviados: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {}

  send(texto: string): void {
    this.enviados.push(JSON.parse(texto) as Record<string, unknown>);
  }
  close(): void {
    this.fechar();
  }

  /* --- o roteiro do teste --- */
  abrir(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  entregar(envelope: Partial<Envelope>): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
  fechar(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

function ready(session: string, seq: number): Partial<Envelope> {
  return {
    v: 1,
    id: "",
    ts: new Date().toISOString(),
    seq: 0,
    session,
    kind: "ready",
    from: { kind: "system" },
    payload: { session, seq, specialists: [], models: [] },
  };
}

function mensagem(session: string, seq: number, texto: string): Partial<Envelope> {
  return {
    v: 1,
    id: `e-${seq}`,
    ts: new Date().toISOString(),
    seq,
    session,
    kind: "message",
    from: { kind: "specialist", specialist: "chat" },
    payload: { role: "assistant", text: texto },
  };
}

describe("o cliente do nosso protocolo", () => {
  const sockets: SocketDuble[] = [];
  const recebidos: Envelope[] = [];
  const statuses: StatusDaConversa[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    recebidos.length = 0;
    statuses.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function montar(session?: string) {
    const transporte = criarTransporteDaConversa({
      url: "ws://local/v1/stream",
      token: "segredo-de-teste",
      ...(session !== undefined ? { session } : {}),
      onEnvelope: (envelope) => recebidos.push(envelope),
      onStatus: (status) => statuses.push(status),
      criarSocket: (url) => {
        const socket = new SocketDuble(url);
        sockets.push(socket);
        return socket;
      },
    });
    return transporte;
  }

  it("o token viaja no PRIMEIRO frame (hello), nunca na URL", () => {
    const transporte = montar("thread-1");
    transporte.start();
    const socket = sockets[0];
    expect(socket).toBeDefined();
    expect(socket?.url).not.toContain("segredo");

    socket?.abrir();
    expect(socket?.enviados).toHaveLength(1);
    const hello = socket?.enviados[0] as { kind: string; payload: Record<string, unknown> };
    expect(hello.kind).toBe("hello");
    expect(hello.payload.token).toBe("segredo-de-teste");
    expect(hello.payload.client).toBe(NOME_DO_CLIENTE);
    expect(hello.payload.sessionHint).toBe("thread-1");
    expect(hello.payload.resumeFrom).toBe(0);
    transporte.stop();
  });

  it("1013 (atrasado) reconecta pedindo resumeFrom do último seq APLICADO", () => {
    const transporte = montar("thread-1");
    transporte.start();
    const primeiro = sockets[0];
    primeiro?.abrir();
    primeiro?.entregar(ready("thread-1", 0));
    primeiro?.entregar(mensagem("thread-1", 1, "um"));
    primeiro?.entregar(mensagem("thread-1", 2, "dois"));
    expect(recebidos.map((envelope) => envelope.seq)).toEqual([0, 1, 2]);

    // O servidor derruba por atraso (a fila do barramento estourou).
    primeiro?.fechar();
    expect(statuses.at(-1)).toBe("offline");

    // O relógio de reconexão dispara e o hello novo pede SÓ o que falta.
    vi.advanceTimersByTime(15_000);
    const segundo = sockets[1];
    expect(segundo).toBeDefined();
    segundo?.abrir();
    const hello = segundo?.enviados[0] as { payload: Record<string, unknown> };
    expect(hello.payload.resumeFrom).toBe(2);
    expect(hello.payload.token).toBe("segredo-de-teste");
    transporte.stop();
  });

  it("envelope que a redução recusa NÃO avança o marco — a reconexão o pede de volta", () => {
    const explosivo = criarTransporteDaConversa({
      url: "ws://local/v1/stream",
      token: "segredo-de-teste",
      session: "thread-1",
      onEnvelope: (envelope) => {
        if (envelope.seq === 2) throw new Error("redução recusou");
        recebidos.push(envelope);
      },
      onStatus: () => {},
      criarSocket: (url) => {
        const socket = new SocketDuble(url);
        sockets.push(socket);
        return socket;
      },
    });
    explosivo.start();
    const primeiro = sockets[0];
    primeiro?.abrir();
    const silencio = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      primeiro?.entregar(ready("thread-1", 0));
      primeiro?.entregar(mensagem("thread-1", 1, "um"));
      primeiro?.entregar(mensagem("thread-1", 2, "explode"));
      primeiro?.fechar();
      vi.advanceTimersByTime(15_000);
      const segundo = sockets[1];
      segundo?.abrir();
      const hello = segundo?.enviados[0] as { payload: Record<string, unknown> };
      // O marco parou no 1: o seq 2 volta no replay em vez de sumir para sempre.
      expect(hello.payload.resumeFrom).toBe(1);
    } finally {
      silencio.mockRestore();
    }
    explosivo.stop();
  });

  it("prompt sai com a sessão do ready e seq 0 (quem numera é o servidor)", () => {
    const transporte = montar();
    transporte.start();
    const socket = sockets[0];
    socket?.abrir();
    socket?.entregar(ready("s-nova", 0));

    expect(transporte.send("prompt", { text: "olá" })).toBe(true);
    const prompt = socket?.enviados.at(-1) as Record<string, unknown>;
    expect(prompt.kind).toBe("prompt");
    expect(prompt.session).toBe("s-nova");
    expect(prompt.seq).toBe(0);
    transporte.stop();
  });

  it("offline não engole o envio: send devolve false com o socket fechado", () => {
    const transporte = montar("thread-1");
    transporte.start();
    const socket = sockets[0];
    socket?.abrir();
    socket?.fechar();
    expect(transporte.send("prompt", { text: "vai sumir?" })).toBe(false);
    transporte.stop();
  });

  it("stop() mata o relógio de reconexão — nenhum socket novo nasce depois dele", () => {
    const transporte = montar("thread-1");
    transporte.start();
    sockets[0]?.abrir();
    sockets[0]?.fechar();
    transporte.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
