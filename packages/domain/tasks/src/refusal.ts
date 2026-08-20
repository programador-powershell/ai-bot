/**
 * A heurística de recusa e a escalação — porte do refusal()/escalation() do
 * crew.go do oráculo, constantes e casos preservados.
 *
 * RECUSA NÃO É RESULTADO: "Não posso ajudar com isso" saindo com ✓ entra nos
 * resultados e vira o bloco de upstream das tarefas dependentes — que leem a
 * recusa como trabalho feito e constroem em cima. E a detecção tem de ser
 * conservadora no OUTRO sentido também: resposta técnica diz "não" o tempo
 * todo e continua sendo trabalho entregue; o falso positivo reprova trabalho
 * feito, que é pior e não avisa.
 */

/**
 * Teto acima do qual NENHUMA resposta é tratada como recusa. A recusa pura é
 * curta; uma resposta longa que começa recusando costuma seguir com
 * alternativa ou trabalho parcial, e reprová-la jogaria fora conteúdo que o
 * orquestrador sabe ler.
 */
export const REFUSAL_MAX_LEN = 280

/**
 * Os enfeites que os modelos põem ANTES da recusa. Descascados em LAÇO porque
 * eles se empilham ("Desculpe, mas eu não posso…"). "desculpas" antes de
 * "desculpa": o corte é ganancioso na ordem da lista, e cortar o singular
 * primeiro deixaria um "s" órfão na frente.
 */
const REFUSAL_PREAMBLES = [
  'desculpe',
  'desculpas',
  'desculpa',
  'peco desculpas',
  'sinto muito',
  'lamento',
  'infelizmente',
  'como modelo de linguagem',
  'como uma ia',
  'como ia',
  'eu ',
  'mas ',
  'porem ',
] as const

/**
 * Os começos que contam como recusa DEPOIS de descascar o preâmbulo. A lista
 * é deliberadamente estreita — verbos de recusar o PEDIDO (ajudar, atender a
 * esse/este, fazer isso), nunca verbos técnicos: "não posso alterar o arquivo
 * sem X, então fiz Y" é resposta de trabalho e começa igual. O texto já chega
 * sem acento em "não" (ver refusal), por isso só há "nao".
 */
const REFUSAL_MARKERS = [
  'nao posso ajudar',
  'nao posso te ajudar',
  'nao poderei ajudar',
  'nao vou poder ajudar',
  'nao consigo ajudar',
  'nao vou ajudar',
  'nao irei ajudar',
  'nao posso auxiliar',
  'nao posso fazer isso',
  'nao posso fazer ess',
  'nao posso realizar ess',
  'nao posso realizar est',
  'nao posso completar ess',
  'nao posso completar est',
  'nao posso atender a ess',
  'nao posso atender ess',
  'nao posso atender a est',
  'nao posso atender est',
  'me recuso',
  'recuso-me',
  "i can't help",
  'i cannot help',
  "i can't assist",
  'i cannot assist',
  "i won't help",
  "i can't comply",
  'i cannot comply',
  "i'm unable to help",
  'i am unable to help',
] as const

/**
 * Detecta a resposta que é SÓ recusa.
 *
 * A pergunta que ela responde não é "o modelo disse não?" — é "o trabalhador
 * devolveu ALGUMA COISA além da recusa?". Conservadora de propósito: curta
 * (teto de tamanho), começando pela recusa (prefixo, não substring) e com
 * verbos de recusar o pedido. O falso negativo custa uma recusa com ✓ — ruim,
 * mas visível no relatório; o falso positivo reprova trabalho feito.
 */
export function refusal(answer: string): boolean {
  const trimmed = answer.trim()
  if (trimmed === '' || trimmed.length > REFUSAL_MAX_LEN) {
    return false
  }
  // Normaliza as duas grafias que os modelos alternam: com e sem acento, e o
  // apóstrofo tipográfico do inglês.
  let lower = trimmed
    .toLowerCase()
    .replaceAll('não', 'nao')
    .replaceAll('ç', 'c')
    .replaceAll('’', "'")

  for (let changed = true; changed; ) {
    changed = false
    lower = lower.replace(/^[ \t.,!;:—–-]+/, '')
    for (const preamble of REFUSAL_PREAMBLES) {
      if (lower.startsWith(preamble)) {
        lower = lower.slice(preamble.length)
        changed = true
      }
    }
  }

  for (const marker of REFUSAL_MARKERS) {
    if (lower.startsWith(marker)) {
      return true
    }
  }
  return false
}

/**
 * Detecta o pedido de escalação na resposta. Escalar NÃO é falha: é o
 * trabalhador se recusando a ADIVINHAR — conta no portão da onda (tarefa sem
 * resultado) mas nunca em failures.
 */
export function escalation(answer: string): { question: string; escalated: boolean } {
  for (const line of answer.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('ESCALAR:')) {
      return { question: trimmed.slice('ESCALAR:'.length).trim(), escalated: true }
    }
  }
  return { question: '', escalated: false }
}

/**
 * Descreve a onda para quem vai decidir o portão, separando o que ERROU do
 * que PERGUNTOU — porte do gateReason(). Dizer "1 tarefa falhou" quando a
 * tarefa fez uma pergunta empurra a pessoa para "refazer", que é a resposta
 * errada: o que resolve escalação é responder.
 */
export function gateReason(wave: number, failures: number, escalations: number): string {
  if (escalations === 0) {
    return `${failures} tarefa(s) da onda ${wave} falharam — seguir, refazer ou abortar?`
  }
  if (failures === 0) {
    return `${escalations} tarefa(s) da onda ${wave} escalaram e esperam resposta — seguir, refazer ou abortar?`
  }
  return `na onda ${wave}, ${failures} tarefa(s) falharam e ${escalations} escalaram e esperam resposta — seguir, refazer ou abortar?`
}
