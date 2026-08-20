/**
 * [Onda 2 — §4.6] O chat LIGA por padrão: a conversa fala o NOSSO protocolo
 * WS (lib/chat — hello/ready/replay/prompt/delta/done) contra o event log do
 * chassis, e o CopilotKit saiu do caminho dela. A flag agora existe para
 * DESLIGAR em diagnóstico (`VITE_CHAT_ENABLED=false`), não para ligar.
 *
 * É comparação estrita com "false" (e não falsiness) para a flag nunca
 * desligar por acidente de shell — a mesma postura do OPENBOT_DEV_NO_AUTH no
 * server, invertida junto com o padrão.
 */
export const chatEnabled = import.meta.env.VITE_CHAT_ENABLED !== "false";
