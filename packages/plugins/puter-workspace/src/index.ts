/**
 * @aibot2/plugin-puter-workspace — a árvore da conta no Puter (spec §23) como
 * dado: os endereços de /Bots, /Goals/{workspace,artifacts,staging,history} e
 * /Shared, o provisionamento idempotente, o contrato PuterFs (superfície
 * mínima) e um Puter FALSO em memória para provar o backend sem conta real.
 *
 * Puro de rede: quem anda no Puter de verdade é o backend em providers/puter.
 */

export type { PuterEntry, PuterFs } from './fs.js'

export {
  BOTS_ROOT,
  GOALS_ROOT,
  SHARED_ROOT,
  GOAL_SUBDIRS,
  botDir,
  goalDir,
  goalWorkspace,
  goalArtifacts,
  goalStaging,
  goalHistory,
  goalStagingAttempt,
  goalArtifactsAttempt,
  goalHistoryEntry,
  puterUri,
  puterPath,
  ensureAccountRoots,
  ensureBot,
  ensureGoal,
  ensureAccountTree,
} from './tree.js'

export { FakePuterFs } from './fake.js'
