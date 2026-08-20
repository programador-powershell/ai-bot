/**
 * O provider concreto do seam OrchestratorModel: Needle Pro como serviço HTTP
 * residente em LOOPBACK (D4 do m1-plano). Ele atende múltiplas sessões — não
 * se carrega uma cópia por usuário/bot/tarefa — e a regra de indisponível é
 * uma só: DEGRADA, nunca derruba. `ready()` falso faz a cascata pular o
 * degrau; nenhum erro daqui vira erro ao usuário e nenhuma sonda roda no
 * construtor (boot não depende de o serviço estar de pé).
 *
 * Zero dependências: fetch nativo do Node 24 e AbortSignal.timeout. As
 * chamadas HTTP moram TODAS aqui — "não espalhar chamadas HTTP pelo domínio"
 * (spec §9); o adapter é substituível pelo kernel.
 */

import type {
  ModelHealth,
  OrchestratorModel,
  OrchestratorQuery,
  RouteQuery,
  RouteVerdict,
} from '@aibot2/needle-orchestrator'

/** Config externa do adapter — a forma da spec §9. */
export interface NeedleHttpConfig {
  /** Ex.: http://127.0.0.1:8788 — loopback OBRIGATÓRIO (validado). */
  baseUrl: string
  /** Ex.: needle-pro. Viaja em toda chamada. */
  model: string
  timeoutMs: number
  /**
   * Teto de chamadas simultâneas ao serviço. O modelo local é um processo só
   * nesta máquina: despejar N pedidos nele não os acelera, só os engarrafa —
   * o excedente espera numa fila FIFO aqui dentro.
   */
  maxConcurrentRequests: number
  /** Pede saída estruturada (gramática) ao serviço no /orchestrate. */
  structuredOutput: boolean
}

/** O serviço não respondeu/não está de pé — a cascata trata como degradação. */
export class NeedleUnavailableError extends Error {
  constructor(detail: string) {
    super(`needle indisponível: ${detail}`)
    this.name = 'NeedleUnavailableError'
  }
}

/** O serviço respondeu algo fora do protocolo — também degrada, com log melhor. */
export class NeedleProtocolError extends Error {
  constructor(detail: string) {
    super(`resposta fora do protocolo do needle: ${detail}`)
    this.name = 'NeedleProtocolError'
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]'])

function assertLoopback(baseUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`[provider-needle] baseUrl inválida: ${JSON.stringify(baseUrl)}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(host) && !host.startsWith('127.')) {
    // O Needle é o processo que lê TODO prompt do primeiro input. Apontá-lo
    // para fora da máquina por um erro de config mandaria o texto das pessoas
    // pela rede em silêncio — melhor recusar a montagem com o motivo.
    throw new Error(
      `[provider-needle] baseUrl ${JSON.stringify(baseUrl)} não é loopback — o degrau local roda NA máquina (D4)`,
    )
  }
  return parsed
}

export class NeedleHttpModel implements OrchestratorModel {
  private readonly base: string
  private readonly config: NeedleHttpConfig
  /**
   * Saúde CONHECIDA, não sondada a cada pergunta: ready() é síncrono porque a
   * cascata o consulta no caminho quente. Nasce falso (o boot não espera o
   * serviço), vira verdadeiro na primeira sonda boa e volta a falso na
   * primeira falha — a chamada que falhou já degradou o turno dela via erro,
   * e as próximas nem tentam até alguém sondar de novo.
   */
  private healthy = false
  private inFlight = 0
  private readonly waiting: (() => void)[] = []

  constructor(config: NeedleHttpConfig) {
    assertLoopback(config.baseUrl)
    if (config.timeoutMs <= 0) {
      throw new Error('[provider-needle] timeoutMs precisa ser > 0 — sem timeout, um serviço travado prende o turno')
    }
    if (config.maxConcurrentRequests <= 0) {
      throw new Error('[provider-needle] maxConcurrentRequests precisa ser > 0')
    }
    this.config = config
    this.base = config.baseUrl.replace(/\/+$/, '')
  }

  /**
   * Sonda inicial — chamada pela montagem, NUNCA derruba o boot: qualquer
   * falha vira ready() falso e a cascata segue sem o degrau.
   */
  async start(): Promise<void> {
    await this.health()
  }

  ready(): boolean {
    return this.healthy
  }

  /** Sonda o serviço. Não lança: saúde é resposta, não exceção. */
  async health(): Promise<ModelHealth> {
    try {
      const response = await fetch(`${this.base}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
      if (!response.ok) {
        this.healthy = false
        return { ok: false, detail: `HTTP ${response.status}` }
      }
      this.healthy = true
      return { ok: true }
    } catch (error) {
      this.healthy = false
      return { ok: false, detail: (error as Error).message }
    }
  }

  async route(query: RouteQuery): Promise<RouteVerdict> {
    const raw = await this.post('/route', {
      model: this.config.model,
      prompt: query.prompt,
      intent: query.intent,
      // Só o que o modelo precisa para decidir — id e o texto de apresentação.
      // Prompt de sistema e ferramentas do especialista não viajam: o modelo
      // escolhe ENTRE candidatos, não os executa.
      candidates: query.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        tagline: candidate.tagline,
      })),
    })
    if (
      typeof raw !== 'object' || raw === null ||
      typeof (raw as Record<string, unknown>).specialist !== 'string' ||
      typeof (raw as Record<string, unknown>).confidence !== 'number'
    ) {
      throw new NeedleProtocolError(`veredito de rota malformado: ${JSON.stringify(raw)?.slice(0, 200)}`)
    }
    const verdict = raw as { specialist: string; confidence: number; why?: unknown }
    return {
      specialist: verdict.specialist,
      confidence: verdict.confidence,
      ...(typeof verdict.why === 'string' ? { why: verdict.why } : {}),
    }
  }

  /**
   * Devolve a saída CRUA (unknown): validar o contrato OrchestratorDecision é
   * do plugin needle-orchestrator — processo local não ganha crédito de
   * confiança só por ser local.
   */
  async orchestrate(query: OrchestratorQuery): Promise<unknown> {
    return this.post('/orchestrate', {
      model: this.config.model,
      structuredOutput: this.config.structuredOutput,
      goal: query.goal,
      stateCapsule: query.stateCapsule ?? null,
      taskBoard: query.taskBoard ?? null,
      specialists: query.specialists,
    })
  }

  /* ------------------------------ interno -------------------------------- */

  private async post(path: string, body: unknown): Promise<unknown> {
    await this.acquire()
    try {
      let response: Response
      try {
        response = await fetch(`${this.base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        })
      } catch (error) {
        // Rede/timeout: o serviço não está de pé PARA NÓS — degrada até a
        // próxima sonda de saúde.
        this.healthy = false
        throw new NeedleUnavailableError((error as Error).message)
      }
      if (!response.ok) {
        this.healthy = false
        throw new NeedleUnavailableError(`HTTP ${response.status} em ${path}`)
      }
      try {
        return await response.json()
      } catch (error) {
        throw new NeedleProtocolError(`corpo não é JSON: ${(error as Error).message}`)
      }
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.config.maxConcurrentRequests) {
      this.inFlight++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.inFlight++
        resolve()
      })
    })
  }

  private release(): void {
    this.inFlight--
    const next = this.waiting.shift()
    if (next !== undefined) next()
  }
}
