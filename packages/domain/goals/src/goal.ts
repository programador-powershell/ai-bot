/**
 * O Goal: o pedido do usuário como ENTIDADE, não como turno.
 *
 * No oráculo Go o Goal só existia declarado (SessionMeta.ProjectID, "lido por
 * ninguém" — a dívida documentada em arquitetura-cluster.md). Aqui ele nasce
 * como o eixo do control plane: Tasks pertencem a um Goal, o orçamento da
 * equipe (tetos 3/4/24) reside NO GOAL em store durável, e as conversas-filhas
 * (delegações, workers) penduram nele.
 *
 * O Goal é PERSISTENTE (a coluna esquerda do eixo do cluster): containers,
 * CPU e snapshots morrem; o Goal e o que foi promovido para o workspace dele
 * sobrevivem.
 */

/** O pedido do usuário como entidade do control plane. */
export interface Goal {
  id: string
  /** A PESSOA dona — a autoridade dos bots é derivada da dela, nunca própria. */
  ownerId?: string
  title: string
  /** O objetivo por extenso — o que o plano de tarefas decompõe. */
  objective?: string
  createdAt: string
  archived?: boolean
}

/**
 * A sessão de CONTROLE de um Goal no event log — o "ponteiro lógico" que
 * sub-equipes compartilham. É nela que o débito do orçamento e os estados de
 * Task/TaskRun ficam duráveis: uma sub-equipe que herda o goalId herda a MESMA
 * sessão de controle, logo o MESMO débito — a asserção do aceite E7 é sobre
 * este id, não sobre um ponteiro de memória.
 *
 * Determinística de propósito: reinício do servidor recalcula o mesmo id e
 * reencontra o mesmo log.
 */
export function goalControlSessionId(goalId: string): string {
  const trimmed = goalId.trim()
  if (trimmed === '') {
    throw new Error('goal sem id não tem sessão de controle')
  }
  return `goal-cp-${trimmed}`
}
