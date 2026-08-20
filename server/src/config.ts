/**
 * A configuração do processo, lida do AMBIENTE — a forma do config.go do
 * oráculo, e pelo mesmo motivo: o caso normal deste servidor é ser sidecar (o
 * host o executa com um bloco de variáveis e espera a porta abrir). Um arquivo
 * de configuração seria uma SEGUNDA fonte da verdade, editável com o app no ar
 * e capaz de discordar do que o host acabou de passar.
 *
 * Os padrões precisam ser suficientes: numa estação sem nenhuma variável,
 * carregar() devolve uma configuração que sobe. O que não pode ter padrão — o
 * token — é MATERIALIZADO no primeiro boot e lido do disco nos seguintes;
 * regerar invalidaria o token que o host já leu, então arquivo existente é
 * lido, nunca sobrescrito.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Nomes das variáveis — exportados para instalador/host escreverem EXATAMENTE estas chaves. */
export const ENV_BIND = 'AIBOT_BIND'
export const ENV_DATA_DIR = 'AIBOT_DATA_DIR'
export const ENV_TOKEN = 'AIBOT_TOKEN'
export const ENV_ALLOW_ORIGINS = 'AIBOT_ALLOW_ORIGINS'

/** Loopback de propósito: este processo executa ferramenta na máquina da pessoa. */
export const BIND_PADRAO = '127.0.0.1:8799'

/** Bytes do token antes do base64 (256 bits — o mesmo tokenSize do oráculo). */
const TAMANHO_DO_TOKEN = 32
const ARQUIVO_DO_TOKEN = 'token'

/**
 * As três origens legítimas do app (a lista do oráculo): a janela do Tauri em
 * produção (os dois esquemas, conforme a plataforma) e o Vite em
 * desenvolvimento. Qualquer outra origem é navegador de terceiro falando com
 * um servidor que executa comando — e isso precisa ser escolha explícita.
 */
export const ORIGENS_PADRAO: readonly string[] = [
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:1421',
]

export interface ConfigDoServidor {
  dataDir: string
  host: string
  port: number
  token: string
  allowOrigins: readonly string[]
}

/** Config inválida é erro de subida, nunca padrão silencioso. */
export class ConfigInvalidaError extends Error {
  override name = 'ConfigInvalidaError'
}

/**
 * Lê o ambiente, cria o dataDir e materializa o token. `env` é parâmetro para
 * os testes não mexerem em process.env de verdade.
 */
export function carregarConfig(env: NodeJS.ProcessEnv = process.env): ConfigDoServidor {
  const dataDir = caminhoAbsoluto(
    valorOu(env[ENV_DATA_DIR], join(homedir(), '.aibot2')),
  )
  mkdirSync(dataDir, { recursive: true })

  const { host, port } = parseBind(valorOu(env[ENV_BIND], BIND_PADRAO))

  let token = (env[ENV_TOKEN] ?? '').trim()
  if (token === '') {
    token = materializarSegredo(join(dataDir, ARQUIVO_DO_TOKEN), TAMANHO_DO_TOKEN)
  }

  const origensCruas = (env[ENV_ALLOW_ORIGINS] ?? '').trim()
  const allowOrigins =
    origensCruas === ''
      ? ORIGENS_PADRAO
      : origensCruas
          .split(',')
          .map((origem) => origem.trim())
          .filter((origem) => origem !== '')

  return { dataDir, host, port, token, allowOrigins }
}

/** `host:porta` → partes validadas. IPv6 fica para quando alguém precisar — barulhento, não errado. */
export function parseBind(bind: string): { host: string; port: number } {
  const separador = bind.lastIndexOf(':')
  if (separador <= 0 || separador === bind.length - 1) {
    throw new ConfigInvalidaError(`${ENV_BIND} precisa ser host:porta — veio ${JSON.stringify(bind)}`)
  }
  const host = bind.slice(0, separador)
  const port = Number(bind.slice(separador + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigInvalidaError(`porta inválida em ${ENV_BIND}: ${JSON.stringify(bind)}`)
  }
  return { host, port }
}

/**
 * Devolve o segredo em base64: lê o arquivo se ele existir, sorteia e grava se
 * não existir. Arquivo existente é lido, NUNCA sobrescrito — regerar
 * invalidaria o token que o host já leu.
 */
export function materializarSegredo(caminho: string, bytes: number): string {
  if (existsSync(caminho)) {
    const existente = readFileSync(caminho, 'utf8').trim()
    if (existente === '') {
      throw new ConfigInvalidaError(
        `arquivo de segredo vazio: ${caminho} — apague-o para gerar outro, ou preencha-o`,
      )
    }
    return existente
  }
  const segredo = randomBytes(bytes).toString('base64')
  // flag wx: se alguém criou o arquivo entre o exists e o write, falha em vez
  // de sobrescrever o segredo do outro processo.
  writeFileSync(caminho, segredo + '\n', { encoding: 'utf8', flag: 'wx' })
  return segredo
}

function valorOu(valor: string | undefined, padrao: string): string {
  const limpo = (valor ?? '').trim()
  return limpo === '' ? padrao : limpo
}

function caminhoAbsoluto(caminho: string): string {
  return isAbsolute(caminho) ? caminho : resolve(caminho)
}
