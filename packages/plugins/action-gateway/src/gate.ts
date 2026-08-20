/**
 * O Gate de permissões — porte 1:1 do `internal/permissions` do gateway Go
 * (forma e invariantes; reimplementação limpa).
 *
 * Este é o último degrau antes do efeito colateral, e tudo aqui é escrito para
 * falhar FECHADO: risco de ferramenta desconhecida vira execute, modo
 * desconhecido vira "perguntar", política ilegível vira "recusar tudo", e uma
 * decisão esquecida (undefined) nunca compara igual a 'allow'.
 *
 * Duas armadilhas que o levantamento do oráculo registrou e que este módulo
 * existe para manter fechadas:
 *
 *  1. Um programa que COMBINA ferramentas não é porta lateral. Cada chamada de
 *     dentro do programa passa por `evaluate` como se fosse avulsa — por isso
 *     evaluate não tem parâmetro de "origem": não existe chamada privilegiada
 *     por vir de dentro de outra.
 *
 *  2. "Aprovar sempre" fica preso ao DIGEST dos argumentos (que carrega o
 *     ESCOPO projeto+especialista — ver digestOf), nunca ao nome da
 *     ferramenta. Um "sim" para fs.write naquele arquivo não pode virar cheque
 *     em branco para fs.write em qualquer outro.
 *
 * O que este porte ACRESCENTA ao Go (exigência do E4): as regras declarativas
 * por ferramenta (`toolRules`) e o estado "política ilegível". A memória da
 * casa "política declarada e não lida" manda: campo de política declarado é
 * LIDO — inválido é recusa alta (deny em tudo), nunca default silencioso.
 */

import { createHash } from 'node:crypto'
import type { Risk } from '@aibot2/domain-events'

/** A política de aprovação escolhida para a sessão. */
export type Mode = 'ask' | 'edits' | 'all'

/** O veredito do portão. */
export type Decision = 'allow' | 'deny' | 'ask'

/**
 * Traduz um veredito para log/telemetria. O espelho do `Decision.String()` do
 * Go: um veredito esquecido (undefined, null, valor fora do conjunto) é
 * "desconhecida" — e "desconhecida" nunca é allow.
 */
export function describeDecision(value: unknown): string {
  switch (value) {
    case 'allow':
      return 'allow'
    case 'deny':
      return 'deny'
    case 'ask':
      return 'ask'
    default:
      return 'desconhecida'
  }
}

/** A regra declarativa por ferramenta — o override que TEM de ser lido. */
export type ToolRule = 'allow' | 'ask' | 'deny'

/** O que o admin (ou a automação) decidiu que esta sessão pode. */
export interface Policy {
  /**
   * `string`, e não só `Mode`, de propósito: um modo que ninguém reconhece
   * precisa CHEGAR ao evaluate para ser tratado como o mais exigente (ask) —
   * estreitar o tipo aqui empurraria o caso para um cast na borda de quem lê
   * config, que é onde ele se perderia.
   */
  mode: Mode | (string & {})
  /** Vazio/ausente significa todos — política não configurada não pode bloquear todo mundo. */
  allowedSpecialists?: string[]
  /**
   * A mesma ideia aplicada ao catálogo, com UMA diferença que vale a leitura:
   * `undefined` (campo ausente) significa todos, mas uma lista VAZIA declarada
   * significa NENHUM. A lista da edição gerenciada é calculada (catálogo menos
   * BYOK local) e pode ser legitimamente vazia — se vazio virasse "todos", a
   * estação mais restrita do parque seria a única com o catálogo inteiro
   * liberado. O Gate só CARREGA este campo; quem o aplica é o roteador.
   */
  allowedModels?: string[]
  /** Recusa dura: nem chega a perguntar. */
  deniedTools?: string[]
  blockedDomains?: string[]
  /** Falso derruba a ferramenta inteira e sobra só texto. */
  agentTools: boolean
  /** Tetos da delegação (D6): sem teto, o custo de uma execução não tem fim conhecido. */
  maxDepth: number
  maxChildren: number
  maxTotal: number
  /**
   * O override declarativo allow/ask/deny por ferramenta (+escopo opcional de
   * especialista, chave `especialista:ferramenta` — a mais específica vence).
   * Na ordem de avaliação: `deny` pesa como a lista de recusa (antes das
   * concessões); `allow`/`ask` pesam como um modo por-ferramenta (depois das
   * concessões, antes do modo geral).
   */
  toolRules?: Record<string, ToolRule>
}

/** O que vale quando ninguém configurou nada (idêntico ao DefaultPolicy do Go). */
export function defaultPolicy(): Policy {
  return {
    mode: 'edits',
    agentTools: true,
    maxDepth: 3,
    maxChildren: 4,
    maxTotal: 24,
  }
}

/** Política que não dá para ler. Quem a recebe recusa TUDO — na dúvida, fecha. */
export class PolicyUnreadableError extends Error {
  override name = 'PolicyUnreadableError'
}

/* ------------------------- catálogo (seam da E5) ------------------------- */

/** Um especialista como o portão o enxerga: id, nome de tela e catálogo. */
export interface SpecialistView {
  id: string
  name: string
  /**
   * O contrato do oráculo: `context.fetch` é universal (recuperar a fatia de
   * um artefato não é capacidade nova, é acesso ao que a conversa já
   * produziu) — o provider real (specialist-registry, E5) deve honrar isso.
   */
  allowsTool(tool: string): boolean
}

/**
 * O seam do catálogo. `getOrDefault` NUNCA falha por id desconhecido: uma
 * conversa antiga com id velho não pode derrubar a execução — cai no padrão
 * do catálogo (o mesmo contrato do specialist.GetOrDefault do Go).
 */
export interface SpecialistDirectory {
  getOrDefault(id: string): SpecialistView
}

/* --------------------------------- Gate ---------------------------------- */

/** O veredito com a frase que a tela mostra. */
export interface GateVerdict {
  decision: Decision
  /**
   * Motivo em português — nunca vazio: sem frase, o diálogo de aprovação vira
   * um botão que se aperta no automático.
   */
  reason: string
}

/** Guarda a política e o que a pessoa já liberou nesta sessão de processo. */
export class Gate {
  #policy: Policy
  /** Par ferramenta+digest já aprovado — o escopo do "aprovar sempre". */
  #digests = new Set<string>()
  /** Ferramenta liberada por inteiro para UM especialista — o escopo largo. */
  #session = new Set<string>()
  /** Quando a política declarada não pôde ser lida, TUDO recusa com este motivo. */
  #unreadable: string | undefined
  readonly #directory: SpecialistDirectory

  constructor(policy: Policy, directory: SpecialistDirectory) {
    this.#policy = clonePolicy(policy)
    this.#directory = directory
  }

  /**
   * Troca a política em execução. As concessões já dadas NÃO são apagadas
   * porque não precisam ser: evaluate consulta a política antes do cache,
   * então apertar a política já invalida na prática o que foi concedido.
   */
  setPolicy(policy: Policy): void {
    this.#policy = clonePolicy(policy)
    this.#unreadable = undefined
  }

  /**
   * Carrega política vinda de DADO (arquivo, rede). Ilegível = o portão
   * envenena: toda avaliação vira deny até alguém carregar uma política que
   * preste. O erro NUNCA cai num default silencioso — uma política declarada
   * que não foi lida é exatamente o defeito que já aconteceu três vezes na
   * casa.
   */
  loadPolicy(raw: unknown): void {
    try {
      this.setPolicy(parsePolicy(raw))
    } catch (error) {
      this.#unreadable = error instanceof Error ? error.message : String(error)
    }
  }

  /** O motivo do envenenamento, para a superfície de diagnóstico. */
  get unreadableReason(): string | undefined {
    return this.#unreadable
  }

  /** Devolve uma CÓPIA — cópia rasa deixaria reescrever a lista de recusa por fora. */
  policy(): Policy {
    return clonePolicy(this.#policy)
  }

  /** Diz se o especialista está liberado — fora da política nem aparece como destino. */
  allowsSpecialist(id: string): boolean {
    return specialistAllowed(this.#policy.allowedSpecialists, id.trim())
  }

  /**
   * Decide uma chamada de ferramenta. A ordem importa e é a mais restritiva
   * primeiro: política ilegível, recusa dura (lista + regra declarada),
   * interruptor geral, catálogo do especialista, cache de concessões, regra
   * declarada allow/ask e só então o modo.
   */
  evaluate(specialistID: string, tool: string, risk: Risk, digest: string): GateVerdict {
    specialistID = specialistID.trim()
    tool = tool.trim()
    digest = digest.trim()

    // (0) Política que não deu para ler recusa TUDO. Vem antes até da lista de
    // recusa: as listas em vigor são as da política anterior, e decidir por
    // elas seria fingir que a troca declarada não existiu.
    if (this.#unreadable !== undefined) {
      return {
        decision: 'deny',
        reason: `a política desta sessão não pôde ser lida (${this.#unreadable}) — nada roda até ela ser corrigida`,
      }
    }

    // (1) Recusa dura do admin. Antes de tudo, inclusive de "aprovar tudo": o
    // que a empresa proibiu não é assunto da automação.
    for (const denied of this.#policy.deniedTools ?? []) {
      if (equalFold(denied.trim(), tool)) {
        return { decision: 'deny', reason: `a política recusa a ferramenta ${tool}` }
      }
    }

    // (1b) Regra declarada `deny` pesa como a lista de recusa. Lida SEMPRE —
    // é o teste-prova da memória "política declarada e não lida".
    const declared = this.#toolRule(specialistID, tool)
    if (declared?.rule === 'deny') {
      return {
        decision: 'deny',
        reason: `a regra declarada ${declared.key} recusa a ferramenta ${tool}`,
      }
    }

    // (2) Interruptor geral.
    if (!this.#policy.agentTools) {
      return {
        decision: 'deny',
        reason: 'a política desta sessão não libera ferramenta nenhuma — só texto',
      }
    }

    // (3) Catálogo do especialista. getOrDefault não falha por id desconhecido.
    if (!specialistAllowed(this.#policy.allowedSpecialists, specialistID)) {
      return {
        decision: 'deny',
        reason: `o especialista ${specialistID} não está liberado para esta sessão`,
      }
    }
    const definition = this.#directory.getOrDefault(specialistID)
    if (!definition.allowsTool(tool)) {
      return {
        decision: 'deny',
        reason: `o especialista ${definition.name} não usa a ferramenta ${tool}`,
      }
    }

    // (4) O que a pessoa já liberou. O digest primeiro, porque é o escopo
    // estreito e o que carrega a informação útil para a frase da tela.
    if (digest !== '' && this.#digests.has(grantKey(tool, digest))) {
      return {
        decision: 'allow',
        reason: 'você já aprovou esta ferramenta com estes mesmos argumentos',
      }
    }
    if (this.#session.has(sessionGrantKey(specialistID, tool))) {
      return {
        decision: 'allow',
        reason: `${tool} foi liberada para ${definition.name} nesta sessão`,
      }
    }

    // (5) Regra declarada allow/ask: um modo POR FERRAMENTA. Depois das
    // concessões (concessão existe para responder um ask) e antes do modo
    // geral (a regra específica vence a genérica).
    if (declared?.rule === 'allow') {
      return {
        decision: 'allow',
        reason: `a regra declarada ${declared.key} libera a ferramenta ${tool}`,
      }
    }
    if (declared?.rule === 'ask') {
      return {
        decision: 'ask',
        reason: `a regra declarada ${declared.key} pede confirmação para ${tool}`,
      }
    }

    // (6) O modo.
    switch (this.#policy.mode) {
      case 'all':
        // Fail-closed do E4: ferramenta que a tabela de risco NÃO conhece não
        // nasce liberada nem em "aprovar tudo" — ela pergunta. O custo (uma
        // automação sem humano recusa por prazo) é o preço de uma ferramenta
        // nova/MCP nunca estrear sem ninguém olhar; quem quiser liberá-la de
        // verdade DECLARA a regra allow, que é lida no passo (5).
        if (!riskTableKnows(tool)) {
          return {
            decision: 'ask',
            reason: `a ferramenta ${tool} não está classificada — pede confirmação mesmo na política "aprovar tudo"`,
          }
        }
        return { decision: 'allow', reason: 'política "aprovar tudo" — sessão sem confirmação' }
      case 'edits':
        // Rede fica de fora da lista que pergunta porque o destino já passou
        // pela blocklist (hostBlocked) e uma chamada de rede não altera
        // arquivo nem roda processo na estação.
        switch (risk) {
          case 'write':
          case 'execute':
          case 'secret':
            return {
              decision: 'ask',
              reason: `risco ${risk} pede confirmação na política "aprovar edições"`,
            }
          default:
            return {
              decision: 'allow',
              reason: `risco ${risk} não altera nem executa nada no projeto`,
            }
        }
      case 'ask':
        return { decision: 'ask', reason: 'política "perguntar sempre"' }
      default:
        // Modo que ninguém reconhece é tratado como o mais exigente.
        return {
          decision: 'ask',
          reason: `política "${String(this.#policy.mode)}" desconhecida — tratada como "perguntar sempre"`,
        }
    }
  }

  /**
   * Registra o que a pessoa liberou. O escopo é a diferença entre um sim e um
   * cheque em branco:
   *
   *  - "once" não guarda NADA (a chamada em curso já foi liberada por quem
   *    clicou; guardar transformaria resposta pontual em regra);
   *  - "digest" prende a liberação ao par ferramenta+argumentos;
   *  - "session" libera a ferramenta inteira PARA AQUELE ESPECIALISTA até o
   *    revoke — sem o especialista na chave, aprovar fs.write olhando o de
   *    código liberava a mesma ferramenta para o de design.
   *
   * Digest vazio com escopo "digest" não guarda nada (seria o cheque em branco
   * por nome); escopo desconhecido também não — na dúvida, fecha.
   */
  grant(scope: string, specialistID: string, tool: string, digest: string): void {
    scope = scope.trim().toLowerCase()
    specialistID = specialistID.trim()
    tool = tool.trim()
    digest = digest.trim()
    if (tool === '') return

    switch (scope) {
      case 'digest':
        if (digest === '') return
        this.#digests.add(grantKey(tool, digest))
        break
      case 'session':
        this.#session.add(sessionGrantKey(specialistID, tool))
        break
    }
  }

  /**
   * Apaga tudo o que foi concedido — o botão "revogar aprovações", e o que a
   * troca de projeto deve chamar: aprovação dada olhando um repositório não
   * vale para outro.
   */
  revoke(): void {
    this.#digests.clear()
    this.#session.clear()
  }

  /** Descreve, em português e em ordem estável, o que está concedido. */
  granted(): string[] {
    const out: string[] = []
    for (const key of this.#digests) {
      const [tool, digest] = cutOnce(key, GRANT_SEPARATOR)
      out.push(`${tool} — argumentos ${shortDigest(digest)}`)
    }
    for (const key of this.#session) {
      const [specialistID, tool] = cutOnce(key, GRANT_SEPARATOR)
      out.push(`${tool} — ${this.#directory.getOrDefault(specialistID).name} nesta sessão`)
    }
    // Ordem estável porque a lista aparece numa tela — não pode dançar a cada render.
    return out.sort()
  }

  /** A regra declarada aplicável — a chave escopada vence a genérica. */
  #toolRule(specialistID: string, tool: string): { key: string; rule: ToolRule } | undefined {
    const rules = this.#policy.toolRules
    if (!rules) return undefined
    const scoped = `${specialistID.toLowerCase()}:${tool.toLowerCase()}`
    const plain = tool.toLowerCase()
    for (const [key, rule] of Object.entries(rules)) {
      if (key.trim().toLowerCase() === scoped) return { key: key.trim(), rule }
    }
    for (const [key, rule] of Object.entries(rules)) {
      if (key.trim().toLowerCase() === plain) return { key: key.trim(), rule }
    }
    return undefined
  }
}

/**
 * O separador das chaves de concessão. O byte nulo não aparece em nome de
 * ferramenta nem em digest hexadecimal, então não há como forjar a chave de um
 * par escrevendo o separador dentro do outro campo.
 */
const GRANT_SEPARATOR = '\x00'

function grantKey(tool: string, digest: string): string {
  return tool + GRANT_SEPARATOR + digest
}

/** Prende a liberação de sessão ao especialista que a recebeu. */
function sessionGrantKey(specialistID: string, tool: string): string {
  return specialistID + GRANT_SEPARATOR + tool
}

function cutOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator)
  if (index < 0) return [value, '']
  return [value.slice(0, index), value.slice(index + separator.length)]
}

/**
 * Encurta o digest para caber na tela. Corta por PONTO DE CÓDIGO (o análogo do
 * corte por runa do Go): cortar por unidade UTF-16 poderia partir um par
 * substituto ao meio e entregar texto inválido para a interface.
 */
function shortDigest(digest: string): string {
  const LIMIT = 12
  const points = Array.from(digest)
  if (points.length <= LIMIT) return digest
  return points.slice(0, LIMIT).join('') + '…'
}

/** Lista vazia/ausente é "todos" — ver Policy. */
function specialistAllowed(allowed: string[] | undefined, id: string): boolean {
  if (!allowed || allowed.length === 0) return true
  return allowed.some((item) => equalFold(item.trim(), id))
}

function equalFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Copia as listas para que a política guardada e a devolvida não compartilhem
 * array com quem as passou. `allowedModels` NÃO passa pelo colapso
 * vazio→ausente: neste campo os dois querem dizer o OPOSTO um do outro
 * (nenhum modelo contra todos os modelos), e colapsar na travessia mais banal
 * que existe — a cópia — abriria o catálogo inteiro na estação gerenciada.
 */
function clonePolicy(policy: Policy): Policy {
  return {
    mode: policy.mode,
    agentTools: policy.agentTools,
    maxDepth: policy.maxDepth,
    maxChildren: policy.maxChildren,
    maxTotal: policy.maxTotal,
    ...cloneList('allowedSpecialists', policy.allowedSpecialists),
    ...cloneList('deniedTools', policy.deniedTools),
    ...cloneList('blockedDomains', policy.blockedDomains),
    // Preserva a diferença entre ausente (todos) e vazia (nenhum).
    ...(policy.allowedModels !== undefined ? { allowedModels: [...policy.allowedModels] } : {}),
    ...(policy.toolRules !== undefined ? { toolRules: { ...policy.toolRules } } : {}),
  }
}

/** Preserva ausência como ausência: vazio e ausente significam o mesmo aqui. */
function cloneList(
  name: 'allowedSpecialists' | 'deniedTools' | 'blockedDomains',
  list: string[] | undefined,
): Partial<Policy> {
  if (!list || list.length === 0) return {}
  return { [name]: [...list] }
}

/* ------------------------------ parsePolicy ------------------------------ */

const TOOL_RULES: ReadonlySet<string> = new Set(['allow', 'ask', 'deny'])

/**
 * Lê uma política vinda de dado. Campo AUSENTE cai no padrão; campo PRESENTE e
 * inválido é recusa alta (PolicyUnreadableError) — nunca default silencioso.
 * É a tradução em código da memória "política declarada e não lida": o que o
 * admin escreveu ou vale inteiro ou derruba a política inteira.
 */
export function parsePolicy(raw: unknown): Policy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyUnreadableError('política ilegível: não é um objeto')
  }
  const data = raw as Record<string, unknown>
  const policy = defaultPolicy()

  if ('mode' in data) {
    if (typeof data['mode'] !== 'string' || data['mode'].trim() === '') {
      throw new PolicyUnreadableError('política ilegível: "mode" precisa ser texto não-vazio')
    }
    policy.mode = data['mode']
  }
  if ('agentTools' in data) {
    if (typeof data['agentTools'] !== 'boolean') {
      throw new PolicyUnreadableError('política ilegível: "agentTools" precisa ser booleano')
    }
    policy.agentTools = data['agentTools']
  }
  for (const field of ['maxDepth', 'maxChildren', 'maxTotal'] as const) {
    if (field in data) {
      const value = data[field]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new PolicyUnreadableError(`política ilegível: "${field}" precisa ser inteiro >= 0`)
      }
      policy[field] = value
    }
  }
  for (const field of ['allowedSpecialists', 'deniedTools', 'blockedDomains', 'allowedModels'] as const) {
    if (field in data) {
      const value = data[field]
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new PolicyUnreadableError(`política ilegível: "${field}" precisa ser lista de textos`)
      }
      policy[field] = value as string[]
    }
  }
  if ('toolRules' in data) {
    const value = data['toolRules']
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new PolicyUnreadableError('política ilegível: "toolRules" precisa ser objeto ferramenta→regra')
    }
    const rules: Record<string, ToolRule> = {}
    for (const [key, rule] of Object.entries(value as Record<string, unknown>)) {
      if (typeof rule !== 'string' || !TOOL_RULES.has(rule)) {
        throw new PolicyUnreadableError(
          `política ilegível: regra ${JSON.stringify(rule)} para "${key}" — use allow | ask | deny`,
        )
      }
      rules[key] = rule as ToolRule
    }
    policy.toolRules = rules
  }
  return policy
}

/* --------------------------- bloqueio de domínio -------------------------- */

/**
 * Devolve a regra que bloqueia o host, se alguma bloquear. Portado com o
 * casamento por FRONTEIRA DE RÓTULO: `endsWith("exemplo.com")` casaria também
 * "malexemplo.com" — um domínio sem relação, que qualquer um registra de graça.
 *
 *  - "exemplo.com" bloqueia exemplo.com e qualquer subdomínio;
 *  - "*.exemplo.com" bloqueia SÓ os subdomínios (o apex fica liberado);
 *  - "malexemplo.com" NÃO é bloqueado por "exemplo.com".
 *
 * A regra devolvida é a original em minúsculas — quem apanhar precisa saber
 * exatamente o que pedir ao admin para liberar.
 */
export function hostBlocked(rules: readonly string[] | undefined, host: string): [string, boolean] {
  for (const rule of rules ?? []) {
    if (ruleMatchesHost(rule, host)) {
      return [rule.trim().toLowerCase(), true]
    }
  }
  return ['', false]
}

function ruleMatchesHost(rule: string, host: string): boolean {
  const normalizedRule = normalizeHost(rule)
  const normalizedHost = normalizeHost(host)
  if (normalizedRule === '' || normalizedHost === '') return false
  if (normalizedRule.startsWith('*.')) {
    const base = normalizedRule.slice(2)
    if (base === '') return false
    return normalizedHost.endsWith('.' + base)
  }
  return normalizedHost === normalizedRule || normalizedHost.endsWith('.' + normalizedRule)
}

/**
 * Deixa o host comparável: minúsculas, sem porta e sem o ponto final do FQDN.
 * O corte do ':' pula quem começa com '[' (IPv6 tem ':' no meio do nome). O
 * ponto final é aparado DEPOIS da porta para que "exemplo.com.:8080" — as duas
 * sujeiras juntas — também caia em "exemplo.com" em vez de escapar do bloqueio.
 */
function normalizeHost(host: string): string {
  let clean = host.trim().toLowerCase()
  if (!clean.startsWith('[')) {
    const index = clean.indexOf(':')
    if (index >= 0) clean = clean.slice(0, index)
  }
  return clean.replace(/\.+$/, '')
}

/* --------------------------------- risco ---------------------------------- */

/**
 * Tabela fixa, só de leitura — não é estado. Porte literal do riskByTool do
 * oráculo, comentários de julgamento inclusos.
 */
const RISK_BY_TOOL: ReadonlyMap<string, Risk> = new Map<string, Risk>([
  // Lê e não altera nada. web.fetch entra aqui porque não toca no projeto; o
  // que ele tem de perigoso é o destino, e quem cuida disso é hostBlocked.
  ['fs.read', 'read'],
  ['context.fetch', 'read'],
  ['fs.list', 'read'],
  ['fs.search', 'read'],
  ['git.status', 'read'],
  ['git.diff', 'read'],
  ['web.search', 'read'],
  ['web.fetch', 'read'],
  ['memory.read', 'read'],
  ['office.open', 'read'],
  ['pdf.extract', 'read'],
  ['runtime.status', 'read'],
  ['finetune.status', 'read'],
  ['schedule.list', 'read'],
  ['pack.list', 'read'],
  // [Onda 3] Componentes generativos pelo funil: a DECISÃO por render e a
  // leitura de dados do componente são leituras (as data functions leem a
  // própria trilha de auditoria do deployment). O que cada bot PODE renderizar
  // ou ler continua sendo o grant por especialista, conferido POR CHAMADA no
  // executor — esta linha só diz que o gesto não altera nem executa nada.
  ['component.render', 'read'],
  ['component.data', 'read'],

  // Deixa rastro: arquivo novo, arquivo alterado, worktree criada, commit
  // feito. image.generate está aqui porque termina em arquivo no disco.
  ['fs.write', 'write'],
  ['fs.patch', 'write'],
  ['office.edit', 'write'],
  ['office.export', 'write'],
  ['memory.write', 'write'],
  ['schema.export', 'write'],
  ['sql.render', 'write'],
  ['flow.validate', 'write'],
  ['design.replicate', 'write'],
  ['image.generate', 'write'],
  ['finetune.submit', 'write'],
  ['worktree.create', 'write'],
  ['worktree.remove', 'write'],
  ['git.commit', 'write'],
  // Apagar gatilho é escrita, não rede; criar continua em network logo abaixo,
  // porque o que nasce ali vai rodar sozinho e falar com o provedor.
  ['schedule.remove', 'write'],

  // Roda processo com o token de quem está logado. `term.open` fica na tabela
  // mesmo fora do catálogo: esta tabela é o julgamento do RISCO, não o registro
  // do que existe — apagá-la faria a ferramenta voltar um dia sem portão.
  ['proc.run', 'execute'],
  ['term.open', 'execute'],
  ['diagnostics.run', 'execute'],
  ['task.dispatch', 'execute'],
  ['task.gate', 'execute'],

  // Sai para fora da estação.
  ['webhook.post', 'network'],
  ['mcp.call', 'network'],
  ['osv.query', 'network'],
  ['schedule.create', 'network'],

  // Toca segredo.
  ['secrets.scan', 'secret'],
])

/**
 * Classifica a ferramenta. Ferramenta que a tabela não conhece é tratada como
 * execute — o mais restritivo — de propósito: ferramenta nova (ou vinda de
 * servidor MCP externo) não pode nascer liberada só porque ninguém lembrou de
 * classificá-la aqui.
 */
export function riskOf(tool: string): Risk {
  return RISK_BY_TOOL.get(tool.trim().toLowerCase()) ?? 'execute'
}

/** Diz se a tabela conhece a ferramenta — é o gatilho do fail-closed do modo "all". */
export function riskTableKnows(tool: string): boolean {
  return RISK_BY_TOOL.has(tool.trim().toLowerCase())
}

/* --------------------------------- digest --------------------------------- */

/**
 * O digest que prende um "aprovar sempre" ao pedido EXATO. Carrega o ESCOPO
 * (projeto+especialista), e não só ferramenta+argumentos: com digest de
 * tool+args puro, aprovar `fs.write` em `deploy/ci.yml` olhando o `code` no
 * repositório A liberava o MESMO caminho relativo no repositório B, e liberava
 * também o `design`, que tem `fs.write` no catálogo.
 *
 * sha256[:8] em hexadecimal (16 caracteres) — a MESMA forma do digestOf do
 * oráculo, que as fixtures gravaram.
 */
export function digestOf(scope: string, tool: string, args: string): string {
  return createHash('sha256')
    .update(scope + '\x00' + tool + '\x00', 'utf8')
    .update(args, 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/**
 * O par (projeto, especialista) a que uma concessão fica presa. Sessão sem
 * raiz cai numa marca fixa em vez de string vazia: duas sessões sem projeto
 * compartilham o escopo entre si, mas nenhuma empresta a concessão para uma
 * sessão que TEM projeto.
 */
export function approvalScope(cwd: string | undefined, specialistID: string): string {
  const root = cwd?.trim() || 'sem-projeto'
  return root + '\x00' + specialistID
}
