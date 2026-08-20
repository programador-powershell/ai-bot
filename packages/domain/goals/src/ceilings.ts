/**
 * Os tetos da árvore de equipes — porte de permissions.DefaultPolicy +
 * crewPolicy() do oráculo Go (crew.go).
 *
 * Os três números não são constantes novas: são os campos que a política JÁ
 * declarava e que o gateway de antes não lia ("política declarada e não lida"
 * aconteceu três vezes na casa — o teto que se configura e não se aplica é
 * pior que teto nenhum, porque quem configurou acredita que está protegido).
 *
 * A RESIDÊNCIA muda em relação ao Go (D6): o débito sai do context.Context de
 * processo e vai para store durável por Goal — quem aplica é o GoalBudget do
 * domain/tasks, sobre a sessão de controle do Goal.
 */

/** Os três tetos da equipe. */
export interface CrewCeilings {
  /** Quantos níveis de sub-equipe uma equipe pode montar. */
  maxDepth: number
  /** Paralelismo máximo de uma onda. */
  maxChildren: number
  /** Trabalhadores no GOAL inteiro, sub-equipes inclusive. */
  maxTotal: number
}

/** Os valores de fábrica do oráculo (permissions.DefaultPolicy): 3/4/24. */
export const DEFAULT_CEILINGS: Readonly<CrewCeilings> = Object.freeze({
  maxDepth: 3,
  maxChildren: 4,
  maxTotal: 24,
})

/**
 * Resolve os tetos com piso para o que veio zerado — porte de crewPolicy().
 *
 * Zero (ou ausente) é "não configurado", não "proibido tudo": uma política
 * parcial vinda do servidor do administrador não pode desligar a equipe
 * inteira em silêncio.
 *
 * `childrenCeil` é o teto do PLANEJADOR (a concorrência máxima que o DAG
 * aceita): um maxChildren alto demais faria o plano ser RECUSADO com erro de
 * validação em vez de simplesmente montar ondas menores — por isso o clamp
 * mora aqui, na resolução, e não no meio da execução.
 */
export function resolveCeilings(
  configured?: Partial<CrewCeilings>,
  childrenCeil?: number,
): CrewCeilings {
  const resolved: CrewCeilings = { ...DEFAULT_CEILINGS }
  if (configured !== undefined) {
    if (typeof configured.maxDepth === 'number' && configured.maxDepth > 0) {
      resolved.maxDepth = configured.maxDepth
    }
    if (typeof configured.maxChildren === 'number' && configured.maxChildren > 0) {
      resolved.maxChildren = configured.maxChildren
    }
    if (typeof configured.maxTotal === 'number' && configured.maxTotal > 0) {
      resolved.maxTotal = configured.maxTotal
    }
  }
  if (childrenCeil !== undefined && childrenCeil > 0 && resolved.maxChildren > childrenCeil) {
    resolved.maxChildren = childrenCeil
  }
  return resolved
}
