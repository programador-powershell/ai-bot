/**
 * A Cápsula de Estado do Context Runtime: JANELA DO MODELO != MEMÓRIA DO AGENTE.
 *
 * Porte do `internal/contextrt/capsule.go` do oráculo Go (forma e invariantes;
 * clean-room). O histórico integral vive no event log e nunca é requisito para
 * continuar a conversa; o que o modelo recebe é o working set: instruções +
 * ESTA cápsula + a cauda recente verbatim. Antes dela, tudo além da janela
 * recente simplesmente SUMIA do contexto.
 *
 * A dobra é DETERMINÍSTICA e incremental de propósito: uma passada sobre os
 * envelopes novos desde o cursor, sem chamada de modelo — custo zero,
 * disponibilidade sem provedor e validade (uma dobra só reorganiza o que
 * aconteceu; resumo de modelo pode inventar). O polimento por modelo pode
 * entrar depois COMO REFINO — e é para esse dia que a validação em duas
 * passadas (auditCandidate) já existe: nenhuma cápsula VÁLIDA é trocada por um
 * resumo que perdeu estado crítico.
 *
 * Extensões do E6 sobre o oráculo (a spec da migração pede o que o Go ainda
 * não tinha): `constraints` (restrições declaradas, irrevogáveis por dobra),
 * `nextAction` (o próximo passo derivado dos eventos) e a marca
 * `irreversible` nas decisões — os três entram na lista de estado crítico que
 * a validação protege.
 */

import type { Envelope, Kind } from '@aibot2/domain-events'

/* --------------------------------- tetos ---------------------------------- */

// Os tetos de cada lista. A cápsula é working set, não arquivo: o que passar
// do teto cai — o integral continua no log, recuperável. Valores idênticos aos
// do oráculo; maxConstraints é extensão E6.
export const MAX_DECISIONS = 12
export const MAX_FILES = 24
export const MAX_ERRORS = 8
export const MAX_PENDING = 6
export const MAX_ARTIFACTS = 10
export const MAX_CONSTRAINTS = 8
/** Limita cada texto individual da cápsula. */
export const MAX_FIELD_CHARS = 240
/** Pares que nunca fecharam não podem crescer para sempre. */
export const MAX_OPEN_CALLS = 64

export const CAPSULE_VERSION = 1

/* --------------------------------- tipos ---------------------------------- */

/** Uma escolha que moldou a sessão — rota, delegação, entrega. */
export interface Decision {
  decision: string
  reason?: string
  /**
   * Extensão E6: decisão IRREVERSÍVEL (deploy feito, arquivo apagado, dado
   * migrado) nunca pode sumir numa troca de cápsula — o trim a preserva e a
   * validação a exige no candidato.
   */
  irreversible?: boolean
}

/** Um arquivo tocado e como. */
export interface FileNote {
  path: string
  status: 'read' | 'modified'
}

/** Um erro e o estado dele. */
export interface ErrorNote {
  symptom: string
  status: 'open' | 'resolved'
  /**
   * Quem falhou, para o sucesso posterior da MESMA ferramenta marcar o erro
   * como resolvido — "deu erro, corrigiu, rodou de novo" vira estado.
   */
  tool?: string
}

/** Uma saída integral guardada fora da janela. */
export interface ArtifactNote {
  ref: string
  description: string
}

/**
 * As três contagens que a especificação manda nunca confundir: o ATIVO na
 * janela é medido por chamada (Budget Manager); aqui ficam o CUMULATIVO da
 * sessão e o tamanho da memória externa.
 */
export interface Telemetry {
  /** Total de conteúdo dobrado — caracteres, não tokens: a contagem crua não mente. */
  cumulativeChars: number
  /** Quantos envelopes a dobra já processou. */
  events: number
  /** Quantas dobras já rodaram (a "compaction count" da spec). */
  folds: number
}

/** A forma serializada da cápsula (o que viaja no checkpoint). */
export interface CapsuleData {
  version: number
  goal: string
  constraints?: string[]
  decisions?: Decision[]
  files?: FileNote[]
  errors?: ErrorNote[]
  artifacts?: ArtifactNote[]
  pending?: string[]
  currentWork?: string
  nextAction?: string
  /** Seq do último envelope dobrado: a próxima dobra começa dele. */
  cursor: number
  telemetry: Telemetry
  /** Casa tool.call com tool.result entre dobras (um call pode fechar na seguinte). */
  openCalls?: Record<string, string>
}

/* -------------------------------- cápsula --------------------------------- */

/**
 * O estado operacional mínimo para continuar a sessão — o que um agente
 * sucessor precisaria para retomar exatamente daqui.
 */
export class Capsule {
  version = CAPSULE_VERSION
  goal = ''
  constraints: string[] = []
  decisions: Decision[] = []
  files: FileNote[] = []
  errors: ErrorNote[] = []
  artifacts: ArtifactNote[] = []
  pending: string[] = []
  currentWork = ''
  nextAction = ''
  cursor = 0
  telemetry: Telemetry = { cumulativeChars: 0, events: 0, folds: 0 }
  openCalls: Record<string, string> = {}

  /**
   * Desserializa; vazio ou ilegível devolve uma NOVA — cápsula corrompida não
   * pode derrubar o turno, ela se refaz sozinha nas dobras seguintes (o log é
   * a fonte). Mesmo contrato do Load do oráculo.
   */
  static load(data: string | undefined | null): Capsule {
    const capsule = new Capsule()
    if (data === undefined || data === null || data === '') return capsule
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return new Capsule()
    }
    return Capsule.fromData(parsed)
  }

  /** Reidrata de um objeto já parseado (o caminho do checkpoint). Tolerante. */
  static fromData(parsed: unknown): Capsule {
    const capsule = new Capsule()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return capsule
    const raw = parsed as Partial<CapsuleData>
    if (typeof raw.goal === 'string') capsule.goal = raw.goal
    if (Array.isArray(raw.constraints)) {
      capsule.constraints = raw.constraints.filter((item): item is string => typeof item === 'string')
    }
    if (Array.isArray(raw.decisions)) capsule.decisions = raw.decisions.filter(isDecision)
    if (Array.isArray(raw.files)) capsule.files = raw.files.filter(isFileNote)
    if (Array.isArray(raw.errors)) capsule.errors = raw.errors.filter(isErrorNote)
    if (Array.isArray(raw.artifacts)) capsule.artifacts = raw.artifacts.filter(isArtifactNote)
    if (Array.isArray(raw.pending)) {
      capsule.pending = raw.pending.filter((item): item is string => typeof item === 'string')
    }
    if (typeof raw.currentWork === 'string') capsule.currentWork = raw.currentWork
    if (typeof raw.nextAction === 'string') capsule.nextAction = raw.nextAction
    if (typeof raw.cursor === 'number' && raw.cursor >= 0) capsule.cursor = raw.cursor
    const telemetry = raw.telemetry
    if (telemetry !== null && typeof telemetry === 'object') {
      capsule.telemetry = {
        cumulativeChars: asNonNegative((telemetry as Telemetry).cumulativeChars),
        events: asNonNegative((telemetry as Telemetry).events),
        folds: asNonNegative((telemetry as Telemetry).folds),
      }
    }
    if (raw.openCalls !== null && typeof raw.openCalls === 'object' && !Array.isArray(raw.openCalls)) {
      for (const [key, value] of Object.entries(raw.openCalls as Record<string, unknown>)) {
        if (typeof value === 'string') capsule.openCalls[key] = value
      }
    }
    return capsule
  }

  /** Serializa para o checkpoint. */
  marshal(): string {
    return JSON.stringify(this.toData())
  }

  toData(): CapsuleData {
    const data: CapsuleData = {
      version: this.version,
      goal: this.goal,
      cursor: this.cursor,
      telemetry: { ...this.telemetry },
    }
    if (this.constraints.length > 0) data.constraints = [...this.constraints]
    if (this.decisions.length > 0) data.decisions = this.decisions.map((item) => ({ ...item }))
    if (this.files.length > 0) data.files = this.files.map((item) => ({ ...item }))
    if (this.errors.length > 0) data.errors = this.errors.map((item) => ({ ...item }))
    if (this.artifacts.length > 0) data.artifacts = this.artifacts.map((item) => ({ ...item }))
    if (this.pending.length > 0) data.pending = [...this.pending]
    if (this.currentWork !== '') data.currentWork = this.currentWork
    if (this.nextAction !== '') data.nextAction = this.nextAction
    if (Object.keys(this.openCalls).length > 0) data.openCalls = { ...this.openCalls }
    return data
  }

  /**
   * Cópia profunda pelo MESMO caminho da serialização (marshal→load): a
   * passada de EXTRAÇÃO da dobra validada trabalha sobre o clone, e clonar por
   * outro caminho deixaria a validação provar uma cápsula que nunca existiria
   * em disco.
   */
  clone(): Capsule {
    return Capsule.load(this.marshal())
  }

  /* ---------------------------------- dobra --------------------------------- */

  /**
   * Incorpora envelopes novos ao estado. Uma passada, sem modelo, sem relógio;
   * chamada ao fim de cada turno (o done é o fim de fase natural de uma
   * conversa — a compactação POR FASE da spec). Idempotente por cursor.
   */
  fold(envelopes: readonly Envelope[]): void {
    if (envelopes.length === 0) return
    this.telemetry.folds++
    for (const envelope of envelopes) {
      if (envelope.seq !== 0 && envelope.seq <= this.cursor) {
        continue // já dobrado — a dobra é idempotente por cursor
      }
      this.telemetry.events++
      // Caracteres do payload SERIALIZADO: o análogo do len(envelope.Payload)
      // do Go (lá o payload era o JSON cru; aqui ele chega decodificado).
      this.telemetry.cumulativeChars += payloadChars(envelope.payload)
      this.#foldOne(envelope)
      if (envelope.seq > this.cursor) this.cursor = envelope.seq
    }
    this.#trim()
  }

  #foldOne(envelope: Envelope): void {
    const payload = envelope.payload as Record<string, unknown> | undefined
    switch (envelope.kind) {
      case 'message': {
        const text = typeof payload?.['text'] === 'string' ? (payload['text'] as string) : ''
        if (text.trim() === '') return
        if (payload?.['role'] === 'user') {
          const clipped = clip(text)
          if (this.goal === '') this.goal = clipped
          this.currentWork = clipped
          this.nextAction = 'atender: ' + clipped
          // Mensagem nova responde/substitui o que estava pendente.
          this.pending = []
        }
        return
      }

      case 'route': {
        const specialist = typeof payload?.['specialist'] === 'string' ? (payload['specialist'] as string) : ''
        if (specialist === '') return
        const last = this.decisions.length > 0 ? this.decisions[this.decisions.length - 1]!.decision : ''
        const decision = 'a conversa está com o especialista ' + specialist
        if (decision !== last) {
          const entry: Decision = { decision }
          const reason = typeof payload?.['reason'] === 'string' ? (payload['reason'] as string) : ''
          if (reason !== '') entry.reason = reason
          this.decisions.push(entry)
        }
        return
      }

      case 'delegate': {
        const to = typeof payload?.['to'] === 'string' ? (payload['to'] as string) : ''
        if (to === '') return
        if (payload?.['done'] !== true) {
          const goal = typeof payload?.['goal'] === 'string' ? (payload['goal'] as string) : ''
          this.decisions.push({ decision: 'delegou a ' + to + ': ' + clip(goal) })
          return
        }
        const result = typeof payload?.['result'] === 'string' ? (payload['result'] as string) : ''
        if (result.trim() !== '') {
          this.decisions.push({ decision: to + ' entregou: ' + clip(result) })
        }
        return
      }

      case 'tool.call': {
        const tool = typeof payload?.['tool'] === 'string' ? (payload['tool'] as string) : ''
        if (tool === '') return
        const callId = typeof payload?.['callId'] === 'string' ? (payload['callId'] as string) : ''
        this.openCalls[callId] = tool
        this.nextAction = 'aguardar o resultado de ' + tool
        const path = pathOf(payload?.['args'])
        if (path !== '') {
          let status: FileNote['status']
          switch (tool) {
            case 'fs.write':
            case 'fs.patch':
              status = 'modified'
              break
            case 'fs.read':
            case 'fs.search':
            case 'fs.list':
              status = 'read'
              break
            default:
              return
          }
          this.#noteFile(path, status)
        }
        return
      }

      case 'tool.result': {
        const tool = typeof payload?.['tool'] === 'string' ? (payload['tool'] as string) : ''
        if (tool === '') return
        const callId = typeof payload?.['callId'] === 'string' ? (payload['callId'] as string) : ''
        delete this.openCalls[callId]
        if (payload?.['ok'] !== true) {
          const failure = typeof payload?.['error'] === 'string' ? (payload['error'] as string) : ''
          this.#noteError(tool, failure)
          this.nextAction = 'corrigir o erro de ' + tool
          return
        }
        // Sucesso da MESMA ferramenta resolve o erro aberto dela.
        for (const failure of this.errors) {
          if (failure.tool === tool && failure.status === 'open') failure.status = 'resolved'
        }
        const ref = typeof payload?.['artifactRef'] === 'string' ? (payload['artifactRef'] as string) : ''
        if (ref !== '') this.#noteArtifact(ref, 'saída integral de ' + tool)
        if (Object.keys(this.openCalls).length === 0) {
          this.nextAction = 'continuar com o resultado de ' + tool
        }
        return
      }

      case 'error': {
        const message = typeof payload?.['message'] === 'string' ? (payload['message'] as string) : ''
        if (message === '') return
        const code = typeof payload?.['code'] === 'string' ? (payload['code'] as string) : ''
        this.#noteError(code, message)
        return
      }

      case 'ask': {
        const question = typeof payload?.['question'] === 'string' ? (payload['question'] as string) : ''
        if (question === '') return
        this.pending.push(clip(question))
        this.nextAction = 'aguardar resposta humana'
        return
      }

      case 'reply': {
        // A resposta fecha o que estava pendente; a continuação repõe se
        // voltar a perguntar.
        this.pending = []
        this.nextAction = 'continuar com a resposta recebida'
        return
      }

      case 'done': {
        // Extensão E6 (o oráculo não dobrava done): turno concluído zera o
        // próximo passo — é o que permite à validação aceitar um candidato que
        // limpou nextAction LEGITIMAMENTE.
        this.nextAction = ''
        return
      }

      default:
        return
    }
  }

  /** Declara uma restrição de fora da dobra (config do agente, spec do dono). */
  addConstraint(constraint: string): void {
    const clipped = clip(constraint)
    if (clipped === '' || this.constraints.includes(clipped)) return
    this.constraints.push(clipped)
    if (this.constraints.length > MAX_CONSTRAINTS) {
      // Diferente das outras listas, restrição NÃO cai calada: o excedente é
      // recusado — restrição que some deixa o agente violá-la sem saber.
      this.constraints.pop()
      throw new Error(`cápsula: teto de ${MAX_CONSTRAINTS} restrições atingido — consolide antes de acrescentar`)
    }
  }

  #noteFile(path: string, status: FileNote['status']): void {
    for (const file of this.files) {
      if (file.path === path) {
        // modified vence read: uma leitura posterior não desfaz a edição.
        if (status === 'modified') file.status = status
        return
      }
    }
    this.files.push({ path: clip(path), status })
  }

  #noteError(tool: string, message: string): void {
    const symptom = clip(tool + ': ' + message)
    for (const failure of this.errors) {
      if (failure.symptom === symptom) {
        failure.status = 'open'
        return
      }
    }
    this.errors.push({ symptom, status: 'open', tool })
  }

  #noteArtifact(ref: string, description: string): void {
    for (const artifact of this.artifacts) {
      if (artifact.ref === ref) return
    }
    this.artifacts.push({ ref, description: clip(description) })
  }

  /**
   * Aplica os tetos, sempre descartando o MAIS ANTIGO: o estado recente é o
   * que o próximo turno precisa; o antigo continua no log. Decisão
   * IRREVERSÍVEL fura a regra do mais antigo: ela nunca cai enquanto houver
   * decisão reversível para cair no lugar.
   */
  #trim(): void {
    if (this.decisions.length > MAX_DECISIONS) {
      const irreversible = this.decisions.filter((item) => item.irreversible === true)
      const reversible = this.decisions.filter((item) => item.irreversible !== true)
      const room = MAX_DECISIONS - irreversible.length
      const kept = room > 0 ? reversible.slice(-room) : []
      // Reordena por chegada aproximada: irreversíveis primeiro (são as mais
      // antigas por construção), depois a cauda das reversíveis.
      this.decisions = [...irreversible, ...kept].slice(-Math.max(MAX_DECISIONS, irreversible.length))
    }
    if (this.files.length > MAX_FILES) this.files = this.files.slice(-MAX_FILES)
    if (this.errors.length > MAX_ERRORS) this.errors = this.errors.slice(-MAX_ERRORS)
    if (this.pending.length > MAX_PENDING) this.pending = this.pending.slice(-MAX_PENDING)
    if (this.artifacts.length > MAX_ARTIFACTS) this.artifacts = this.artifacts.slice(-MAX_ARTIFACTS)
    if (Object.keys(this.openCalls).length > MAX_OPEN_CALLS) this.openCalls = {}
  }

  /* --------------------------------- render --------------------------------- */

  /**
   * A mensagem de sistema que entra no prompt. Compacta e ESTRUTURADA: o
   * modelo lê estado, não narrativa. Vazia quando não há nada dobrado —
   * cápsula sem conteúdo não gasta janela.
   */
  render(): string {
    if (this.cursor === 0 && this.constraints.length === 0) return ''
    const out: string[] = []
    out.push(
      'ESTADO DA SESSÃO (destilado do histórico antigo; o integral vive no log e nos artefatos — ' +
        'use context.fetch para recuperar uma saída completa):',
    )
    if (this.goal !== '') out.push('Objetivo: ' + this.goal)
    if (this.constraints.length > 0) {
      out.push('Restrições (NUNCA violar):')
      for (const constraint of this.constraints) out.push('- ' + constraint)
    }
    if (this.currentWork !== '' && this.currentWork !== this.goal) {
      out.push('Trabalho atual: ' + this.currentWork)
    }
    if (this.nextAction !== '') out.push('Próxima ação: ' + this.nextAction)
    if (this.decisions.length > 0) {
      out.push('Decisões:')
      for (const decision of this.decisions) {
        let line = '- ' + decision.decision
        if (decision.reason !== undefined && decision.reason !== '') line += ` (${decision.reason})`
        if (decision.irreversible === true) line += ' [irreversível]'
        out.push(line)
      }
    }
    if (this.files.length > 0) {
      out.push('Arquivos tocados:')
      for (const file of this.files) out.push(`- ${file.path} (${file.status})`)
    }
    const open = this.errors.filter((failure) => failure.status === 'open')
    if (open.length > 0) {
      out.push('Erros AINDA ABERTOS:')
      for (const failure of open) out.push('- ' + failure.symptom)
    }
    if (this.artifacts.length > 0) {
      out.push('Saídas integrais guardadas:')
      for (const artifact of this.artifacts) out.push(`- ${artifact.ref} — ${artifact.description}`)
    }
    if (this.pending.length > 0) {
      out.push('Pendente de resposta humana:')
      for (const pending of this.pending) out.push('- ' + pending)
    }
    out.push(
      `(memória externa: ${this.telemetry.events} eventos, ` +
        `${Math.floor(this.telemetry.cumulativeChars / 1024)} KB dobrados em ${this.telemetry.folds} dobras)`,
    )
    return out.join('\n') + '\n'
  }
}

/* --------------------------- validação (2ª passada) ------------------------ */

/** O laudo da validação: o que o candidato PERDEU em relação à cápsula atual. */
export interface CapsuleAudit {
  ok: boolean
  /** Cada perda nomeada — o diagnóstico de por que o candidato foi recusado. */
  losses: string[]
}

/**
 * A segunda passada da dobra validada: confere se o candidato PRESERVA o
 * estado crítico da cápsula atual — goal, restrições, pendências, trabalho
 * corrente/próxima ação, erros abertos, artefatos necessários e decisões
 * irreversíveis. `foldedKinds` são os verbos que a extração processou: eles
 * autorizam as limpezas LEGÍTIMAS (reply/mensagem nova fecham pendências;
 * done zera nextAction) — sem essa lista, toda transição normal reprovaria.
 *
 * Nunca trocar cápsula válida por resumo que perdeu estado crítico: quem
 * chama (foldValidated / um refino por modelo no futuro) descarta o candidato
 * reprovado e FICA com a anterior.
 */
export function auditCandidate(
  previous: Capsule,
  candidate: Capsule,
  foldedKinds: ReadonlySet<Kind> = new Set(),
): CapsuleAudit {
  const losses: string[] = []
  if (candidate.version !== CAPSULE_VERSION) {
    losses.push(`versão desconhecida: ${candidate.version}`)
  }
  if (candidate.cursor < previous.cursor) {
    losses.push(`cursor regrediu: ${previous.cursor} → ${candidate.cursor}`)
  }
  if (previous.goal !== '' && candidate.goal === '') {
    losses.push('objetivo perdido')
  }
  for (const constraint of previous.constraints) {
    if (!candidate.constraints.includes(constraint)) {
      losses.push(`restrição perdida: ${constraint}`)
    }
  }
  // Pendências só somem legitimamente quando algo as fechou: resposta ou
  // mensagem nova da pessoa (o mesmo par que a dobra usa para limpá-las).
  const pendingMayClear = foldedKinds.has('reply') || foldedKinds.has('message')
  if (!pendingMayClear) {
    for (const pending of previous.pending) {
      if (!candidate.pending.includes(pending)) {
        losses.push(`pendência perdida: ${pending}`)
      }
    }
  }
  if (previous.currentWork !== '' && candidate.currentWork === '') {
    losses.push('trabalho atual perdido')
  }
  const nextActionMayClear = foldedKinds.has('done')
  if (previous.nextAction !== '' && candidate.nextAction === '' && !nextActionMayClear) {
    losses.push('próxima ação perdida')
  }
  // Erro ABERTO tem de continuar presente (aberto ou resolvido por evento);
  // o teto da lista é a única saída legítima sem rastro.
  if (candidate.errors.length < MAX_ERRORS) {
    for (const failure of previous.errors) {
      if (failure.status !== 'open') continue
      if (!candidate.errors.some((item) => item.symptom === failure.symptom)) {
        losses.push(`erro aberto perdido: ${failure.symptom}`)
      }
    }
  }
  if (candidate.artifacts.length < MAX_ARTIFACTS) {
    for (const artifact of previous.artifacts) {
      if (!candidate.artifacts.some((item) => item.ref === artifact.ref)) {
        losses.push(`artefato perdido: ${artifact.ref}`)
      }
    }
  }
  for (const decision of previous.decisions) {
    if (decision.irreversible !== true) continue
    if (!candidate.decisions.some((item) => item.decision === decision.decision)) {
      losses.push(`decisão irreversível perdida: ${decision.decision}`)
    }
  }
  return { ok: losses.length === 0, losses }
}

/** O desfecho da dobra em duas passadas. */
export interface ValidatedFold {
  /** A cápsula que VALE daqui em diante (a candidata ou a anterior intacta). */
  capsule: Capsule
  /** true = a candidata passou na validação e substituiu a anterior. */
  adopted: boolean
  /** As perdas que reprovaram a candidata (vazio quando adotada). */
  losses: string[]
}

/**
 * A dobra em DUAS passadas da spec: (1) EXTRAÇÃO — a candidata nasce como
 * clone da cápsula atual e dobra os envelopes novos; (2) VALIDAÇÃO/FIT — a
 * candidata só substitui a atual se preservou o estado crítico. A dobra
 * determinística passa por construção; a passada existe como CERCA para o dia
 * em que um refino por modelo (ou um bug) produzir uma candidata que perdeu
 * estado — a cápsula anterior, válida, fica.
 */
export function foldValidated(previous: Capsule, envelopes: readonly Envelope[]): ValidatedFold {
  const candidate = previous.clone()
  candidate.fold(envelopes)
  const kinds = new Set<Kind>()
  for (const envelope of envelopes) {
    if (envelope.seq === 0 || envelope.seq > previous.cursor) kinds.add(envelope.kind)
  }
  const audit = auditCandidate(previous, candidate, kinds)
  if (!audit.ok) {
    return { capsule: previous, adopted: false, losses: audit.losses }
  }
  return { capsule: candidate, adopted: true, losses: [] }
}

/* --------------------------------- apoio ---------------------------------- */

/**
 * Normaliza espaços e corta no teto SEM partir caractere: o corte é por code
 * point (o análogo do laço de runa do Go — aqui não há compat byte-a-byte em
 * jogo: a cápsula é estado interno, não fixture).
 */
export function clip(text: string): string {
  const flat = text.split(/\s+/u).filter((word) => word !== '').join(' ')
  if (flat.length <= MAX_FIELD_CHARS) return flat
  const points = [...flat]
  if (points.length <= MAX_FIELD_CHARS) return flat
  return points.slice(0, MAX_FIELD_CHARS).join('') + '…'
}

/** Extrai o `path` dos argumentos de uma ferramenta de arquivo. */
function pathOf(args: unknown): string {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
  const path = (args as Record<string, unknown>)['path']
  return typeof path === 'string' ? path.trim() : ''
}

function payloadChars(payload: unknown): number {
  if (payload === undefined || payload === null) return 0
  try {
    return JSON.stringify(payload)?.length ?? 0
  } catch {
    return 0
  }
}

function asNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isDecision(value: unknown): value is Decision {
  return value !== null && typeof value === 'object' && typeof (value as Decision).decision === 'string'
}

function isFileNote(value: unknown): value is FileNote {
  const note = value as FileNote
  return (
    value !== null && typeof value === 'object' &&
    typeof note.path === 'string' && (note.status === 'read' || note.status === 'modified')
  )
}

function isErrorNote(value: unknown): value is ErrorNote {
  const note = value as ErrorNote
  return (
    value !== null && typeof value === 'object' &&
    typeof note.symptom === 'string' && (note.status === 'open' || note.status === 'resolved')
  )
}

function isArtifactNote(value: unknown): value is ArtifactNote {
  const note = value as ArtifactNote
  return (
    value !== null && typeof value === 'object' &&
    typeof note.ref === 'string' && typeof note.description === 'string'
  )
}
