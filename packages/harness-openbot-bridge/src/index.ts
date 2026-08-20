/**
 * @aibot2/harness-openbot-bridge — o transporte do AI-BOT 2.
 *
 * As camadas, de baixo para cima ([Onda 2] o protocolo ganhou um seam de
 * conexão e o roteador ganhou a implementação Hono — o clean-room virou dublê):
 *   conexao.ts     — o seam ConexaoDeStream (WsConn e o adaptador Bun o implementam)
 *   ws.ts          — WebSocket RFC 6455 clean-room (dublê de teste / transporte Node)
 *   router.ts      — o seam RoteadorHttp (fetch) + MiniRoteador (dublê clean-room)
 *   router-hono.ts — RoteadorHono, a implementação de PRODUÇÃO do seam
 *   eventbus.ts    — fanout por sessão sobre o log durável (Lagged → 1013)
 *   stream.ts      — o protocolo hello/ready/replay/re-hello (forma do stream.go)
 *   plugin.ts      — tudo acima montável como plugins do harness-kernel (Node)
 */

export * from './conexao.js'
export * from './ws.js'
export * from './router.js'
export * from './router-hono.js'
export * from './eventbus.js'
export * from './stream.js'
export * from './plugin.js'
