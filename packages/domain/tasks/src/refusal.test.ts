/**
 * Os casos de mesa do refusal() — porte 1:1 da tabela de
 * TestRefusalReprovaARecusaPuraEDeixaPassarOTrabalho do crew_test.go, mais o
 * gateReason e a escalação. A recusa pura reprova; trabalho técnico com "não"
 * passa; >280 chars nunca é recusa.
 */

import { describe, expect, it } from 'vitest'
import { REFUSAL_MAX_LEN, escalation, gateReason, refusal } from './index.js'

describe('refusal — reprova a recusa pura e deixa passar o trabalho', () => {
  const cases: Array<{ name: string; answer: string; want: boolean }> = [
    { name: 'recusa seca', answer: 'Não posso ajudar com isso.', want: true },
    {
      name: 'recusa com desculpa',
      answer: 'Desculpe, mas não posso ajudar com esse pedido.',
      want: true,
    },
    {
      name: 'recusa com dois preâmbulos (descascados em laço)',
      answer: 'Sinto muito, eu não posso fazer isso.',
      want: true,
    },
    {
      name: 'recusa de assistente',
      answer: 'Como modelo de linguagem, não posso atender a esse pedido.',
      want: true,
    },
    { name: 'recusa em caixa alta', answer: 'NÃO POSSO AJUDAR', want: true },
    { name: 'recusa sem acento', answer: 'Nao posso ajudar com essa tarefa.', want: true },
    { name: 'recusa explícita', answer: 'Me recuso a realizar essa tarefa.', want: true },
    { name: 'recusa em inglês', answer: "I can't help with that request.", want: true },
    {
      name: "resposta técnica com 'não' passa (verbo técnico NÃO é recusa)",
      answer: 'A rota /pagamentos não aceitava POST; ajustei o handler e os testes passam.',
      want: false,
    },
    {
      name: 'constatação negativa não é recusa',
      answer: 'Não há ocorrências de contratante no documento — o texto já usa cliente.',
      want: false,
    },
    {
      // Começa igual à recusa, mas o verbo é técnico e a frase termina em
      // trabalho feito — o falso positivo que o marcador estreito não comete.
      name: 'impedimento técnico seguido de solução passa',
      answer:
        'Não posso alterar o arquivo de config sem aprovação, então apliquei a mudança no exemplo e documentei.',
      want: false,
    },
    {
      // Longa demais para ser recusa pura: quem recusa e segue explicando
      // alternativas entregou conteúdo que o orquestrador sabe ler.
      name: 'recusa longa com alternativa passa (>280 chars nunca é recusa)',
      answer:
        'Não posso ajudar com a assinatura do contrato em si, mas mapeei o que falta: ' +
        'o anexo B está sem a cláusula de rescisão, o prazo do item 4 conflita com o item 9 ' +
        'e a testemunha indicada não consta no cadastro. Sugiro corrigir os três pontos e ' +
        'repassar o documento pelo jurídico antes de qualquer assinatura, com registro em ata.',
      want: false,
    },
    { name: 'resposta vazia não é recusa', answer: '   ', want: false },
  ]

  for (const each of cases) {
    it(each.name, () => {
      expect(refusal(each.answer)).toBe(each.want)
    })
  }

  it('o teto é 280: um caractere acima e a mesma recusa deixa de ser recusa', () => {
    const curta = 'Não posso ajudar. ' + 'x'.repeat(REFUSAL_MAX_LEN - 'Não posso ajudar. '.length)
    expect(curta.length).toBe(REFUSAL_MAX_LEN)
    expect(refusal(curta)).toBe(true)
    expect(refusal(curta + 'x')).toBe(false)
  })

  it('apóstrofo tipográfico do inglês é normalizado', () => {
    expect(refusal('I can’t help with that.')).toBe(true)
  })
})

describe('escalation — ESCALAR: conta no portão, não em failures', () => {
  it('detecta o pedido em qualquer linha e devolve a pergunta limpa', () => {
    const result = escalation('Analisei as opções.\nESCALAR: qual banco de dados usar?\n')
    expect(result).toEqual({ escalated: true, question: 'qual banco de dados usar?' })
  })

  it('sem o prefixo exato não há escalação', () => {
    expect(escalation('poderia escalar: isso?')).toEqual({ escalated: false, question: '' })
  })
})

describe('gateReason — separa quem ERROU de quem PERGUNTOU', () => {
  it('só falhas', () => {
    expect(gateReason(2, 3, 0)).toBe(
      '3 tarefa(s) da onda 2 falharam — seguir, refazer ou abortar?',
    )
  })
  it('só escalações — nunca chamadas de falha', () => {
    expect(gateReason(1, 0, 2)).toBe(
      '2 tarefa(s) da onda 1 escalaram e esperam resposta — seguir, refazer ou abortar?',
    )
  })
  it('misto', () => {
    expect(gateReason(3, 1, 1)).toBe(
      'na onda 3, 1 tarefa(s) falharam e 1 escalaram e esperam resposta — seguir, refazer ou abortar?',
    )
  })
})
