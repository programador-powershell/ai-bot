/**
 * Para onde o browser do bot PODE navegar — o egress anti-SSRF.
 *
 * Porte adaptado do server/src/computer/target.ts do openbot (MIT, pin
 * 06a1a84; ver THIRD_PARTY_NOTICES.md), com UMA mudança deliberada: o openbot
 * é "deliberately dumb" (sem DNS de propósito); aqui a regra da frente manda
 * RESOLVER o DNS e bloquear IP privado DEPOIS de resolver — porque um browser
 * de computer-use roda DENTRO da rede da casa, e `http://painel-interno.corp`
 * resolve para 10.x sem nunca escrever um IP na URL. Checar só o texto da URL
 * deixaria o nome bonito passar.
 *
 * Limite conhecido (declarado, não escondido): a checagem é ANTES da
 * navegação — um DNS que troca a resposta entre a checagem e o goto (DNS
 * rebinding) ainda passa. Fechar isso exige interceptação por request/proxy e
 * fica para a leva do proxy de egress por bot.
 *
 * A ordem das defesas:
 *  1. só http/https;
 *  2. metadata de nuvem (169.254.169.254, metadata.google.internal) NUNCA —
 *     nem com o opt-in: é por onde as credenciais de nuvem de um container
 *     vazam, e nenhuma tarefa de desenvolvimento precisa disso;
 *  3. IP literal privado / hostname interno → recusa (salvo opt-in);
 *  4. hostname → resolve DNS: QUALQUER endereço privado na resposta recusa
 *     (salvo opt-in) — metadata na resposta recusa SEMPRE.
 *
 * `allowPrivateHosts` existe porque um deployment local legitimamente navega
 * nos próprios serviços (e os TESTES servem fixtures em 127.0.0.1). É opt-in
 * explícito na subida, nunca default — produção não alcança a própria rede
 * por esquecimento.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** Endereços que NENHUM deployment abre, nem com opt-in de hosts privados. */
const NEVER_ALLOWED_HOSTNAMES = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
])

/** Hostnames de dentro do deployment. Alcançáveis só com o opt-in. */
const INTERNAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export type EgressVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string }

/** Resolve hostname → endereços. Injetável: o teste de SSRF não depende da rede. */
export type Resolver = (hostname: string) => Promise<string[]>

const resolveWithDns: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map((answer) => answer.address)
}

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number.parseInt(part, 10))
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false
  }
  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return true // "esta rede"
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true // link-local — inclui a metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === '::' || lower === '::1') return true
  // IPv4 mapeado (::ffff:10.0.0.1): o veredito é o do IPv4 embutido.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped !== null) return isPrivateIpv4(mapped[1]!)
  const head = lower.split(':')[0] ?? ''
  if (head === '') return false
  const value = Number.parseInt(head, 16)
  if (Number.isNaN(value)) return false
  if ((value & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((value & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  return false
}

function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isPrivateIpv4(address)
  if (kind === 6) return isPrivateIpv6(address)
  return false
}

/** A metadata é recusa INCONDICIONAL — também quando aparece resolvida. */
function isMetadataAddress(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
  return lower === '169.254.169.254' || lower === '::ffff:169.254.169.254'
}

export interface EgressOptions {
  /** Opt-in para hosts da própria rede (deployment local / testes). */
  allowPrivateHosts?: boolean
  /** Resolver injetável; ausente = DNS real do sistema. */
  resolve?: Resolver
}

/**
 * Decide se o bot pode navegar até aqui. Devolve MOTIVO em vez de exceção:
 * quem chama renderiza para uma pessoa, e "esse endereço é de dentro da rede"
 * é acionável — stack trace não é.
 */
export async function checkNavigationTarget(
  raw: string,
  options: EgressOptions = {},
): Promise<EgressVerdict> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { allowed: false, reason: 'Isso não é um endereço web.' }
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      allowed: false,
      reason: `Só endereços web são permitidos, e esse é ${url.protocol.replace(':', '')}.`,
    }
  }

  const hostname = url.hostname.toLowerCase()

  // Antes do opt-in, para que NENHUMA configuração alcance a metadata.
  if (NEVER_ALLOWED_HOSTNAMES.has(hostname) || isMetadataAddress(hostname)) {
    return {
      allowed: false,
      reason:
        'Esse endereço guarda as credenciais de nuvem deste deployment — o assistente nunca pode abri-lo.',
    }
  }

  const literalIp = isIP(hostname.replace(/^\[|\]$/g, '')) !== 0

  if (INTERNAL_HOSTNAMES.has(hostname) || (literalIp && isPrivateAddress(hostname))) {
    if (options.allowPrivateHosts === true) {
      return { allowed: true, url: url.toString() }
    }
    return {
      allowed: false,
      reason:
        'Esse endereço é de dentro da rede deste deployment — o assistente não pode abri-lo.',
    }
  }

  if (literalIp) {
    // IP literal público: nada a resolver.
    return { allowed: true, url: url.toString() }
  }

  // A parte que o openbot deliberadamente NÃO faz e esta frente exige: o nome
  // é resolvido AGORA, e o veredito é sobre o que ele resolve — não sobre a
  // cara que ele tem.
  const resolve = options.resolve ?? resolveWithDns
  let addresses: string[]
  try {
    addresses = await resolve(hostname)
  } catch (error) {
    // Fail closed: nome que não resolve não navega mesmo — recusar com motivo
    // é mais honesto que deixar o goto estourar um erro de rede genérico.
    return {
      allowed: false,
      reason: `Esse nome não resolveu (${error instanceof Error ? error.message : String(error)}).`,
    }
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: 'Esse nome não resolveu para nenhum endereço.' }
  }

  for (const address of addresses) {
    if (isMetadataAddress(address)) {
      return {
        allowed: false,
        reason:
          'Esse nome resolve para o endereço de metadata da nuvem — o assistente nunca pode abri-lo.',
      }
    }
    if (isPrivateAddress(address)) {
      if (options.allowPrivateHosts === true) continue
      return {
        allowed: false,
        reason: `Esse nome resolve para um endereço de dentro da rede (${address}) — o assistente não pode abri-lo.`,
      }
    }
  }

  return { allowed: true, url: url.toString() }
}
