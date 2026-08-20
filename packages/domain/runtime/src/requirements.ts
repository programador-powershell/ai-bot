/**
 * RuntimeRequirements: o que a TAREFA exige da máquina que a executa.
 *
 * É requisito de ADMISSÃO, não preferência (arquitetura-cluster.md): um PC sem
 * navegador headless não atende o bot de Design, e mandar a tarefa para ele é
 * falhar DEPOIS de materializar o workspace — o custo alto na hora errada.
 *
 * A Needle (needle-orchestrator) DECLARA requirements como um Record opaco
 * dentro da DecisionTask; quem o interpreta é ESTE módulo, do lado do control
 * plane. A leitura é deliberadamente estreita: campos desconhecidos são
 * descartados — em especial, qualquer tentativa do modelo de nomear MÁQUINA
 * (workerId/worker/machine/pc) morre aqui, porque cérebro declara requisito e
 * scheduler escolhe máquina, nunca o contrário (spec §28).
 */

/** O que a tarefa exige da máquina. Tudo opcional: ausente = não exige. */
export interface RuntimeRequirements {
  /** Perfil declarativo ("node-24", "python-3.12") — a chave da camada base do snapshot. */
  profile?: string
  /** Runtimes exigidos por nome ("node", "python", "jvm"...). */
  runtimes?: string[]
  /** Arquitetura exigida ("x64", "arm64"). */
  arch?: string
  minRamBytes?: number
  minCpus?: number
  gpu?: boolean
  docker?: boolean
  /** Navegador headless (o bot de Design). */
  browser?: boolean
  /** Capacidades nomeadas extras (devices, "webcam", "impressora"...). */
  capabilities?: string[]
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function asTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return list.length > 0 ? list : undefined
}

/**
 * Lê o Record opaco vindo da decisão do modelo e devolve SOMENTE o vocabulário
 * de requisitos. Campo desconhecido não é erro: a decisão já passou pelo
 * schema fechado do needle-orchestrator; aqui a regra é de AUTORIDADE — o que
 * não é requisito declarável (um `workerId`, por exemplo) simplesmente não
 * existe para o scheduler. Ignorar em silêncio é o comportamento correto
 * porque recusar daria ao modelo um canal de controle por tentativa e erro.
 */
export function parseRequirements(raw: Record<string, unknown> | undefined): RuntimeRequirements {
  if (raw === undefined) return {}
  const parsed: RuntimeRequirements = {}
  const profile = asTrimmed(raw['profile'])
  if (profile !== undefined) parsed.profile = profile
  const runtimes = asStringList(raw['runtimes'])
  if (runtimes !== undefined) parsed.runtimes = runtimes
  const arch = asTrimmed(raw['arch'])
  if (arch !== undefined) parsed.arch = arch
  const minRamBytes = asPositive(raw['minRamBytes'])
  if (minRamBytes !== undefined) parsed.minRamBytes = minRamBytes
  const minCpus = asPositive(raw['minCpus'])
  if (minCpus !== undefined) parsed.minCpus = minCpus
  const gpu = asBool(raw['gpu'])
  if (gpu !== undefined) parsed.gpu = gpu
  const docker = asBool(raw['docker'])
  if (docker !== undefined) parsed.docker = docker
  const browser = asBool(raw['browser'])
  if (browser !== undefined) parsed.browser = browser
  const capabilities = asStringList(raw['capabilities'])
  if (capabilities !== undefined) parsed.capabilities = capabilities
  return parsed
}
