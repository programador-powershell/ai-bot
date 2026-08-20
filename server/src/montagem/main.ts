/**
 * Entrada do processo: config do ambiente → montagem → esperar o fim.
 *
 * O resumo de boot NUNCA inclui o token (a mesma decisão do String() da Config
 * do oráculo: um log distraído não pode despejar segredo).
 */

import { carregarConfig } from './config.js'
import { montarServidor } from './montagem.js'

async function main(): Promise<void> {
  const config = carregarConfig()
  const servidor = await montarServidor(config)
  console.info('[aibot2] ouvindo', {
    endereco: `${servidor.transporte.host}:${servidor.transporte.porta}`,
    dataDir: config.dataDir,
    origens: config.allowOrigins.join(',') || 'nenhuma',
  })

  let encerrando = false
  const encerrar = (sinal: string) => {
    if (encerrando) return
    encerrando = true
    console.info(`[aibot2] encerrando (${sinal})`)
    void servidor.dispose().then(
      () => process.exit(0),
      (erro) => {
        console.error('[aibot2] falha no encerramento', erro)
        process.exit(1)
      },
    )
  }
  process.on('SIGINT', () => encerrar('SIGINT'))
  process.on('SIGTERM', () => encerrar('SIGTERM'))
}

main().catch((erro) => {
  console.error('[aibot2] falha na subida', erro instanceof Error ? erro.message : erro)
  process.exit(1)
})
