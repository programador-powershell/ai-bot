/**
 * O contrato ESTRUTURADO da orquestradora (spec §7): schema FECHADO, enums
 * fechados, especialista validado contra o registro, ciclo detectado.
 *
 * A validação é dura porque a saída de um modelo é entrada não confiável:
 * "LLM não decide autoridade física só por emitir um campo" — o que passa
 * daqui é DECISÃO tipada; o que não passa vira retry/fallback controlado no
 * chamador, nunca propaga cru. E, como no overlay, os problemas vêm TODOS
 * juntos: quem depura a saída de um modelo não pode descobrir um erro por
 * tentativa.
 */

export const DECISION_MODES = [
  'direct',
  'delegate',
  'plan',
  'continue',
  'replan',
  'ask_owner',
  'finish',
] as const

export type DecisionMode = (typeof DECISION_MODES)[number]

export interface DecisionTask {
  id: string
  title: string
  specialist: string
  objective: string
  dependsOn: string[]
  /**
   * RuntimeRequirements viaja OPACO por aqui: quem o entende é o control
   * plane (domain/runtime) — validar a forma dele neste pacote acoplaria o
   * cérebro à autoridade, que é exatamente o que a spec §6 proíbe.
   */
  requirements: Record<string, unknown>
  permissionsRequested?: string[]
}

export interface DecisionCall {
  specialist: string
  taskId: string
  reason: string
}

export interface OwnerChoice {
  botId: string
  reason: string
}

export interface OwnerRequest {
  reason: string
  expectedAction: string
}

export interface OrchestratorDecision {
  decisionId: string
  mode: DecisionMode
  owner?: OwnerChoice
  tasks?: DecisionTask[]
  calls?: DecisionCall[]
  ownerRequest?: OwnerRequest
  confidence: number
  rationaleSummary?: string
}

export type DecisionVerdict =
  | { ok: true; decision: OrchestratorDecision }
  | { ok: false; problems: string[] }

const TOP_KEYS = new Set(['decisionId', 'mode', 'owner', 'tasks', 'calls', 'ownerRequest', 'confidence', 'rationaleSummary'])
const TASK_KEYS = new Set(['id', 'title', 'specialist', 'objective', 'dependsOn', 'requirements', 'permissionsRequested'])
const CALL_KEYS = new Set(['specialist', 'taskId', 'reason'])
const OWNER_KEYS = new Set(['botId', 'reason'])
const OWNER_REQUEST_KEYS = new Set(['reason', 'expectedAction'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Serializa um valor para o diagnóstico com teto de tamanho. */
function clip(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

function rejectUnknownKeys(
  where: string,
  source: Record<string, unknown>,
  known: ReadonlySet<string>,
  fail: (message: string) => void,
): void {
  // Schema FECHADO: campo desconhecido é recusa, não tolerância. Um modelo
  // que inventa campo está inventando contrato — e contrato inventado passa a
  // ser dependido por alguém em silêncio.
  for (const key of Object.keys(source)) {
    if (!known.has(key)) fail(`${where}: campo desconhecido "${key}" — o schema é fechado`)
  }
}

/**
 * Valida a saída CRUA do modelo contra o contrato. `executorExists` responde
 * pelo registro de especialistas (o master NÃO é executor — quem monta o
 * predicado o exclui).
 */
export function validateDecision(
  raw: unknown,
  executorExists: (id: string) => boolean,
): DecisionVerdict {
  const problems: string[] = []
  const fail = (message: string): void => {
    problems.push(message)
  }

  if (!isRecord(raw)) {
    return { ok: false, problems: ['a decisão não é um objeto JSON'] }
  }

  rejectUnknownKeys('decisão', raw, TOP_KEYS, fail)

  if (typeof raw.decisionId !== 'string' || raw.decisionId.trim() === '') {
    fail('sem `decisionId` — sem ele a decisão não é auditável nem idempotente')
  }

  const mode = raw.mode
  if (typeof mode !== 'string' || !(DECISION_MODES as readonly string[]).includes(mode)) {
    // Enum FECHADO: valor estranho é inválido, nunca "modo mais parecido". A
    // citação é CAPADA: o diagnóstico mostra o que veio, mas saída de modelo
    // não ganha um canal de texto ilimitado dentro da mensagem de erro.
    fail(`\`mode\` ${clip(mode)} fora do conjunto ${DECISION_MODES.join('|')}`)
  }

  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    fail(`\`confidence\` ${clip(raw.confidence)} fora de 0..1`)
  }
  if (raw.rationaleSummary !== undefined && typeof raw.rationaleSummary !== 'string') {
    fail('`rationaleSummary` presente e não é texto')
  }

  if (raw.owner !== undefined) {
    if (!isRecord(raw.owner)) {
      fail('`owner` presente e não é objeto')
    } else {
      rejectUnknownKeys('owner', raw.owner, OWNER_KEYS, fail)
      if (typeof raw.owner.botId !== 'string' || raw.owner.botId.trim() === '') fail('`owner.botId` vazio')
      if (typeof raw.owner.reason !== 'string' || raw.owner.reason.trim() === '') fail('`owner.reason` vazio')
    }
  }

  if (raw.ownerRequest !== undefined) {
    if (!isRecord(raw.ownerRequest)) {
      fail('`ownerRequest` presente e não é objeto')
    } else {
      rejectUnknownKeys('ownerRequest', raw.ownerRequest, OWNER_REQUEST_KEYS, fail)
      if (typeof raw.ownerRequest.reason !== 'string' || raw.ownerRequest.reason.trim() === '') fail('`ownerRequest.reason` vazio')
      if (typeof raw.ownerRequest.expectedAction !== 'string' || raw.ownerRequest.expectedAction.trim() === '') {
        fail('`ownerRequest.expectedAction` vazio — o dono precisa saber o que se espera dele')
      }
    }
  }

  const taskIDs = new Set<string>()
  const dependencies = new Map<string, string[]>()
  if (raw.tasks !== undefined) {
    if (!Array.isArray(raw.tasks)) {
      fail('`tasks` presente e não é lista')
    } else {
      for (const [position, task] of raw.tasks.entries()) {
        const where = `tarefa na posição ${position}`
        if (!isRecord(task)) {
          fail(`${where}: não é objeto`)
          continue
        }
        rejectUnknownKeys(where, task, TASK_KEYS, fail)
        const id = typeof task.id === 'string' ? task.id.trim() : ''
        if (id === '') {
          fail(`${where}: sem \`id\` — dependsOn não teria como apontar para ela`)
        } else if (taskIDs.has(id)) {
          fail(`${where}: \`id\` "${id}" repetido — a segunda esconderia a primeira no board`)
        } else {
          taskIDs.add(id)
        }
        if (typeof task.title !== 'string' || task.title.trim() === '') fail(`${where}: sem \`title\``)
        if (typeof task.objective !== 'string' || task.objective.trim() === '') fail(`${where}: sem \`objective\``)
        if (typeof task.specialist !== 'string' || task.specialist.trim() === '') {
          fail(`${where}: sem \`specialist\``)
        } else if (!executorExists(task.specialist)) {
          fail(`${where}: especialista "${task.specialist}" não existe no registro — o modelo não inventa executor`)
        }
        if (!Array.isArray(task.dependsOn) || task.dependsOn.some((dep) => typeof dep !== 'string')) {
          fail(`${where}: \`dependsOn\` precisa ser lista de ids (vazia quando não depende)`)
        } else if (id !== '') {
          dependencies.set(id, task.dependsOn as string[])
        }
        if (!isRecord(task.requirements)) {
          fail(`${where}: sem \`requirements\` — toda tarefa declara o runtime de que precisa`)
        }
        if (task.permissionsRequested !== undefined &&
          (!Array.isArray(task.permissionsRequested) || task.permissionsRequested.some((p) => typeof p !== 'string'))) {
          fail(`${where}: \`permissionsRequested\` presente e não é lista de textos`)
        }
      }

      // Arestas para id desconhecido e CICLOS — um DAG com ciclo não é um
      // plano, é um laço que o executor nunca termina.
      for (const [id, deps] of dependencies) {
        for (const dep of deps) {
          if (!taskIDs.has(dep)) {
            fail(`tarefa "${id}": dependsOn aponta para "${dep}", que não existe no plano`)
          }
        }
      }
      const cycle = findCycle(dependencies)
      if (cycle !== undefined) {
        fail(`ciclo em dependsOn: ${cycle.join(' -> ')} — plano com ciclo nunca termina`)
      }
    }
  }

  if (raw.calls !== undefined) {
    if (!Array.isArray(raw.calls)) {
      fail('`calls` presente e não é lista')
    } else {
      for (const [position, call] of raw.calls.entries()) {
        const where = `call na posição ${position}`
        if (!isRecord(call)) {
          fail(`${where}: não é objeto`)
          continue
        }
        rejectUnknownKeys(where, call, CALL_KEYS, fail)
        if (typeof call.specialist !== 'string' || !executorExists(call.specialist)) {
          fail(`${where}: especialista ${JSON.stringify(call.specialist)} não existe no registro`)
        }
        if (typeof call.taskId !== 'string' || call.taskId.trim() === '') fail(`${where}: sem \`taskId\``)
        if (typeof call.reason !== 'string' || call.reason.trim() === '') fail(`${where}: sem \`reason\``)
      }
    }
  }

  // Coerência modo × carga: um `plan` sem tarefas ou um `ask_owner` sem
  // pedido seriam decisões que o executor não tem como cumprir.
  if (mode === 'plan' || mode === 'replan') {
    if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
      fail(`modo ${String(mode)} sem \`tasks\` — planejar sem tarefa é não planejar`)
    }
  }
  if (mode === 'delegate') {
    if (!Array.isArray(raw.calls) || raw.calls.length === 0) {
      fail('modo delegate sem `calls` — delegar para ninguém')
    }
  }
  if (mode === 'ask_owner' && raw.ownerRequest === undefined) {
    fail('modo ask_owner sem `ownerRequest` — perguntar sem pergunta')
  }

  if (problems.length > 0) {
    return { ok: false, problems }
  }
  return { ok: true, decision: raw as unknown as OrchestratorDecision }
}

/** Detecta ciclo por DFS com cores; devolve um caminho do ciclo para o erro. */
function findCycle(dependencies: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []

  const visit = (node: string): string[] | undefined => {
    color.set(node, GRAY)
    stack.push(node)
    for (const dep of dependencies.get(node) ?? []) {
      if (!dependencies.has(dep)) continue // id desconhecido já foi reportado
      const state = color.get(dep) ?? WHITE
      if (state === GRAY) {
        return [...stack.slice(stack.indexOf(dep)), dep]
      }
      if (state === WHITE) {
        const found = visit(dep)
        if (found !== undefined) return found
      }
    }
    stack.pop()
    color.set(node, BLACK)
    return undefined
  }

  for (const node of dependencies.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node)
      if (found !== undefined) return found
    }
  }
  return undefined
}
