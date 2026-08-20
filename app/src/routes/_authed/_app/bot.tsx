import { createFileRoute } from "@tanstack/react-router";
import { ChatDesligado } from "@/components/channels/chat-desligado";
import { ConversaDoLog } from "@/components/channels/conversa-do-log";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { chatEnabled } from "@/lib/flags";

/**
 * [Onda 2] O chat direto com o Bot, RELIGADO no nosso protocolo: a thread
 * continua cunhada pelo deployment (useBotThread → /api/threads/mint), mas a
 * conversa agora é o event log — a mesma superfície de replay do canal
 * (ConversaDoLog), no lugar do <CopilotChat> do pacote (que morreu junto com
 * o runtime).
 */
export const Route = createFileRoute("/_authed/_app/bot")({
  component: chatEnabled
    ? RouteComponent
    : () => <ChatDesligado surface="O chat direto com o Bot" />,
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const agentId = agent ?? "risk-analyst";

  // Minted by this deployment rather than by the chat, and the same one on the next visit.
  const threadId = useBotThread(agentId);

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">Browser Bot</h1>
        <p className="text-sm text-muted-foreground">
          Ask it to open a page and watch it work.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        {/* Remount when switching Bots so a conversa fica presa ao agente escolhido. */}
        {threadId ? <ConversaDoLog key={agentId} threadId={threadId} /> : null}
      </div>
    </div>
  );
}
