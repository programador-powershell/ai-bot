import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversaDoLog } from "@/components/channels/conversa-do-log";
import { takeFirstMessage } from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { recordChannelActivityMutationOptions } from "@/lib/channels/mutations";
import type { AgentChannel } from "@/lib/channels/queries";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

/**
 * [Onda 2] One channel's conversation — RELIGADA no NOSSO protocolo.
 *
 * O que este arquivo era: o cliente do CopilotKit (useAgent/useCopilotKit,
 * gates de join, contadores de run×turn, reparo de histórico). O que ele é
 * agora: a costura fina entre o canal (roster, skills, atividade) e a
 * superfície do log (ConversaDoLog) — a conversa em si é o replay do event
 * log via WS hello/ready/replay/prompt/delta/done, a MESMA sessão que o
 * desktop desenha. Toda a maquinaria de estado do CopilotKit morreu porque o
 * problema dela morreu: não há mais dois donos da verdade da conversa.
 *
 * `@copilotkit/react-core` saiu do caminho da conversa AQUI (aceite da onda);
 * o que resta dele no app são superfícies de tools/gallery atrás do provider
 * aposentado, com prazo final na onda 3.
 */
export function ChannelChat({
  channel,
  runtimeAgentId,
}: {
  channel: AgentChannel;
  runtimeAgentId: string;
}) {
  // Mentions are scoped to the channel's permitted agents.
  const { data: agentProfiles } = useQuery(agentListQueryOptions());

  // O menu `/` continua vindo dos grants do Bot; a INSTRUÇÃO da skill virar
  // turno de sistema no funil é da onda 3 (o funil é quem monta o contexto).
  const skillCommands = useSkillCommands(runtimeAgentId);

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const report = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    recordActivity.mutate({
      agentId: null,
      at: new Date().toISOString(),
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  /**
   * First-message seed from the compose screen, enviada UMA vez pelo NOSSO
   * protocolo assim que a conversa estiver de pé — sem gate de join: o log é
   * durável, e a linha aparece quando o replay a devolver.
   */
  const [seed] = useState<string | null>(() => {
    const pending = takeFirstMessage(channel.id);
    return pending ?? null;
  });
  const seedRef = useRef(seed);
  const enviarRef = useRef<((texto: string) => boolean) | null>(null);
  useEffect(() => {
    if (seedRef.current === null) return;
    // Tenta até a conexão abrir (o transporte reconecta sozinho); o texto da
    // pessoa não pode morrer com um socket que ainda não subiu.
    const relogio = setInterval(() => {
      const pendente = seedRef.current;
      if (pendente === null) {
        clearInterval(relogio);
        return;
      }
      if (enviarRef.current?.(pendente) === true) {
        seedRef.current = null;
        reportRef.current(pendente);
        clearInterval(relogio);
      }
    }, 250);
    return () => clearInterval(relogio);
  }, []);

  return (
    <ConversaDoLogComSeed
      agents={toAgentOptions(agentProfiles, channel.agentIds)}
      channel={channel}
      commands={skillCommands}
      enviarRef={enviarRef}
      onSaid={(text) => reportRef.current(text)}
    />
  );
}

/**
 * A ponte do seed: expõe o `enviar` da conversa para o efeito acima sem
 * remontar a superfície — o ref é preenchido por render, o efeito consome.
 */
function ConversaDoLogComSeed({
  agents,
  channel,
  commands,
  enviarRef,
  onSaid,
}: {
  agents: ReturnType<typeof toAgentOptions>;
  channel: AgentChannel;
  commands: ReturnType<typeof useSkillCommands>;
  enviarRef: React.MutableRefObject<((texto: string) => boolean) | null>;
  onSaid: (text: string) => void;
}) {
  return (
    <ConversaDoLog
      agents={agents}
      commands={commands}
      disabled={!channel.active}
      notice={
        channel.active ? null : (
          <p className="pb-2 text-sm text-muted-foreground" role="status">
            This coworker has been deleted. The conversation stays readable,
            but it can no longer reply.
          </p>
        )
      }
      onSaid={onSaid}
      registrarEnviar={(enviar) => {
        enviarRef.current = enviar;
      }}
      threadId={channel.threadId}
    />
  );
}
