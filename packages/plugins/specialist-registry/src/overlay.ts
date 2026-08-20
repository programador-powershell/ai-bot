/**
 * O overlay corporativo: um catálogo PUBLICADO por cima do compilado.
 *
 * O compilado continua sendo o padrão, e isso não é conservadorismo: o app tem
 * de abrir na PRIMEIRA execução, offline, antes de qualquer download existir.
 *
 * A regra dura é TUDO OU NADA: um overlay com UM especialista inválido é
 * recusado INTEIRO. Meio catálogo aplicado é pior que nenhum — a tela some
 * para metade dos ids já gravados nas conversas e o roteador passa a ter
 * candidatos que a interface não desenha.
 */

import {
  AVATAR_ACCESSORIES,
  AVATAR_EYES,
  AVATAR_MOTIONS,
  AVATAR_MOUTHS,
  AVATAR_SHAPES,
  DEFAULT_ID,
  MASTER_ID,
  RAILS,
  SURFACES,
  coerceDefinition,
  type Avatar,
  type Definition,
} from './definition.js'

/**
 * O contrato do documento publicado. Versão diferente é RECUSADA, inclusive
 * maior: registro antigo não sabe ler catálogo novo, e adivinhar o que fazer
 * com campo desconhecido é como se aplica meio catálogo sem perceber.
 */
export const OVERLAY_SCHEMA_VERSION = 1

/** O documento da trilha de publicação, já coagido para a forma interna. */
export interface Overlay {
  schemaVersion: number
  version: string
  /**
   * O catálogo COMPLETO, na ordem de exibição. Não é um patch: mesclar por id
   * daria dois catálogos diferentes em duas estações conforme o compilado de
   * cada uma, e o defeito só apareceria na estação errada.
   */
  specialists: Definition[]
}

/**
 * Recusa de overlay. `problems` lista TODOS os erros de uma vez: a recusa é
 * do documento inteiro de qualquer forma, e recusar no primeiro faria quem
 * publica descobrir os erros um por um, com uma publicação por descoberta.
 */
export class OverlayError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`overlay recusado: ${problems.join('; ')}`)
    this.name = 'OverlayError'
    this.problems = problems
  }
}

/**
 * Folgado para nome legível e curto o bastante para caber em seletor de CSS,
 * atributo de dado e chave de log sem virar linha própria.
 */
const MAX_ID_LENGTH = 40

/**
 * O id vira atributo HTML, seletor CSS e campo de log: espaço, aspas ou
 * maiúscula quebrariam seletor na interface — e a falha apareceria como
 * estilo sumido, não como catálogo inválido.
 */
export function validID(id: string): boolean {
  if (id === '' || id.length > MAX_ID_LENGTH) return false
  return /^[a-z0-9_-]+$/.test(id)
}

/** Coage o documento cru (string JSON ou objeto) para a forma interna. */
export function parseOverlay(raw: string | unknown): Overlay {
  let document: unknown = raw
  if (typeof raw === 'string') {
    try {
      document = JSON.parse(raw)
    } catch (error) {
      throw new OverlayError([`não é JSON válido: ${(error as Error).message}`])
    }
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new OverlayError(['o documento não é um objeto JSON'])
  }
  const src = document as Record<string, unknown>
  return {
    schemaVersion: typeof src.schemaVersion === 'number' ? src.schemaVersion : 0,
    version: typeof src.version === 'string' ? src.version : '',
    specialists: Array.isArray(src.specialists) ? src.specialists.map(coerceDefinition) : [],
  }
}

/**
 * Valida o documento inteiro e devolve a lista COMPLETA de problemas (vazia =
 * válido). As mensagens são acionáveis de propósito: quem publica precisa
 * saber o que consertar sem abrir o código deste arquivo.
 */
export function validateOverlay(
  document: Overlay,
  knownTool?: (name: string) => boolean,
): string[] {
  const problems: string[] = []
  const fail = (message: string): void => {
    problems.push(message)
  }

  if (document.schemaVersion !== OVERLAY_SCHEMA_VERSION) {
    // Sai aqui mesmo: com o esquema errado, todo campo abaixo pode significar
    // outra coisa, e apontar erro de campo seria adivinhação.
    return [`esquema ${document.schemaVersion}, este registro lê ${OVERLAY_SCHEMA_VERSION}`]
  }
  if (document.version.trim() === '') {
    fail('sem `version` — é ela que aparece no diagnóstico como o catálogo em vigor')
  }
  if (document.specialists.length === 0) {
    fail('sem especialista nenhum — catálogo vazio é a tela sem nada para escolher')
  }

  const seen = new Set<string>()
  for (const [position, definition] of document.specialists.entries()) {
    let where = `especialista na posição ${position}`
    if (definition.id !== '') {
      where = `especialista "${definition.id}"`
    }

    if (definition.id === '') {
      fail(`${where}: sem \`id\` — o id é a chave do roteamento e do modo gravado na conversa`)
    } else if (!validID(definition.id)) {
      fail(`${where}: \`id\` fora do formato (minúsculas, dígitos, \`-\` e \`_\`, até ${MAX_ID_LENGTH} caracteres)`)
    } else if (definition.id === MASTER_ID) {
      fail(`${where}: \`${MASTER_ID}\` é reservado ao roteador e não entra no catálogo`)
    } else if (seen.has(definition.id)) {
      fail(`${where}: \`id\` repetido — o segundo esconderia o primeiro no índice`)
    } else {
      seen.add(definition.id)
    }

    if (definition.name.trim() === '') {
      fail(`${where}: sem \`name\` — é o rótulo do seletor e da barra`)
    }
    if (definition.system.trim() === '') {
      fail(`${where}: sem \`system\` — especialista sem prompt não tem comportamento nenhum`)
    }
    if (!SURFACES.has(definition.surface)) {
      fail(`${where}: superfície "${definition.surface}" não existe nesta interface`)
    }
    if (!RAILS.has(definition.rail)) {
      fail(`${where}: trilho "${definition.rail}" não existe nesta interface`)
    }
    if (definition.hue < 0 || definition.hue > 360) {
      fail(`${where}: \`hue\` ${definition.hue} fora de 0..360`)
    }

    validateAvatar(where, definition.avatar, fail)

    for (const tool of definition.tools) {
      if (tool.trim() === '') {
        fail(`${where}: ferramenta em branco`)
        continue
      }
      if (knownTool !== undefined && !knownTool(tool)) {
        fail(`${where}: a ferramenta "${tool}" não existe neste registro — o modelo passaria o turno pedindo o que ninguém executa`)
      }
    }
    for (const trigger of definition.triggers) {
      if (trigger.trim() === '') {
        fail(`${where}: radical em branco — casaria com qualquer texto`)
      }
    }
    for (const action of definition.actions) {
      if (action.id.trim() === '' || action.label.trim() === '') {
        fail(`${where}: atalho sem \`id\` ou sem \`label\``)
      }
      if (action.insert.trim() === '') {
        fail(`${where}: atalho "${action.id}" não insere nada no campo`)
      }
    }
  }

  // O padrão precisa existir NESTE catálogo: getOrDefault cai nele, e um
  // padrão ausente devolveria definição zerada — superfície vazia, tela
  // branca, para toda conversa com um id que o overlay não trouxe.
  if (document.specialists.length > 0 && !seen.has(DEFAULT_ID)) {
    fail(`o catálogo não tem "${DEFAULT_ID}", que é para onde cai todo id desconhecido`)
  }

  return problems
}

function validateAvatar(where: string, avatar: Avatar, fail: (message: string) => void): void {
  // O desenho é um switch sem default no cliente: parte desconhecida não é
  // "avatar diferente" — é avatar que não aparece.
  if (!AVATAR_SHAPES.has(avatar.shape)) {
    fail(`${where}: avatar com forma "${avatar.shape}", que o desenho não conhece`)
  }
  if (!AVATAR_EYES.has(avatar.eyes)) {
    fail(`${where}: avatar com olhos "${avatar.eyes}", que o desenho não conhece`)
  }
  if (!AVATAR_MOUTHS.has(avatar.mouth)) {
    fail(`${where}: avatar com boca "${avatar.mouth}", que o desenho não conhece`)
  }
  if (!AVATAR_ACCESSORIES.has(avatar.accessory)) {
    fail(`${where}: avatar com acessório "${avatar.accessory}", que o desenho não conhece`)
  }
  if (!AVATAR_MOTIONS.has(avatar.motion)) {
    fail(`${where}: avatar com movimento "${avatar.motion}", que o desenho não conhece`)
  }
  if (avatar.hue < 0 || avatar.hue > 360) {
    fail(`${where}: \`avatar.hue\` ${avatar.hue} fora de 0..360`)
  }
  if (avatar.saturation < 0 || avatar.saturation > 100) {
    fail(`${where}: \`avatar.saturation\` ${avatar.saturation} fora de 0..100`)
  }
}
