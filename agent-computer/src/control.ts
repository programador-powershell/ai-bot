/**
 * Quem está com o volante — porte adaptado de agent-computer/src/control.ts do
 * openbot (MIT, pin 06a1a84; ver THIRD_PARTY_NOTICES.md).
 *
 * Um browser tem no máximo UM motorista. Quando o bot esbarra numa parede de
 * login ele pede ajuda; uma pessoa assume, faz a parte que só ela pode fazer e
 * devolve. Enquanto a pessoa segura o volante, TODA ação do bot é RECUSADA —
 * nunca enfileirada: um clique enfileirado aterrissa depois que a pessoa já
 * seguiu em frente, em cima de um formulário que ela ainda estava preenchendo.
 * Recusa o bot consegue explicar e esperar; clique atrasado ninguém desfaz.
 *
 * O estado mora NESTE processo (não no control plane) porque este processo é
 * quem segura o browser: um takeover que o browser não conhece não é takeover.
 * O server registra e decide QUEM pode pedir; aqui se decide se a PRÓXIMA ação
 * acontece.
 *
 * A cirurgia do AI-BOT 2: no openbot o controle era por BOT (botId→computador
 * permanente); aqui cada TaskRun com requirements.browser=true ganha o próprio
 * contexto, então o controle é POR SESSÃO de runtime — criado no open, morto
 * no close.
 *
 * Este módulo não importa Playwright: a máquina de estados testa sem browser.
 */

export interface ControlState {
  holder: 'bot' | 'human'
  since: string
  /** Por que o bot pediu ajuda — a pessoa precisa saber o que está recebendo. */
  reason?: string
  /** True quando o bot pediu ajuda e ninguém assumiu ainda. */
  requested: boolean
  /**
   * Um segredo que o bot está esperando, descrito SÓ pelo rótulo.
   *
   * Entrada de segredo é escopada, não takeover completo: o bot nomeia o campo
   * e diz o que precisa; a pessoa digita numa caixa mascarada que vai direto
   * para a página. Só o RÓTULO mora aqui — o valor atravessa uma requisição e
   * não é guardado, não é devolvido e não passa por nenhum caminho que o
   * modelo leia.
   */
  secretWanted?: string
  /**
   * Em qual campo o segredo entra, como ref do snapshot do bot. Obrigatório:
   * um segredo não pode ir para "o campo que estiver com foco".
   */
  secretRef?: string
  secretSnapshotId?: number
}

/** Recusa porque uma pessoa está dirigindo. Distinta de falha: o bot espera. */
export class ControlError extends Error {
  override name = 'ControlError'
}

/** Pedido de segredo malformado. Vira erro de requisição, não exceção solta. */
export class ControlRequestError extends Error {
  override name = 'ControlRequestError'
}

export const HUMAN_HAS_CONTROL =
  'Uma pessoa está no controle deste computador agora. Espere ela devolver antes de agir.'

/**
 * O volante como máquina de estados.
 *
 * Fábrica em vez de `let` de módulo: cada sessão/teste tem a sua, e duas nunca
 * compartilham estado por acidente. `now` é injetado porque `since` faz parte
 * do estado publicado — teste que não controla o relógio pula a asserção.
 */
export function createControl(now: () => string = () => new Date().toISOString()) {
  let state: ControlState = {
    holder: 'bot',
    since: now(),
    requested: false,
  }

  return {
    /** O estado atual, como a superfície o consulta. CÓPIA — ninguém muta a máquina por fora. */
    get(): ControlState {
      return { ...state }
    },

    /**
     * O bot pedindo ajuda. NÃO toma o controle: diz que travou e por quê, e
     * uma pessoa decide. Um bot que pudesse se entregar a um humano também
     * poderia entregar ao humano uma página que ele nunca pediu para ver.
     */
    requestHelp(reason: unknown): ControlState {
      state = {
        ...state,
        requested: true,
        reason:
          typeof reason === 'string' && reason.trim() !== ''
            ? reason.trim()
            : 'O assistente precisa de uma pessoa para continuar.',
      }
      return this.get()
    },

    /** O bot pedindo UM valor que não pode saber, nomeando o campo de destino. */
    requestSecret(input: { label?: unknown; ref?: unknown; snapshotId?: unknown }): ControlState {
      if (typeof input.ref !== 'string' || input.ref.trim() === '') {
        throw new ControlRequestError(
          'Diga em qual campo o valor entra, usando uma ref do seu snapshot.',
        )
      }
      state = {
        ...state,
        secretWanted:
          typeof input.label === 'string' && input.label.trim() !== ''
            ? input.label.trim()
            : 'o valor que esta página está pedindo',
        secretRef: input.ref.trim(),
        ...(typeof input.snapshotId === 'number' ? { secretSnapshotId: input.snapshotId } : {}),
      }
      return this.get()
    },

    /**
     * O pedido de segredo pendente, ou null. Lido ANTES de digitar: é o que
     * impede a caixa mascarada de virar um jeito genérico de digitar na página.
     */
    pendingSecret(): { ref: string; snapshotId?: number } | null {
      if (state.secretWanted === undefined || state.secretRef === undefined) return null
      return {
        ref: state.secretRef,
        ...(state.secretSnapshotId !== undefined ? { snapshotId: state.secretSnapshotId } : {}),
      }
    },

    /**
     * O segredo aterrissou; o pedido fecha. Chamado só DEPOIS de o valor
     * chegar ao campo — falha deixa o pedido aberto para a pessoa tentar de
     * novo.
     */
    secretSupplied(): void {
      const { secretWanted: _w, secretRef: _r, secretSnapshotId: _s, ...rest } = state
      state = rest
    },

    /**
     * Uma pessoa assumindo o volante. O `reason` sobrevive (é a coisa que
     * acabaram de pedir a ela); segredo pendente é limpo — quem tem o browser
     * inteiro digita a senha na página, e uma caixa mascarada esquecida aberta
     * não corresponde mais a pedido nenhum.
     */
    take(): ControlState {
      state = {
        holder: 'human',
        since: now(),
        ...(state.reason !== undefined ? { reason: state.reason } : {}),
        requested: false,
      }
      return this.get()
    },

    /**
     * A pessoa devolvendo. O `reason` cai: descrevia o que pediram a ela, e
     * mantê-lo deixaria a superfície mostrando o pedido velho. Segredo
     * pendente vai junto pelo mesmo motivo.
     */
    release(): ControlState {
      state = {
        holder: 'bot',
        since: now(),
        requested: false,
      }
      return this.get()
    },

    /**
     * O bot NÃO age enquanto uma pessoa segura o volante. Recusado, nunca
     * enfileirado — o coração do Take the Wheel.
     */
    assertBotMayAct(): void {
      if (state.holder === 'human') throw new ControlError(HUMAN_HAS_CONTROL)
    },

    /** Se a entrada de uma pessoa deve ser aplicada. Socket aberto NÃO é permissão. */
    humanMayDrive(): boolean {
      return state.holder === 'human'
    },
  }
}

export type Control = ReturnType<typeof createControl>
