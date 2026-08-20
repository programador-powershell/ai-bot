import type { Message } from "@ag-ui/core";
import { type ReactNode, useEffect } from "react";
import { ApprovalCard } from "@/components/channels/approval-card";
import { ConversationView } from "@/components/channels/conversation-view";
import type {
  AgentOption,
  CommandOption,
  ComposerDraft,
} from "@/components/channels/composer";
import { useConversaDoLog } from "@/lib/chat/use-conversa";
import type { MensagemDaConversa } from "@/lib/chat/protocolo";

/**
 * [Onda 2] A superfície de conversa que renderiza DO REPLAY DO LOG — o miolo
 * compartilhado entre o canal (channel-chat.tsx) e o chat direto com o Bot
 * (routes/bot.tsx). O CopilotKit saiu do caminho da conversa: quem fala com o
 * servidor é o nosso protocolo (lib/chat), e a tela é uma projeção pura dos
 * envelopes — a MESMA sessão que o desktop Tauri desenha, porque as duas
 * janelas leem o mesmo log.
 */

/** A projeção MensagemDaConversa → Message do transcript (id/role/content). */
function comoMessages(mensagens: readonly MensagemDaConversa[]): Message[] {
  return mensagens.map(
    (mensagem) =>
      ({
        id: mensagem.id,
        role: mensagem.role,
        content: mensagem.text,
      }) as Message,
  );
}

export function ConversaDoLog({
  threadId,
  agents,
  commands,
  disabled = false,
  notice,
  onSaid,
  registrarEnviar,
}: {
  threadId: string | undefined;
  agents?: readonly AgentOption[];
  commands?: readonly CommandOption[];
  disabled?: boolean;
  notice?: ReactNode;
  /** Avisa quem quiser reportar atividade (o roster do canal). */
  onSaid?: (text: string) => void;
  /** Entrega o `enviar` da conversa a quem precisa falar por fora do composer (o seed do canal). */
  registrarEnviar?: (enviar: (texto: string) => boolean) => void;
}) {
  const conversa = useConversaDoLog(threadId);

  // Por efeito, não no render: preencher um ref do pai durante o render é
  // efeito colateral fora de hora (StrictMode o repetiria).
  useEffect(() => {
    registrarEnviar?.(conversa.enviar);
  });

  /*
   * [Onda 3] Os cartões de aprovação vivos, ACIMA do composer: é onde a
   * pessoa está olhando quando o bot pede licença, e é a projeção do replay —
   * um cartão que sobreviveu a um reinício do server volta sozinho aqui, com
   * o prazo contando do pedido original.
   */
  const cartoes =
    conversa.estado.aprovacoes.length > 0 ? (
      <div>
        {conversa.estado.aprovacoes.map((aprovacao) => (
          <ApprovalCard
            aprovacao={aprovacao}
            disabled={conversa.status !== "ready"}
            key={aprovacao.callId}
            onDecide={(allow, scope) => {
              conversa.decidir(aprovacao.callId, allow, scope);
            }}
          />
        ))}
      </div>
    ) : null;

  const aviso = conversa.indisponivel ? (
    <p className="pb-2 text-sm text-destructive" role="alert">
      A conversa não pôde ser aberta: o servidor não entregou o acesso ao
      stream. Entre de novo ou verifique o server.
    </p>
  ) : conversa.status === "offline" ? (
    <p className="pb-2 text-sm text-muted-foreground" role="status">
      Sem conexão com a conversa — reconectando. O que já foi dito está
      guardado no log e volta sozinho.
    </p>
  ) : (
    notice
  );

  return (
    <ConversationView
      agents={agents ?? []}
      busy={conversa.estado.turnoAberto}
      commands={commands}
      // Sem conexão o composer DESLIGA com o aviso ao lado, em vez de aceitar
      // um Enter que seria engolido — a lição do desktop ("enviar sem conexão
      // fala em vez de engolir o Enter"), resolvida aqui por construção.
      disabled={disabled || conversa.indisponivel || conversa.status !== "ready"}
      messages={comoMessages(conversa.estado.mensagens)}
      notice={
        cartoes !== null || aviso !== null ? (
          <>
            {cartoes}
            {aviso}
          </>
        ) : null
      }
      onSubmit={(draft: ComposerDraft) => {
        const mandou = conversa.enviar(draft.text);
        if (mandou) onSaid?.(draft.text.trim());
      }}
      pending={conversa.estado.turnoAberto}
    />
  );
}
