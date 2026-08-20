/**
 * [Onda 1 — §4.6] O chat do chassis nasce DESLIGADO, de propósito: o server
 * não monta o CopilotKit Intelligence (R3 — a conversa é o nosso event log) e
 * um chat apontando para um runtime que não existe seria degraded-mode
 * fingido. A onda 2 religa o chat no NOSSO protocolo WS; até lá,
 * `VITE_CHAT_ENABLED=true` existe só para desenvolvimento da própria onda 2.
 *
 * É comparação estrita com "true" (e não truthiness) para a flag nunca ligar
 * por acidente de shell — a mesma postura do OPENBOT_DEV_NO_AUTH no server.
 */
export const chatEnabled = import.meta.env.VITE_CHAT_ENABLED === "true";
