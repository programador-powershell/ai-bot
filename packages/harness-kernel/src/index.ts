/**
 * @aibot2/harness-kernel — kernel de plugins clean-room do AI-BOT 2
 * (m1-plano §2, escopo fechado). Zero dependências de runtime por decisão:
 * homologação é por dependência, e o subconjunto de que precisamos cabe aqui.
 *
 * A forma da API fica próxima do Cordis de propósito (cláusula de saída do
 * plano): se um dia a casa preferir a dependência npm, a troca é mecânica.
 *
 * Os re-exports são `export *` — e isso é requisito, não estilo: o declaration
 * merging dos consumidores (`declare module '@aibot2/harness-kernel'`) só
 * funde `Context`/`Events` através de star re-export.
 */
export * from './context.js'
export * from './events.js'
export * from './plugin.js'
export * from './scope.js'
export * from './service.js'
export * from './compose.js'
