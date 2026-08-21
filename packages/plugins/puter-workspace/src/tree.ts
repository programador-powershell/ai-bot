/**
 * A árvore da conta no Puter (spec §23), como DADO — os endereços e o
 * provisionamento, sem tocar em disco ou rede (isso é do backend). Uma conta =
 * uma pessoa; a raiz da conta tem três galhos:
 *
 *   /Bots/<ofício>/            memória e config do bot (o bot É o ofício)
 *   /Goals/<id>/               um objetivo, COMPARTILHADO entre os bots:
 *       workspace/               o projeto (fonte de verdade viva)
 *       artifacts/               o resultado PROMOVIDO (durável)
 *       staging/                 a área de espera por tentativa/época
 *       history/                 o metadado de cada promoção
 *   /Shared/                   o que atravessa objetivos
 *
 * A regra que o desenho grita: o Goal workspace é UM só e compartilhado — NÃO
 * se duplica o objetivo inteiro por bot. O bot tem memória (em /Bots), não uma
 * cópia do projeto.
 */

import type { PuterFs } from './fs.js'

export const BOTS_ROOT = '/Bots'
export const GOALS_ROOT = '/Goals'
export const SHARED_ROOT = '/Shared'

/** As quatro pastas de um Goal — a ordem é a do desenho, para logs legíveis. */
export const GOAL_SUBDIRS = ['workspace', 'artifacts', 'staging', 'history'] as const

/**
 * Um segmento de caminho tem que ser um NOME, não um caminho: barra, `..` e
 * vazio escapariam a árvore da conta (o goalId vem de fora — nunca confie).
 * É a mesma paranoia do egress do agent-computer, aplicada ao filesystem.
 */
function segment(kind: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new Error(`${kind} vazio não endereça nada na árvore da conta`)
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '..' || trimmed === '.') {
    throw new Error(`${kind} "${value}" não é um nome de segmento válido (barra ou "..")`)
  }
  return trimmed
}

/* ------------------------------- endereços ------------------------------- */

/** A pasta de memória/config de um bot (o ofício é o id do bot). */
export function botDir(oficio: string): string {
  return `${BOTS_ROOT}/${segment('ofício', oficio)}`
}

/** A raiz de um objetivo. */
export function goalDir(goalId: string): string {
  return `${GOALS_ROOT}/${segment('goalId', goalId)}`
}

/** O projeto compartilhado do objetivo — o que o container materializa. */
export function goalWorkspace(goalId: string): string {
  return `${goalDir(goalId)}/workspace`
}

/** A raiz dos artefatos PROMOVIDOS (duráveis) do objetivo. */
export function goalArtifacts(goalId: string): string {
  return `${goalDir(goalId)}/artifacts`
}

/** A raiz das áreas de espera do objetivo. */
export function goalStaging(goalId: string): string {
  return `${goalDir(goalId)}/staging`
}

/** A raiz do histórico/metadado de promoções do objetivo. */
export function goalHistory(goalId: string): string {
  return `${goalDir(goalId)}/history`
}

/**
 * A área de espera de UMA tentativa — a época faz parte do endereço, então
 * duas publicações da mesma tarefa nunca se misturam (o mesmo invariante do
 * stagingUri do domain, agora na árvore do Puter).
 */
export function goalStagingAttempt(goalId: string, taskId: string, epoch: number): string {
  return `${goalStaging(goalId)}/${segment('taskId', taskId)}/epoch-${epochSeg(epoch)}`
}

/** Onde um artefato promovido de UMA tentativa fica (durável). */
export function goalArtifactsAttempt(goalId: string, taskId: string, epoch: number): string {
  return `${goalArtifacts(goalId)}/${segment('taskId', taskId)}/epoch-${epochSeg(epoch)}`
}

/** O metadado de UMA promoção (a camada "sobe metadado" do snapshot §23). */
export function goalHistoryEntry(goalId: string, taskId: string, epoch: number): string {
  return `${goalHistory(goalId)}/${segment('taskId', taskId)}/epoch-${epochSeg(epoch)}.json`
}

function epochSeg(epoch: number): number {
  if (!Number.isInteger(epoch) || epoch <= 0) {
    throw new Error(`época ${epoch} não endereça uma tentativa (inteiro positivo)`)
  }
  return epoch
}

/* --------------------------------- URIs ---------------------------------- */

/**
 * Codifica um caminho da conta como URI do provider puter. Como o caminho já
 * começa em `/`, o resultado tem a barra tripla que o plano de exemplo usa
 * (`puter:///Goals/...`).
 */
export function puterUri(path: string): string {
  return `puter://${path}`
}

/** Desfaz puterUri. Devolve '' para o que não é puter (espelho de localPath). */
export function puterPath(uri: string): string {
  const prefix = 'puter://'
  if (!uri.startsWith(prefix)) return ''
  return uri.slice(prefix.length)
}

/* ----------------------------- provisionamento --------------------------- */

/** Cria os três galhos da conta (idempotente). */
export async function ensureAccountRoots(fs: PuterFs): Promise<void> {
  await fs.mkdir(BOTS_ROOT)
  await fs.mkdir(GOALS_ROOT)
  await fs.mkdir(SHARED_ROOT)
}

/** Garante a pasta de memória de um bot. */
export async function ensureBot(fs: PuterFs, oficio: string): Promise<void> {
  await fs.mkdir(botDir(oficio))
}

/** Garante as quatro pastas de um objetivo — UMA vez, compartilhado. */
export async function ensureGoal(fs: PuterFs, goalId: string): Promise<void> {
  for (const sub of GOAL_SUBDIRS) {
    await fs.mkdir(`${goalDir(goalId)}/${sub}`)
  }
}

/**
 * Provisiona a árvore da conta de uma pessoa: os galhos, os bots por ofício e
 * os objetivos. Chamar de novo é seguro (mkdir é idempotente) — é o jeito de
 * "abrir a conta" sem duplicar nada.
 */
export async function ensureAccountTree(
  fs: PuterFs,
  spec: { bots?: readonly string[]; goals?: readonly string[] } = {},
): Promise<void> {
  await ensureAccountRoots(fs)
  for (const oficio of spec.bots ?? []) {
    await ensureBot(fs, oficio)
  }
  for (const goalId of spec.goals ?? []) {
    await ensureGoal(fs, goalId)
  }
}
