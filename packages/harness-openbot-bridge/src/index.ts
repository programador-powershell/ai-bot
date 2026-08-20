/**
 * @aibot2/harness-openbot-bridge — o transporte do AI-BOT 2.
 *
 * Quatro camadas, de baixo para cima:
 *   ws.ts       — WebSocket RFC 6455 clean-room (servidor, stdlib pura)
 *   router.ts   — roteador HTTP mínimo + o seam RoteadorHttp (Hono aguarda TI/SI)
 *   eventbus.ts — fanout por sessão sobre o log durável (Lagged → 1013)
 *   stream.ts   — o protocolo hello/ready/replay/re-hello (forma do stream.go)
 *   plugin.ts   — tudo acima montável como plugins do harness-kernel
 */

export * from './ws.js'
export * from './router.js'
export * from './eventbus.js'
export * from './stream.js'
export * from './plugin.js'
