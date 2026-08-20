/**
 * As constantes CALIBRADAS da cascata — copiadas VALOR a VALOR do oráculo Go
 * (internal/supervisor). Nenhuma delas é rechutável: cada uma foi medida com
 * sonda ou calibrada por harness, e os golden tests vigiam exatamente estes
 * números. Mexer aqui sem recalibrar é mexer no roteamento às cegas.
 */

/** Confiança mínima para o léxico decidir sozinho. */
export const MIN_CONFIDENCE = 0.55

/**
 * Distância mínima até o segundo colocado. Sem margem, "revisa a segurança
 * desse código" seria decidido por diferença de um radical — e a mesma frase
 * cairia em especialistas diferentes conforme a redação.
 */
export const MIN_MARGIN = 0.15

/**
 * Onde a pontuação bruta vira confiança 1.0. Calibrado para que um radical
 * específico (>=8 letras) e um genérico juntos cheguem perto do limiar, e
 * dois específicos passem com folga.
 */
export const SATURATION = 26.0

/**
 * Confiança mínima para aceitar o veredito do modelo local. 0.78 é o limiar
 * CALIBRADO pelo harness de pesquisa (needle-router-pro/config/router.json,
 * `confidence_threshold`), medido sobre holdout — não um chute redondo. O
 * modo é gravado na conversa e não se reavalia: empurrar o caso duvidoso para
 * o modelo grande custa segundos uma vez; errar o modo custa a conversa toda.
 */
export const NEEDLE_MIN_CONFIDENCE = 0.78

/**
 * Quantos candidatos são declarados ao Needle. Cinco porque é onde o Needle 2
 * renderiza as ferramentas DIRETO na gramática; acima disso ele liga a
 * recuperação por embedding e escolhe sozinho, com menos informação.
 */
export const NEEDLE_TOOL_BUDGET = 5

/** Bônus de casar como PALAVRA inteira ("sql", "erd" têm 3 letras e decidem). */
export const WHOLE_WORD_WEIGHT = 2.2

/** Casar só no começo da palavra é mais fraco: é onde mora "cor" em "corta". */
export const WORD_START_WEIGHT = 1.5

/**
 * Peso de UM anexo reconhecido: 2 × saturação, porque a parcela de TEXTO
 * entra capada em `SATURATION` — com o dobro do teto, um anexo passa QUALQUER
 * pontuação de radical. Sem o cap não haveria peso que garantisse isso: a
 * soma léxica não tem teto teórico.
 */
export const ATTACHMENT_WEIGHT = 2 * SATURATION

/**
 * Peso de ser O QUE FOI PEDIDO. Alto o bastante para vencer disputa de
 * radicais (8 ÷ 26 já passa de 0,3 sozinho e soma por cima do léxico), porque
 * pedido × ingrediente não é questão de grau. NÃO dispensa a margem: dois
 * entregáveis no mesmo pedido continuam empatando, e empate sobe a cascata.
 */
export const DELIVERABLE_BONUS = 8.0

/**
 * Quantos BYTES depois do verbo ainda contam como "o que ele pediu". Cobre
 * "crie uma aplicação", "monte um portal de" — e para antes da subordinada
 * onde moram os ingredientes ("… com banco postgres").
 */
export const DELIVERABLE_WINDOW = 28

/** Confiança publicada quando NADA decidiu e a rota caiu no padrão. */
export const FALLBACK_CONFIDENCE = 0.25

/**
 * Verbos que anunciam um pedido de construção. Radicais, não palavras: "cri"
 * cobre crie/criar/criando. Curta de propósito — verbo genérico demais
 * ("faça") aparece em qualquer frase e viraria ruído constante.
 */
export const BUILD_VERBS: readonly string[] = [
  'cri', 'mont', 'constr', 'desenvolv', 'implement', 'ger', 'desenh', 'refaz', 'refac',
]

/**
 * Extensão do anexo → especialista dono do formato. Decisão de PRODUTO, não
 * detecção de MIME: quem manda um .docx quer trabalhar NO documento. Extensão
 * ambígua (json, md, html, css…) fica FORA de propósito — melhor descer a
 * cascata sem opinião do que errar com convicção.
 */
export const EXTENSION_OWNER: ReadonlyMap<string, string> = new Map(Object.entries({
  // Documentos de escritório: o artefato final é o arquivo binário.
  docx: 'office', pptx: 'office', xlsx: 'office', pdf: 'office', odt: 'office',
  // Dados: consulta, base e amostra.
  sql: 'data', db: 'data', csv: 'data',
  // Design: imagem — e vídeo, que por decisão de produto mora lá.
  png: 'design', jpg: 'design', jpeg: 'design', svg: 'design', fig: 'design',
  mp4: 'design', mov: 'design', webm: 'design', srt: 'design',
  // Código-fonte.
  go: 'code', rs: 'code', ts: 'code', tsx: 'code', py: 'code', js: 'code',
  jsx: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code',
  rb: 'code', php: 'code', kt: 'code', swift: 'code', sh: 'code', ps1: 'code',
  // Fine-tuning: dataset e pesos.
  jsonl: 'tune', gguf: 'tune', safetensors: 'tune',
}))

/**
 * Pontuação a partir da qual quem NÃO ganhou entra em espera por mérito
 * próprio. Mais baixa que MIN_CONFIDENCE de propósito: decidir exige
 * convicção; "este provavelmente tem trabalho aqui" só exige sinal claro.
 */
export const CAST_LEXICAL_MIN = 0.30

/** Mais que três bots em espera deixa de ser informação e vira enfeite. */
export const MAX_STANDBY = 3

/* ------------------------- intenção (pergunta × pedido) ------------------ */

/**
 * Aberturas de pergunta em português. Casam no COMEÇO da frase — no meio elas
 * mudam de função: "não sei como fazer isso" não é pergunta.
 */
export const QUESTION_OPENERS: readonly string[] = [
  'qual', 'quais', 'quando', 'onde', 'quem', 'quanto', 'quantos', 'quantas',
  'o que', 'oque', 'por que', 'porque', 'por quê', 'pra que', 'para que',
  'tem como', 'da pra', 'dá pra', 'da para', 'existe algum', 'existe alguma',
  'e possivel', 'é possível', 'vale a pena', 'faz sentido', 'devo', 'posso',
]

/**
 * Marcas de dúvida em QUALQUER posição. "como" fica de fora de propósito:
 * "como faço um deploy" é pedido disfarçado — quem separa é o verbo de ação.
 */
export const QUESTION_MARKERS: readonly string[] = [
  'duvida', 'dúvida', 'me explica', 'me explique', 'explica ai', 'explique',
  'significa', 'quer dizer', 'serve para', 'serve pra', 'diferenca entre',
  'diferença entre', 'funciona o', 'funciona a', 'funciona um', 'funciona uma',
  'sintaxe correta', 'forma correta', 'jeito certo', 'melhor pratica',
  'melhor prática', 'boa pratica', 'boa prática',
]

/**
 * Verbos que pedem TRABALHO sobre um artefato — a presença de um vence a
 * marca de pergunta. Duas armadilhas do português custaram um teste vermelho
 * no oráculo antes de virar comentário: radical que também é substantivo
 * ("compil", "test", "rod", "list", "busc" saíram — entram pela forma
 * conjugada) e verbo irregular ("corrij", porque corrigir muda g→j na
 * primeira pessoa).
 */
export const ACTION_VERBS: readonly string[] = [
  'cri', 'mont', 'constr', 'desenvolv', 'implement', 'gera', 'gere', 'gerar',
  'corrig', 'corrij', 'consert', 'arrum', 'refator', 'ajust', 'atualiz',
  'remov', 'apag', 'adicion', 'acrescent', 'escrev', 'redij', 'desenh',
  'revis', 'audit', 'otimiz', 'migr', 'instal', 'configur', 'public',
  'export', 'convert', 'traduz', 'execut', 'deplo', 'renomei', 'extrai',
  'resum', 'procur', 'analis', 'quebr', 'divid',
  // Formas conjugadas, para não pegar o substantivo homônimo.
  'rode', 'rodar', 'suba', 'subir', 'liste', 'listar', 'busque', 'buscar',
  'teste este', 'testa isso',
]

/** Tentativas do orchestrate() antes do fallback controlado (spec §7). */
export const ORCHESTRATE_MAX_ATTEMPTS = 2
