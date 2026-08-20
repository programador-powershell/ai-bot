/**
 * O motor de REGRAS DE EXPRESSÃO do governo — clean-room, sem cel-js (§4.5 do
 * plano de integração: um motor de política só, e ele é NOSSO).
 *
 * Por que existe: o chassis forkado escrevia as regras do computer gateway em
 * CEL avaliado pelo cel-js. Dois motores de política é o cenário I4 (duas
 * verdades), e um motor de terceiro no último degrau antes do efeito é
 * superfície que ninguém daqui audita. Este módulo reimplementa APENAS o
 * subconjunto que as regras do produto usam — e as fixtures do govern ficaram
 * intactas porque a semântica é a mesma:
 *
 *   literais      true | false | null | número | "texto" | 'texto'
 *   caminhos      tool.name, element.name, page.host, key, mcp.effect…
 *   comparação    ==  !=
 *   lógica        && (liga mais forte) || (liga mais fraco) !
 *   agrupamento   ( … )
 *   funções       contains(a, b)   — substring caso-insensível
 *                 matches(a, re)   — regex caso-insensível
 *
 * PARSE PRIMEIRO, AVALIAÇÃO DEPOIS — e isso não é estética. A memória da casa
 * "política declarada e não lida" exige que uma regra com sintaxe quebrada
 * falhe SEMPRE, mesmo num ramo que o curto-circuito nunca visitaria; e as
 * fixtures do govern exigem que `tool.name == "x" && key == "Enter"` avaliada
 * numa chamada SEM `key` seja falsa quando o guarda já falhou (curto-circuito
 * absorve erro de RESOLUÇÃO, como no CEL: false && erro = false). Num motor de
 * um passo só as duas exigências se contradizem; com AST elas convivem:
 * sintaxe é julgada inteira no parse, resolução é julgada ramo a ramo no eval.
 *
 * As três decisões de segurança que NÃO são detalhe:
 *
 *  1. IDENTIFICADOR AUSENTE É ERRO, nunca `undefined` silencioso. A regra
 *     `key == "Enter"` avaliada numa navegação (que não tem `key`) FALHA — e
 *     quem chama trata falha como fail-closed por lista (deny quebrado nega;
 *     allow quebrado não permite).
 *
 *  2. EXPRESSÃO QUE NÃO PARSEIA É ERRO, sempre. Não existe "aceitei sua regra,
 *     mas entendi outra coisa".
 *
 *  3. contains/matches são CASO-INSENSÍVEIS por contrato: a regra "nunca
 *     clique em submit" tem de pegar o botão "SUBMIT" — quem escreve regra
 *     pensa no efeito, não na caixa da fonte da página.
 */

/** Erro de avaliação — o chamador decide o que a falha significa (fail-closed por lista). */
export class RuleError extends Error {
  override name = 'RuleError'
}

/* -------------------------------- tokens ---------------------------------- */

type TokenKind = 'ident' | 'string' | 'number' | 'op' | 'fim'

interface Token {
  kind: TokenKind
  text: string
  pos: number
}

function tokenizar(expressao: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = expressao.length
  while (i < n) {
    const c = expressao[i]!
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i += 1
      continue
    }
    // Operadores de dois caracteres antes dos de um — senão "==" viraria "=" "=".
    const dois = expressao.slice(i, i + 2)
    if (dois === '==' || dois === '!=' || dois === '&&' || dois === '||') {
      tokens.push({ kind: 'op', text: dois, pos: i })
      i += 2
      continue
    }
    if (c === '!' || c === '(' || c === ')' || c === ',' || c === '.') {
      tokens.push({ kind: 'op', text: c, pos: i })
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      // String com escape de barra — o suficiente para regra escrita à mão.
      let j = i + 1
      let valor = ''
      for (;;) {
        if (j >= n) {
          throw new RuleError(`regra ilegível: string sem fechamento a partir da posição ${i}`)
        }
        const s = expressao[j]!
        if (s === '\\') {
          if (j + 1 >= n) {
            throw new RuleError(`regra ilegível: escape solto no fim da string (posição ${j})`)
          }
          valor += expressao[j + 1]!
          j += 2
          continue
        }
        if (s === c) break
        valor += s
        j += 1
      }
      tokens.push({ kind: 'string', text: valor, pos: i })
      i = j + 1
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < n && /[0-9.]/.test(expressao[j]!)) j += 1
      tokens.push({ kind: 'number', text: expressao.slice(i, j), pos: i })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_]/.test(expressao[j]!)) j += 1
      tokens.push({ kind: 'ident', text: expressao.slice(i, j), pos: i })
      i = j
      continue
    }
    throw new RuleError(`regra ilegível: símbolo ${JSON.stringify(c)} na posição ${i}`)
  }
  tokens.push({ kind: 'fim', text: '', pos: n })
  return tokens
}

/* ---------------------------------- AST ----------------------------------- */

type No =
  | { tipo: 'literal'; valor: unknown }
  | { tipo: 'caminho'; partes: string[] }
  | { tipo: 'chamada'; nome: string; args: No[] }
  | { tipo: 'nao'; alvo: No }
  | { tipo: 'compara'; op: '==' | '!='; esquerda: No; direita: No }
  | { tipo: 'e'; esquerda: No; direita: No }
  | { tipo: 'ou'; esquerda: No; direita: No }

/**
 * As funções embutidas. Fechadas aqui dentro de propósito: função é parte do
 * CONTRATO da linguagem de regra, não extensão de quem monta — dois callers
 * com funções diferentes seriam duas linguagens com a mesma cara.
 */
const FUNCOES: Record<string, (args: unknown[]) => unknown> = {
  contains: (args) => {
    if (args.length !== 2) {
      throw new RuleError('contains espera exatamente 2 argumentos')
    }
    return String(args[0]).toLowerCase().includes(String(args[1]).toLowerCase())
  },
  matches: (args) => {
    if (args.length !== 2) {
      throw new RuleError('matches espera exatamente 2 argumentos')
    }
    try {
      return new RegExp(String(args[1]), 'i').test(String(args[0]))
    } catch {
      // Regex imprestável é regra quebrada, não um "não casou": devolver false
      // enfraqueceria em silêncio um deny — o throw é o único significado
      // seguro, e quem chama já o trata como fail-closed.
      throw new RuleError(`matches: padrão inválido ${JSON.stringify(String(args[1]))}`)
    }
  },
}

/* --------------------------------- parser --------------------------------- */

class Parser {
  #tokens: Token[]
  #i = 0

  constructor(tokens: Token[]) {
    this.#tokens = tokens
  }

  #olhar(): Token {
    return this.#tokens[this.#i]!
  }

  #comer(): Token {
    return this.#tokens[this.#i++]!
  }

  #esperarOp(text: string): void {
    const token = this.#comer()
    if (token.kind !== 'op' || token.text !== text) {
      throw new RuleError(
        `regra ilegível: esperava ${JSON.stringify(text)} e veio ${JSON.stringify(token.text)} (posição ${token.pos})`,
      )
    }
  }

  /** ou → e ('||' e)*  — || liga mais fraco que && (a precedência do CEL). */
  ou(): No {
    let esquerda = this.e()
    while (this.#olhar().kind === 'op' && this.#olhar().text === '||') {
      this.#comer()
      esquerda = { tipo: 'ou', esquerda, direita: this.e() }
    }
    return esquerda
  }

  e(): No {
    let esquerda = this.unario()
    while (this.#olhar().kind === 'op' && this.#olhar().text === '&&') {
      this.#comer()
      esquerda = { tipo: 'e', esquerda, direita: this.unario() }
    }
    return esquerda
  }

  unario(): No {
    if (this.#olhar().kind === 'op' && this.#olhar().text === '!') {
      this.#comer()
      return { tipo: 'nao', alvo: this.unario() }
    }
    return this.comparacao()
  }

  comparacao(): No {
    const esquerda = this.operando()
    const proximo = this.#olhar()
    if (proximo.kind === 'op' && (proximo.text === '==' || proximo.text === '!=')) {
      this.#comer()
      return {
        tipo: 'compara',
        op: proximo.text as '==' | '!=',
        esquerda,
        direita: this.operando(),
      }
    }
    return esquerda
  }

  operando(): No {
    const token = this.#comer()
    if (token.kind === 'string') return { tipo: 'literal', valor: token.text }
    if (token.kind === 'number') {
      const valor = Number(token.text)
      if (Number.isNaN(valor)) {
        throw new RuleError(`regra ilegível: número inválido ${JSON.stringify(token.text)}`)
      }
      return { tipo: 'literal', valor }
    }
    if (token.kind === 'op' && token.text === '(') {
      const dentro = this.ou()
      this.#esperarOp(')')
      return dentro
    }
    if (token.kind === 'ident') {
      if (token.text === 'true') return { tipo: 'literal', valor: true }
      if (token.text === 'false') return { tipo: 'literal', valor: false }
      if (token.text === 'null') return { tipo: 'literal', valor: null }

      // Chamada de função: ident '(' args ')'. Função desconhecida é erro de
      // PARSE — a regra inteira é recusada na leitura, visitada ou não.
      if (this.#olhar().kind === 'op' && this.#olhar().text === '(') {
        if (FUNCOES[token.text] === undefined) {
          throw new RuleError(`regra ilegível: função desconhecida ${JSON.stringify(token.text)}`)
        }
        this.#comer() // '('
        const args: No[] = []
        if (!(this.#olhar().kind === 'op' && this.#olhar().text === ')')) {
          for (;;) {
            args.push(this.ou())
            if (this.#olhar().kind === 'op' && this.#olhar().text === ',') {
              this.#comer()
              continue
            }
            break
          }
        }
        this.#esperarOp(')')
        return { tipo: 'chamada', nome: token.text, args }
      }

      // Caminho: ident ('.' ident)*.
      const partes = [token.text]
      while (this.#olhar().kind === 'op' && this.#olhar().text === '.') {
        this.#comer()
        const parte = this.#comer()
        if (parte.kind !== 'ident') {
          throw new RuleError(
            `regra ilegível: esperava um nome depois de '.' e veio ${JSON.stringify(parte.text)}`,
          )
        }
        partes.push(parte.text)
      }
      return { tipo: 'caminho', partes }
    }
    throw new RuleError(
      `regra ilegível: esperava um valor e veio ${JSON.stringify(token.text)} (posição ${token.pos})`,
    )
  }

  /** A expressão inteira — e NADA pode sobrar depois dela. */
  expressao(): No {
    const raiz = this.ou()
    const resto = this.#olhar()
    if (resto.kind !== 'fim') {
      throw new RuleError(
        `regra ilegível: sobrou ${JSON.stringify(resto.text)} depois da expressão (posição ${resto.pos})`,
      )
    }
    return raiz
  }
}

/* -------------------------------- avaliação -------------------------------- */

/**
 * Resolve `a.b.c` no contexto. QUALQUER degrau ausente é erro — a decisão de
 * segurança nº 1 do cabeçalho: regra que nomeia um campo que a chamada não
 * trouxe falha (e falha fecha), nunca vira undefined mudo.
 */
function resolverCaminho(partes: string[], contexto: Record<string, unknown>): unknown {
  let atual: unknown = contexto
  for (const parte of partes) {
    if (atual === null || typeof atual !== 'object' || !(parte in (atual as object))) {
      throw new RuleError(`identificador desconhecido na regra: ${partes.join('.')}`)
    }
    atual = (atual as Record<string, unknown>)[parte]
  }
  if (atual === undefined) {
    throw new RuleError(`identificador sem valor na regra: ${partes.join('.')}`)
  }
  return atual
}

function avaliarNo(no: No, contexto: Record<string, unknown>): unknown {
  switch (no.tipo) {
    case 'literal':
      return no.valor
    case 'caminho':
      return resolverCaminho(no.partes, contexto)
    case 'chamada':
      return FUNCOES[no.nome]!(no.args.map((arg) => avaliarNo(arg, contexto)))
    case 'nao':
      return avaliarNo(no.alvo, contexto) !== true
    case 'compara': {
      // Igualdade ESTRITA: as regras do produto comparam texto com texto, e
      // coerção implícita (1 == "1") é a família de surpresa que um portão
      // não pode ter.
      const esquerda = avaliarNo(no.esquerda, contexto)
      const direita = avaliarNo(no.direita, contexto)
      return no.op === '==' ? esquerda === direita : esquerda !== direita
    }
    case 'e': {
      // Curto-circuito ABSORVE erro de resolução do ramo não visitado (o
      // comportamento do CEL que o guarda `tool.name == "…" && key == "…"`
      // exige): esquerda falsa decide sem olhar a direita. Sintaxe quebrada
      // do ramo direito JÁ falhou no parse — o que se absorve aqui é só
      // "este campo não existe nesta chamada".
      const esquerda = avaliarNo(no.esquerda, contexto)
      if (esquerda !== true) return false
      return avaliarNo(no.direita, contexto) === true
    }
    case 'ou': {
      const esquerda = avaliarNo(no.esquerda, contexto)
      if (esquerda === true) return true
      return avaliarNo(no.direita, contexto) === true
    }
  }
}

/**
 * Avalia UMA expressão de regra contra o contexto. Lança RuleError para tudo
 * que não puder ser respondido com verdade — sintaxe quebrada, identificador
 * ausente fora de curto-circuito, função desconhecida, regex inválida. O
 * chamador (o govern do chassis) traduz o erro para o fail-closed da lista:
 * deny quebrado nega, allow quebrado não permite.
 */
export function evaluateRule(expression: string, context: Record<string, unknown>): unknown {
  const limpa = expression.trim()
  if (limpa === '') {
    throw new RuleError('regra vazia não decide nada — escreva a expressão ou remova a linha')
  }
  // Parse INTEIRO antes de qualquer avaliação — ver o cabeçalho: sintaxe
  // quebrada falha mesmo no ramo que o curto-circuito não visitaria.
  const raiz = new Parser(tokenizar(limpa)).expressao()
  return avaliarNo(raiz, context)
}
