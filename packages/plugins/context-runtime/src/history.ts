/**
 * history() — a reconstrução da cauda recente a partir do LOG, porte do
 * `history()` do supervisor.go do oráculo, com os MESMOS pares atômicos:
 *
 *  - a EVIDÊNCIA de ferramenta volta como UMA mensagem user por par
 *    tool.call+tool.result — e não duas: um "Chamei a ferramenta X." separado
 *    do resultado podia ser cortado pelo orçamento (ou o contrário), e uma
 *    unidade lógica nunca deve ser partida ao caber a janela. A evidência é
 *    autodescritiva — o nome da ferramenta está nela. command+saída+exitCode é
 *    o MESMO caso: a saída do executor já carrega o exit code no corpo, então
 *    o trio viaja numa mensagem só, por construção;
 *
 *  - a DELEGAÇÃO dobra DUAS vezes por Done (o pedido do dono e o resultado do
 *    delegado), e as duas mensagens formam um GRUPO atômico: partir "Deleguei
 *    X" do "Resultado de X" deixaria o modelo vendo um pedido sem desfecho —
 *    ou um desfecho órfão;
 *
 *  - approval.request+approval.decision NEM ENTRAM na cauda (paridade com o
 *    oráculo) — o par é atômico por ausência: pendência de aprovação vive na
 *    cápsula e no checkpoint, não no prompt.
 */

import { truncate } from '@aibot2/plugin-action-gateway'
import type { Envelope } from '@aibot2/domain-events'

/** Quanto do histórico entra no prompt — o mesmo teto do oráculo. */
export const MAX_HISTORY_MESSAGES = 40

/** O teto da evidência inline no prompt (bem menor que os 20 000 do log). */
export const EVIDENCE_LIMIT_BYTES = 2000
/** O teto do goal de uma delegação no prompt. */
export const DELEGATION_GOAL_LIMIT_BYTES = 400

/** Uma mensagem como o modelo a vê. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** De onde um item da cauda veio — decide o degrau do fit ladder que o toca. */
export type TailSource = 'message' | 'evidence' | 'delegation'

/** Um item da cauda verbatim, com o que o assembler precisa para decidir. */
export interface TailItem {
  role: ChatMessage['role']
  content: string
  /** O seq do envelope de origem — absorvido quando <= capsule.cursor. */
  seq: number
  source: TailSource
  /**
   * Itens com o MESMO groupId entram e saem da janela JUNTOS (grupo atômico).
   * Ausente = o item é o próprio grupo.
   */
  groupId?: string
  /** A ferramenta da evidência — é por ela que passos redundantes se reconhecem. */
  tool?: string
}

/**
 * A linha sintética que devolve ao histórico o RESULTADO de uma ferramenta.
 * Mesmo formato do toolEvidence do oráculo, para o modelo não ver dois
 * dialetos do mesmo fato entre um turno e o seguinte.
 */
export function toolEvidence(tool: string, output: string): string {
  return 'Resultado das ferramentas:\n\n' + tool + ' =>\n' + output.trim()
}

/**
 * Constrói a cauda a partir dos envelopes (já na ordem do log). Só três verbos
 * entram — message, tool.result e delegate — exatamente como no oráculo: o
 * resto ou é efêmero, ou vive na cápsula, ou é assunto do transporte.
 */
export function tailFromEnvelopes(envelopes: readonly Envelope[]): TailItem[] {
  const out: TailItem[] = []
  // Pareia o delegate de abertura (done=false) com o de fechamento, POR
  // DESTINO: o goal pode se repetir, o destino da vez não — o último aberto
  // para aquele `to` é o dono do resultado que chegar.
  const openDelegations = new Map<string, number>()

  for (const envelope of envelopes) {
    const payload = envelope.payload as Record<string, unknown> | undefined
    switch (envelope.kind) {
      case 'message': {
        const text = typeof payload?.['text'] === 'string' ? (payload['text'] as string) : ''
        if (text.trim() === '') continue
        const role = payload?.['role']
        if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
        out.push({ role, content: text, seq: envelope.seq, source: 'message' })
        continue
      }

      // A EVIDÊNCIA volta ao histórico. Antes só message era dobrado, e o par
      // chamada+resultado sumia entre um turno e o seguinte: o modelo entrava
      // no turno 2 vendo "o arquivo diz 42" — a própria afirmação dele — e
      // nenhum traço do que o arquivo continha. Ou relia (custo, e aprovação
      // de novo), ou seguia em cima da própria alegação.
      case 'tool.result': {
        const tool = typeof payload?.['tool'] === 'string' ? (payload['tool'] as string) : ''
        if (tool === '') continue
        let body = typeof payload?.['output'] === 'string' ? (payload['output'] as string) : ''
        if (payload?.['ok'] !== true) {
          const failure = typeof payload?.['error'] === 'string' ? (payload['error'] as string) : ''
          body = 'falhou: ' + failure
        }
        if (body.trim() === '') continue
        // Truncado bem mais curto que os 20 000 do log: aqui o texto disputa a
        // janela com a conversa inteira.
        out.push({
          role: 'user',
          content: toolEvidence(tool, truncate(body, EVIDENCE_LIMIT_BYTES)),
          seq: envelope.seq,
          source: 'evidence',
          tool,
        })
        continue
      }

      // A DELEGAÇÃO também volta — pelo mesmo motivo da evidência. Gravada
      // DUAS vezes (abre e fecha); a chave é o done: o envelope inicial vira o
      // pedido, o final vira o resultado — e os dois compartilham groupId.
      case 'delegate': {
        const to = typeof payload?.['to'] === 'string' ? (payload['to'] as string) : ''
        if (to === '') continue
        if (payload?.['done'] !== true) {
          const goal = typeof payload?.['goal'] === 'string' ? (payload['goal'] as string) : ''
          openDelegations.set(to, envelope.seq)
          out.push({
            role: 'assistant',
            content: `Deleguei ao especialista ${to}: ${truncate(goal, DELEGATION_GOAL_LIMIT_BYTES)}`,
            seq: envelope.seq,
            source: 'delegation',
            groupId: `delegate:${to}:${envelope.seq}`,
          })
          continue
        }
        const result = typeof payload?.['result'] === 'string' ? (payload['result'] as string) : ''
        if (result.trim() === '') continue
        const openedAt = openDelegations.get(to)
        openDelegations.delete(to)
        const item: TailItem = {
          role: 'user',
          content: `Resultado do especialista ${to}:\n${truncate(result, EVIDENCE_LIMIT_BYTES)}`,
          seq: envelope.seq,
          source: 'delegation',
        }
        // Sem abertura na janela (chegou por outra fatia do log), o resultado
        // viaja sozinho — grupo de um só.
        if (openedAt !== undefined) item.groupId = `delegate:${to}:${openedAt}`
        out.push(item)
        continue
      }

      default:
        continue
    }
  }

  // Corta pelo FIM: o começo da conversa é o que menos importa para o próximo
  // turno, e cortar pelo começo descartaria justamente a pergunta atual. O
  // corte respeita grupos: se o primeiro item mantido pertence a um grupo cuja
  // abertura caiu, a abertura volta — grupo atômico não nasce partido.
  if (out.length > MAX_HISTORY_MESSAGES) {
    let start = out.length - MAX_HISTORY_MESSAGES
    const firstGroup = out[start]!.groupId
    if (firstGroup !== undefined) {
      while (start > 0 && out[start - 1]!.groupId === firstGroup) start--
    }
    return out.slice(start)
  }
  return out
}

/** A cauda como mensagens prontas para o modelo. */
export function toChatMessages(items: readonly TailItem[]): ChatMessage[] {
  return items.map((item) => ({ role: item.role, content: item.content }))
}
