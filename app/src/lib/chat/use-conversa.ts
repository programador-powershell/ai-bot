/**
 * [Onda 2] A conversa de uma thread, ao vivo do event log — o hook que liga o
 * transporte (transporte.ts) à projeção (protocolo.ts) e entrega à superfície
 * exatamente o que o replay diz.
 *
 * A ordem da subida importa e é a do contrato do chassis:
 *  1. GET /api/threads/:id/messages — GARANTE a sessão no log (get-or-create);
 *     sem isto o hello com sessionHint ganharia uma sessão de id sortido e a
 *     thread apontaria para o vazio. O corpo é descartado de propósito: a
 *     verdade que a tela desenha é o REPLAY do socket — uma fonte só.
 *  2. GET /api/stream/token — o segredo do hello, atrás do session guard.
 *  3. WS /v1/stream — hello com sessionHint=threadId; ready+replay montam a
 *     tela; delta/done chegam ao vivo; queda reconecta com resumeFrom.
 */

import { useEffect, useRef, useState } from "react";

import {
  aplicarEnvelope,
  CONVERSA_VAZIA,
  type EstadoDaConversa,
  type Envelope,
} from "./protocolo";
import {
  criarTransporteDaConversa,
  type StatusDaConversa,
  type TransporteDaConversa,
} from "./transporte";

/** O endereço do stream derivado da origem da página — uma porta só (o Bun.serve multiplexa). */
function urlDoStream(): string {
  const esquema = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${esquema}//${window.location.host}/v1/stream`;
}

/**
 * O token, buscado UMA vez por página e guardado em closure de módulo — cada
 * cópia a mais (estado, prop, persist) seria mais um lugar de onde vazar.
 */
let tokenPrometido: Promise<string | null> | null = null;
function buscarToken(): Promise<string | null> {
  tokenPrometido ??= (async () => {
    try {
      const resposta = await fetch("/api/stream/token", { credentials: "include" });
      if (!resposta.ok) return null;
      const corpo = (await resposta.json()) as { token?: unknown };
      return typeof corpo.token === "string" && corpo.token !== "" ? corpo.token : null;
    } catch {
      return null;
    }
  })();
  return tokenPrometido;
}

/** Só para teste: derruba o cache do token entre casos. */
export function esquecerTokenParaTeste(): void {
  tokenPrometido = null;
}

export type ConversaDoLog = {
  estado: EstadoDaConversa;
  status: StatusDaConversa;
  /** O servidor não pôde ser alcançado nem autenticado — a tela diz, não finge. */
  indisponivel: boolean;
  /** Envia o prompt pelo protocolo. false = offline (o composer desenha isso). */
  enviar(texto: string): boolean;
  /**
   * [Onda 3] Decide um cartão de aprovação pendente. O verbo viaja pelo MESMO
   * stream (o funil do servidor grava approval.decision durável e executa —
   * ou recusa). false = offline; o cartão fica na tela e a pessoa tenta de
   * novo quando reconectar — silêncio nunca vira consentimento.
   */
  decidir(callId: string, allow: boolean, scope?: "once" | "digest" | "session"): boolean;
};

export function useConversaDoLog(threadId: string | undefined): ConversaDoLog {
  const [estado, setEstado] = useState<EstadoDaConversa>(CONVERSA_VAZIA);
  const [status, setStatus] = useState<StatusDaConversa>("connecting");
  const [indisponivel, setIndisponivel] = useState(false);
  const transporteRef = useRef<TransporteDaConversa | null>(null);

  useEffect(() => {
    if (threadId === undefined) return;
    let atual = true;
    let transporte: TransporteDaConversa | null = null;
    setEstado(CONVERSA_VAZIA);
    setIndisponivel(false);

    void (async () => {
      // 1. Garante a sessão da thread no log (a resposta não interessa aqui).
      try {
        await fetch(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
          credentials: "include",
        });
      } catch {
        // O socket ainda pode subir; se não subir, o status dirá offline.
      }

      // 2. O segredo do hello.
      const token = await buscarToken();
      if (!atual) return;
      if (token === null) {
        setIndisponivel(true);
        setStatus("offline");
        return;
      }

      // 3. O canal ao vivo.
      transporte = criarTransporteDaConversa({
        url: urlDoStream(),
        token,
        session: threadId,
        onStatus: (proximo) => {
          if (atual) setStatus(proximo);
        },
        onEnvelope: (envelope: Envelope) => {
          if (!atual) return;
          if (envelope.kind === "ready") {
            // O replay vem logo atrás e reconstrói tudo: a tela zera para não
            // duplicar linha com o que o replay vai reentregar.
            setEstado(CONVERSA_VAZIA);
            return;
          }
          setEstado((anterior) => aplicarEnvelope(anterior, envelope));
        },
      });
      transporteRef.current = transporte;
      transporte.start();
    })();

    return () => {
      atual = false;
      transporte?.stop();
      if (transporteRef.current === transporte) transporteRef.current = null;
    };
  }, [threadId]);

  return {
    estado,
    status,
    indisponivel,
    enviar(texto: string): boolean {
      const limpo = texto.trim();
      if (limpo === "") return false;
      // Sem otimismo e sem turno aberto no clique, de propósito: a linha da
      // pessoa aparece quando o LOG a devolve (a conversa é o replay), e o
      // "pensando" é dirigido pelos deltas do log — hoje o funil da resposta
      // ainda é da onda 3, e um spinner sem ninguém do outro lado seria
      // degraded-mode fingido.
      return transporteRef.current?.send("prompt", { text: limpo }) ?? false;
    },
    decidir(callId: string, allow: boolean, scope?: "once" | "digest" | "session"): boolean {
      if (callId.trim() === "") return false;
      return (
        transporteRef.current?.send("approval.decision", {
          callId,
          allow,
          // "once" é o padrão do lado do servidor também: resposta pontual não
          // vira regra sem a pessoa pedir.
          scope: scope ?? "once",
        }) ?? false
      );
    },
  };
}
