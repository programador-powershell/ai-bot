/**
 * O Budget Manager: quanto cabe na janela do modelo e QUANDO compactar.
 *
 * Duas heranças num módulo:
 *
 *  1. o medidor do oráculo (`internal/supervisor/context_budget.go`):
 *     CHARS_PER_TOKEN=4 nos dois lados, promptShare, o piso da pergunta atual
 *     e o truncamento NO MEIO com marca — o defeito que ele impede não era um
 *     turno que falha, era uma conversa que MORRE depois de uma colagem grande;
 *
 *  2. os gatilhos da spec E6: targetAfterCompact/soft/hard derivados da janela
 *     com clamps, compactação PREVENTIVA a ~85% do hard (o prefire — a
 *     compactação dispara ANTES de o teto ser tocado, nunca depois).
 */

/**
 * A regra de bolso para estimar tokens sem tokenizador. Quatro erra para os
 * dois lados — código denso gasta mais, prosa acentuada gasta menos — e por
 * isso vem acompanhada das margens abaixo. Tokenizar de verdade exigiria o
 * vocabulário de cada provedor dentro do processo: peso e acoplamento para uma
 * decisão que só precisa da ordem de grandeza certa. O MESMO valor vale nos
 * dois lados (servidor e app) — medidores divergentes fariam a tela discordar
 * do corte.
 */
export const CHARS_PER_TOKEN = 4

/**
 * Quanto da janela o PROMPT pode ocupar. O resto é da resposta: encher a
 * janela até a borda deixa o modelo sem espaço para responder, e o erro que
 * volta é o mesmo do estouro.
 */
export const PROMPT_SHARE = 0.65

/**
 * A janela assumida quando o catálogo não informa a do modelo. Conservadora de
 * propósito: subestimar corta contexto que caberia; superestimar traz de volta
 * exatamente o defeito.
 */
export const DEFAULT_CONTEXT_TOKENS = 8192

/**
 * Quanto do fim da conversa é preservado mesmo quando o orçamento aperta. Sem
 * um piso, uma colagem enorme engoliria a pergunta atual e o modelo
 * responderia a outra coisa.
 */
export const MIN_KEPT_MESSAGES = 2

/** O mínimo que a pergunta atual recebe mesmo sem orçamento. */
export const FLOOR_TOKENS = 256

/**
 * A compactação PREVENTIVA: dispara a ~85% do hard. É o "prefire antes do
 * hard" da spec — o hard nunca deve ser TOCADO em operação normal; quando é,
 * a compactação vira obrigatória e síncrona (antes de chamar o modelo).
 */
export const PREFIRE_RATIO = 0.85

/** Chars da NOTE_1 de emergência (ver assembler.buildEmergencyNote). */
export const NOTE1_MAX_CHARS = 12_000

/** Estima o custo de um texto. Mesma forma do approxTokens do oráculo. */
export function approxTokens(text: string): number {
  if (text === '') return 0
  return Math.floor(text.length / CHARS_PER_TOKEN) + 1
}

/**
 * Corta um texto para caber em `tokens`, deixando a marca do corte NO TEXTO.
 *
 * A marca não é cosmética: sem ela o modelo lê um log que termina no meio como
 * se aquele fosse o fim do arquivo. O corte é no MEIO — começo e fim de uma
 * colagem carregam mais informação que o miolo (o cabeçalho e o stack trace
 * final). Porte do truncateForContext do oráculo.
 */
export function truncateForContext(text: string, tokens: number): string {
  const limit = tokens * CHARS_PER_TOKEN
  if (limit <= 0 || text.length <= limit) return text
  const head = Math.floor(limit / 2)
  const tail = limit - head
  if (head <= 0 || tail <= 0) return text.slice(0, limit)
  const omitted = Math.floor((text.length - head - tail) / 1024)
  return (
    text.slice(0, head) +
    `\n\n[…colagem cortada para caber na janela do modelo: ${omitted} KB omitidos…]\n\n` +
    text.slice(text.length - tail)
  )
}

/**
 * A pressão medida contra os gatilhos:
 *  - ok       → nada a fazer;
 *  - soft     → compactar no FIM do turno (fora do caminho da resposta);
 *  - prefire  → compactar AGORA, antes de chamar o modelo (a preventiva de ~85%);
 *  - hard     → o teto foi tocado: compactação obrigatória + fit agressivo.
 */
export type BudgetPressure = 'ok' | 'soft' | 'prefire' | 'hard'

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.min(Math.max(value, floor), ceiling)
}

/** Os gatilhos de UMA janela de modelo. Imutáveis — um manager por janela. */
export class BudgetManager {
  readonly windowTokens: number
  /**
   * O tamanho-alvo do working set VARIÁVEL depois de uma compactação:
   * clamp(janela*0.10, 24k, 64k). Compactar até menos jogaria fora cauda que
   * cabia; até mais deixaria a próxima compactação logo ali.
   */
  readonly targetAfterCompact: number
  /** Gatilho de compactação normal: clamp(janela*0.18, 48k, 96k). */
  readonly soft: number
  /** O teto do working set variável: clamp(janela*0.25, 64k, 128k). */
  readonly hard: number
  /** O limiar da preventiva: ~85% do hard (prefire). */
  readonly prefireAt: number
  /**
   * O teto FÍSICO do prompt inteiro (janela*promptShare) — o fit ladder corta
   * até aqui. Os clamps da spec assumem janelas grandes; numa janela menor que
   * os pisos, é o teto físico que manda (sem isto os gatilhos nunca
   * disparariam numa janela de 8k e o estouro voltaria).
   */
  readonly fitBudget: number

  constructor(windowTokens?: number) {
    const window = windowTokens !== undefined && windowTokens > 0 ? windowTokens : DEFAULT_CONTEXT_TOKENS
    this.windowTokens = window
    const physical = Math.floor(window * PROMPT_SHARE)
    this.fitBudget = physical
    this.targetAfterCompact = Math.min(clamp(Math.floor(window * 0.1), 24_000, 64_000), physical)
    this.soft = Math.min(clamp(Math.floor(window * 0.18), 48_000, 96_000), physical)
    this.hard = Math.min(clamp(Math.floor(window * 0.25), 64_000, 128_000), physical)
    this.prefireAt = Math.floor(this.hard * PREFIRE_RATIO)
  }

  /**
   * Mede a pressão do working set VARIÁVEL (tudo menos as mensagens system).
   * A ordem dos testes é do mais grave ao menos: quando os limiares colapsam
   * (janela pequena capada pelo teto físico), o mais conservador vence.
   */
  pressure(usedTokens: number): BudgetPressure {
    if (usedTokens >= this.hard) return 'hard'
    if (usedTokens >= this.prefireAt) return 'prefire'
    if (usedTokens >= this.soft) return 'soft'
    return 'ok'
  }
}
