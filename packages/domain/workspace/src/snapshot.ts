/**
 * O snapshot em DUAS camadas da promoção (spec §23 / Onda 6): o que uma
 * promoção SOBE para o backend durável (metadado + resultado) e o que ela
 * NUNCA sobe (o descartável do container).
 *
 * Puro de propósito — só a lista e o predicado. Quem anda no disco e sobe os
 * bytes é o backend concreto (providers/puter); o domain fica sem dependência
 * de runtime, como o resto do pacote.
 *
 * Por que uma lista aqui e não no provider: a exclusão é a MESMA promessa em
 * qualquer backend (local, puter, um vps amanhã). Deixá-la no domain evita que
 * cada provider invente a sua e um deles esqueça `node_modules` — o jeito
 * clássico de um snapshot de 2 GB entrar calado (o incidente do apps.zip, com
 * outro nome).
 */

/**
 * O descartável do container: pastas que a máquina REGENERA a partir do que
 * SOBE (locks, fontes, config). Subir isso é caro e é ruído — some, reaparece
 * com um install/build. Cada entrada tem um porquê, não é folclore:
 */
export const SNAPSHOT_EXCLUDES: readonly string[] = [
  'node_modules', // reinstalado do lock; nunca é fonte de verdade
  '.git', // o git de baseline/checkpoint é do worker (shadow-git), não artefato
  '.bun', // cache/estado do runtime Bun
  '.pnpm-store', // idem para pnpm
  'dist', // saída de build — regenera do fonte
  'build', // idem
  'out', // idem
  '.next', // cache de build do Next
  '.turbo', // cache do turbo
  '.cache', // caches genéricos
  'coverage', // relatório de cobertura, derivado
  'target', // saída do cargo (rust)
  '.venv', // ambiente virtual python — recriado do requirements
  '__pycache__', // bytecode python, derivado
]

const EXCLUDE_SET = new Set(SNAPSHOT_EXCLUDES)

/**
 * O caminho RELATIVO (à raiz do staging) é da camada descartável? Vale para a
 * pasta e para tudo abaixo dela: `node_modules`, `node_modules/x/y.js` e
 * `pkg/node_modules/z` são todos descartáveis — a exclusão é por SEGMENTO, não
 * por prefixo, senão um `node_modules` aninhado escaparia.
 *
 * Normaliza a barra do Windows antes de decidir: o mesmo arquivo não pode ser
 * "sobe" numa máquina e "não sobe" na outra só porque o separador mudou (o
 * mesmo cuidado que localUri já toma com o caminho).
 */
export function isDisposable(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/')
  for (const segment of normalized.split('/')) {
    if (segment !== '' && EXCLUDE_SET.has(segment)) {
      return true
    }
  }
  return false
}
