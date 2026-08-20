/**
 * Live channel activity, from whoever ran an agent to everybody else in the channel.
 *
 * The person who ran it already has the reply and reports it over HTTP; this is the other direction,
 * telling the channel's other members that something was said. It is an optimisation and never a
 * source of truth: the roster query stays authoritative, and a client that misses events while
 * disconnected recovers by refetching on reconnect. Nothing may be knowable only through the socket.
 *
 * [Cirurgia R2 — sem Postgres] O openbot entregava isto via LISTEN/NOTIFY para
 * cobrir múltiplas instâncias do server. Nesta estação o banco é bun:sqlite e
 * o processo é UM, então a entrega é in-process: quem grava a atividade chama
 * `deliver` no mesmo hub que os sockets escutam. A limitação fica declarada
 * aqui em vez de escondida: um deploy multi-instância futuro precisa devolver
 * um transporte entre processos (a decisão mora no plano, não neste arquivo).
 */

export const CHANNEL_ACTIVITY_TOPIC = "channel_activity";

export type ChannelActivityEvent = {
  channelId: string;
  /** Who may receive it. Resolved by the writer, which already had to check membership. */
  memberIds: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
};

type Send = (payload: string) => void;

export type ChannelEventHub = {
  /** Attach a connection for a person. Returns the detach. */
  register(userId: string, send: Send): () => void;
  /** Fan one event out to this instance's own connections. */
  deliver(event: ChannelActivityEvent): void;
  connectionCount(userId: string): number;
};

export function createChannelEventHub(): ChannelEventHub {
  const connections = new Map<string, Set<Send>>();

  return {
    register(userId, send) {
      const existing = connections.get(userId) ?? new Set<Send>();
      existing.add(send);
      connections.set(userId, existing);

      return () => {
        const remaining = connections.get(userId);
        if (!remaining) return;
        remaining.delete(send);
        // Dropped entirely rather than left empty, so a long-lived process does not accumulate a
        // set per person who ever connected.
        if (remaining.size === 0) connections.delete(userId);
      };
    },

    deliver(event) {
      for (const userId of event.memberIds) {
        for (const send of connections.get(userId) ?? []) {
          try {
            send(JSON.stringify(event));
          } catch {
            // A connection that cannot be written to is one that is closing. Its own close handler
            // detaches it; failing here would deny the event to everybody after it in the set.
          }
        }
      }
    },

    connectionCount(userId) {
      return connections.get(userId)?.size ?? 0;
    },
  };
}

/**
 * Como um escritor anuncia atividade. É o que o `pg_notify` era no openbot,
 * reduzido ao contrato: o store de canais recebe isto injetado e nunca sabe se
 * do outro lado há um hub in-process (hoje) ou um transporte entre processos
 * (um deploy futuro). Nunca é fonte de verdade — só notícia.
 */
export type AnnounceChannelActivity = (event: ChannelActivityEvent) => void;

/** O anúncio desta estação: entrega direto no hub deste processo. */
export function createInProcessAnnouncer(
  hub: ChannelEventHub,
): AnnounceChannelActivity {
  return (event) => {
    try {
      hub.deliver(event);
    } catch {
      // A payload we cannot deliver is not a reason to fail the write that produced it: the roster
      // query is still correct, and the next refetch shows whatever this event would have.
    }
  };
}
