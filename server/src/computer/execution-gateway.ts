/**
 * O único caminho de uma ação até o navegador de uma EXECUÇÃO.
 *
 * [Onda 4 — a cirurgia central da spec §3] Este módulo é o que substitui o
 * gateway.ts + client.ts + supervisor.ts do chassis forkado do openbot. Lá a
 * chave era `botId → computador permanente`: todo bot tinha um browser que
 * sobrevivia entre turnos, provisionado por um supervisor (dockerode direto) que
 * o server segurava. Aqui a chave é OUTRA — o execution target do despacho
 * {taskRunId, workerId, leaseEpoch, runtimeId} — e o navegador é TASK-SCOPED
 * (§32): NASCE no `open` da execução e MORRE no `close`, falando com o NOSSO
 * agent-computer pelo seam `ctx.browser` (o plugin browser-runtime da M11). Bot
 * ocioso consome ZERO navegadores; não existe perfil permanente por bot.
 *
 * Quem provisiona compute é o control plane (worker-daemon/scheduler), não o
 * server — por isso não há mais supervisor aqui. O server só GOVERNA o que a
 * execução faz no browser que o despacho já lhe deu.
 *
 * As três garantias que o gateway do openbot tinha continuam, portadas para a
 * chave nova (e reprovadas nos testes desta onda):
 *
 *  1. Resolve a ref que o chamador mandou para o elemento a que ela aponta, a
 *     partir do snapshot que ESTE server buscou — nunca do rótulo que o modelo
 *     disse estar clicando. "Nunca clique em Submit" não se burla mandando
 *     {ref:"e13", name:"Continuar"}: a ref é opaca justamente para o server
 *     segurar o mapa.
 *  2. Pergunta à política (o Gate, via evaluateActionPolicy). Deny vence allow,
 *     política ausente nega, regra quebrada nega.
 *  3. Grava a linha ANTES de agir, seja qual for a decisão. Ação não gravada
 *     não aconteceu — não há caminho que aja sem escrever a linha primeiro.
 *
 * E a garantia nova da onda: enquanto uma PESSOA segura o volante (Take the
 * Wheel), a ação do bot é RECUSADA (não enfileirada) — a semântica do
 * control.ts do agent-computer chega até aqui como um `HumanControlError`, e a
 * recusa vira linha de auditoria própria.
 */

import type { Context } from "@aibot2/harness-kernel";
import type {
  BrowserControlState,
  BrowserElement,
  BrowserLease,
  BrowserRuntimeService,
  BrowserSnapshot,
  ExecutionTarget,
} from "@aibot2/plugin-browser-runtime";
import { BrowserComputerError } from "@aibot2/plugin-browser-runtime";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
} from "./policy";

/** Recusa de política: a regra funcionou, não é falha. Carrega qual regra decidiu. */
export class ActionRefusedError extends Error {
  /** A expressão que recusou, para a tela mostrar qual e um operador achar a regra. */
  readonly rule: string | null;

  constructor(reason: string, rule: string | null) {
    super(reason);
    this.name = "ActionRefusedError";
    this.rule = rule;
  }
}

/**
 * O bot tentou agir com uma PESSOA no volante. Distinta de recusa de política:
 * nada decidiu contra o bot, é o Take the Wheel — a ação foi recusada, nunca
 * enfileirada, porque um clique guardado aterrissaria em cima do que a pessoa faz.
 */
export class HumanControlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HumanControlError";
  }
}

/** A execução pediu algo num runtime que não está aberto (ou já fechou). */
export class SessionUnknownError extends Error {
  constructor(runtimeId: string) {
    super(
      `Nenhuma sessão de navegador aberta para o runtime ${runtimeId}. ` +
        "O browser é task-scoped: abra a execução antes de agir nela.",
    );
    this.name = "SessionUnknownError";
  }
}

/** Quem está pedindo. O gateway REGISTRA isto; não decide. */
export type ActionActor = {
  /** A pessoa autenticada, ou o ator local quando não há autenticação configurada. */
  id: string;
  /** Nulo a menos que seja uma linha real em `users` — a auditoria tem FK para ela. */
  userId?: string;
};

/** As kinds que o agent-computer entende (o /act). Sem scroll/screenshot/files nesta leva. */
export type ActInput = {
  kind: "click" | "type" | "press";
  ref?: string;
  snapshotId?: number;
  /** Só para `type`. NUNCA entra na auditoria (é onde senha mora). */
  text?: string;
  submit?: boolean;
  /** Só para `press`. */
  key?: string;
};

export type ExecutionGatewayOptions = {
  /** O seam task-scoped do kernel: abre/fecha o navegador da execução. */
  browser: BrowserRuntimeService;
  auditStore: AuditStore;
  /** Ausente nega tudo. Ver evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
};

/** O pedido de abertura: o target do despacho + o plano congelado da TaskRun. */
export type OpenExecutionRequest = {
  target: ExecutionTarget;
  /** Os requirements COMO A TAREFA OS DECLAROU — o browser-runtime relê com a régua do scheduler. */
  requirements?: Record<string, unknown>;
  /**
   * Quem a política vê como sujeito da regra: o ESPECIALISTA (ofício), não um
   * bot. Ausente cai no taskRunId — a execução é o sujeito. É a chave do §4.7:
   * grant por especialista, nunca por botId.
   */
  subject?: string;
};

/** O snapshot que o server segura por runtime — some quando o processo reinicia (descreve a janela viva). */
type CachedSnapshot = {
  snapshotId: number;
  url: string;
  elements: Map<string, BrowserElement>;
};

type Session = {
  target: ExecutionTarget;
  subject: string;
  lease: BrowserLease;
  snapshot?: CachedSnapshot;
};

export function createExecutionComputerGateway(
  options: ExecutionGatewayOptions,
) {
  const { browser, auditStore } = options;
  /** As sessões vivas, por runtimeId — a chave da execução, nunca um bot. */
  const sessions = new Map<string, Session>();

  function require(runtimeId: string): Session {
    const session = sessions.get(runtimeId);
    if (session === undefined) throw new SessionUnknownError(runtimeId);
    return session;
  }

  /**
   * Abre o navegador da execução — o browser NASCE aqui.
   *
   * `owner` é o Context de quem executa a TaskRun: o browser-runtime pendura o
   * close como disposer NELE, então o fim da execução (unload do escopo) fecha o
   * contexto DE VERDADE sem ninguém lembrar de chamar close. É o oposto exato do
   * computador permanente do openbot.
   */
  async function open(
    request: OpenExecutionRequest,
    owner?: Context,
  ): Promise<ExecutionTarget> {
    const lease = await browser.open(
      {
        target: request.target,
        ...(request.requirements !== undefined
          ? { requirements: request.requirements }
          : {}),
      },
      owner,
    );
    const runtimeId = lease.target.runtimeId;
    sessions.set(runtimeId, {
      target: lease.target,
      subject: request.subject ?? lease.target.taskRunId,
      lease,
    });
    await recordAuditEvent(auditStore, {
      eventType: "computer.session_opened",
      targetType: "computer",
      targetId: runtimeId,
      payload: {
        ...targetPayload(lease.target),
        subject: request.subject ?? lease.target.taskRunId,
      },
    });
    return lease.target;
  }

  /** Read-only, passa direto — nada mudou e não há o que decidir. Atualiza o cache do server. */
  async function snapshot(runtimeId: string): Promise<BrowserSnapshot> {
    const session = require(runtimeId);
    const result = await session.lease.snapshot();
    session.snapshot = {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(result.elements.map((element) => [element.ref, element])),
    };
    return result;
  }

  /**
   * Resolve a ref contra o snapshot que O SERVER segura.
   *
   * Devolve undefined para ref desconhecida em vez de lançar, porque a política
   * ainda precisa rodar: uma ação sobre um elemento que não conseguimos
   * identificar deve mesmo assim receber uma decisão.
   */
  function resolve(
    session: Session,
    ref: string | undefined,
  ): BrowserElement | undefined {
    if (!ref) return undefined;
    return session.snapshot?.elements.get(ref);
  }

  /**
   * Decide, grava, então age — a ordem é o produto inteiro.
   *
   * A linha de auditoria é escrita ANTES da ação, não depois do sucesso: uma
   * ação permitida que depois falha ainda faz parte da sequência, e uma trilha
   * que só contém sucessos não consegue mostrar essa sequência.
   */
  async function govern<T>(
    session: Session,
    toolName: string,
    actor: ActionActor,
    subject: { ref?: string; targetUrl?: string; key?: string },
    run: () => Promise<T>,
  ): Promise<T> {
    const element = resolve(session, subject.ref);
    // Para uma navegação a página relevante é a que está sendo ABERTA, não a já
    // carregada — senão `page.host == "..."` jamais casaria com o destino, que é
    // a única coisa que uma regra sobre navegação quer dizer.
    const pageUrl = subject.targetUrl ?? session.snapshot?.url ?? "";
    const intent = intentOf(toolName, subject.key);

    const context: PolicyContext = {
      tool: { name: toolName },
      // O sujeito da regra é o ESPECIALISTA/execução, nunca um botId permanente.
      bot: { id: session.subject },
      actor: { id: actor.id },
      page: { url: pageUrl, host: hostOf(pageUrl) },
      ...(intent ? { intent } : {}),
      ...(subject.key ? { key: subject.key } : {}),
      ...(element
        ? {
            element: {
              ref: element.ref,
              role: element.role,
              name: element.name,
            },
          }
        : {}),
    };

    const decision = evaluateActionPolicy(options.policy(), context);
    await write(auditStore, {
      toolName,
      session,
      actor,
      element,
      ref: subject.ref,
      ...(subject.key ? { key: subject.key } : {}),
      pageUrl,
      decision,
    });

    if (!decision.forward) {
      throw new ActionRefusedError(decision.reason, decision.matched);
    }

    let result: T;
    try {
      result = await run();
    } catch (error) {
      // Take the Wheel: uma pessoa está com o volante. NÃO é falha do bot nem
      // recusa de política — é o handover recusando a ação na hora (nunca
      // enfileirando). Linha própria e erro próprio, para o bot esperar e
      // explicar em vez de insistir.
      if (error instanceof BrowserComputerError && error.humanHasControl) {
        await recordAuditEvent(auditStore, {
          eventType: "computer.action_blocked_by_human",
          targetType: "computer",
          targetId: session.target.runtimeId,
          ...(actor.userId ? { actorUserId: actor.userId } : {}),
          payload: {
            action: toolName,
            ...targetPayload(session.target),
            subject: session.subject,
            actor: actor.id,
            page: pageUrl,
            reason: "Uma pessoa está no controle deste computador agora.",
          },
        });
        throw new HumanControlError(error.message);
      }
      // Ação permitida que NÃO aconteceu ganha a própria linha: sem isto a
      // trilha mente por omissão (a linha acima diz "permitido", e "permitido"
      // se lê como "aconteceu").
      await write(auditStore, {
        toolName,
        session,
        actor,
        element,
        ref: subject.ref,
        pageUrl,
        decision,
        failure: error instanceof Error ? error.message : "A ação falhou.",
      });
      throw error;
    }

    // O rótulo do elemento, anexado na saída, para o transcript dizer no que se
    // agiu em vez de citar uma ref. O computador não fornece isso: ele conhece a
    // ref, e o snapshot resolvido mora aqui.
    return element && result && typeof result === "object"
      ? { ...result, element: { role: element.role, name: element.name } }
      : result;
  }

  return {
    open,
    snapshot,

    /** Abrir uma página, pela porta da auditoria e da política. */
    navigate(runtimeId: string, actor: ActionActor, url: string) {
      const session = require(runtimeId);
      return govern(session, "computer_navigate", actor, { targetUrl: url }, () =>
        session.lease.navigate(url),
      );
    },

    /**
     * Agir por ref (click/type/press) — governado.
     *
     * O texto de um `type` NUNCA vai para a auditoria (é onde senha mora); a
     * garantia é a mesma do gateway do openbot e é reprovada em teste.
     */
    act(runtimeId: string, actor: ActionActor, input: ActInput) {
      const session = require(runtimeId);
      const toolName =
        input.kind === "click"
          ? "computer_click"
          : input.kind === "type"
            ? "computer_type"
            : "computer_key";
      return govern(
        session,
        toolName,
        actor,
        {
          ...(input.ref ? { ref: input.ref } : {}),
          ...(input.key ? { key: input.key } : {}),
        },
        () =>
          session.lease.act({
            kind: input.kind,
            ...(input.ref ? { ref: input.ref } : {}),
            ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
            ...(input.text !== undefined ? { text: input.text } : {}),
            ...(input.submit !== undefined ? { submit: input.submit } : {}),
            ...(input.key ? { key: input.key } : {}),
          }),
      );
    },

    /** Quem está com o volante — o que a UI forkada mostra como cartão. Leitura, sem linha. */
    control(runtimeId: string): Promise<BrowserControlState> {
      return require(runtimeId).lease.control();
    },

    /**
     * Os handovers, gravados mas NÃO barrados por política. A política limita o
     * que um BOT faz; uma pessoa assumindo o volante é a válvula de escape que
     * torna um bot governado utilizável — uma regra capaz de trancar alguém para
     * fora do próprio browser no meio de um login seria pior que tudo que ela
     * impede. Então estes gravam a linha e não perguntam.
     */
    async requestHelp(runtimeId: string, actor: ActionActor, reason: string) {
      const session = require(runtimeId);
      const state = await session.lease.requestControl(reason);
      await writeControlEvent(auditStore, "computer.help_requested", session, actor, reason);
      return state;
    },

    async takeControl(runtimeId: string, actor: ActionActor) {
      const session = require(runtimeId);
      const state = await session.lease.takeControl();
      await writeControlEvent(
        auditStore,
        "computer.control_taken",
        session,
        actor,
        state.reason,
      );
      return state;
    },

    async releaseControl(runtimeId: string, actor: ActionActor) {
      const session = require(runtimeId);
      const state = await session.lease.releaseControl();
      await writeControlEvent(auditStore, "computer.control_released", session, actor);
      return state;
    },

    /**
     * Fecha o navegador da execução — o browser MORRE aqui.
     *
     * Idempotente e seguro: o disposer do escopo do dono também fecha, então um
     * close explícito depois do fim da TaskRun é não-operação, nunca erro. A
     * linha `session_closed` fecha o par de `session_opened` — um par incompleto
     * na trilha É o alarme de perfil vazado.
     */
    async close(runtimeId: string): Promise<void> {
      const session = sessions.get(runtimeId);
      if (session === undefined) return;
      sessions.delete(runtimeId);
      await session.lease.close();
      await recordAuditEvent(auditStore, {
        eventType: "computer.session_closed",
        targetType: "computer",
        targetId: runtimeId,
        payload: targetPayload(session.target),
      });
    },

    /**
     * As execuções com navegador VIVO agora, para a presença/admin.
     *
     * Substitui o `computers()` per-bot do openbot: o que existe é uma lista de
     * EXECUÇÕES (task-scoped), não um catálogo de computadores permanentes. A
     * presença da UI (§4.7) se lê do estado observável da execução, não de um
     * Chromium permanente por bot.
     */
    sessions(): { runtimeId: string; target: ExecutionTarget; subject: string }[] {
      return [...sessions.values()].map((session) => ({
        runtimeId: session.target.runtimeId,
        target: session.target,
        subject: session.subject,
      }));
    },
  };
}

export type ExecutionComputerGateway = ReturnType<
  typeof createExecutionComputerGateway
>;

/** A tríade do despacho no payload — a chave de execução, legível na trilha. */
function targetPayload(target: ExecutionTarget): Record<string, unknown> {
  return {
    taskRunId: target.taskRunId,
    workerId: target.workerId,
    leaseEpoch: target.leaseEpoch,
    runtimeId: target.runtimeId,
  };
}

/**
 * O que uma ação FAZ, do que o gateway já sabe.
 *
 * Derivado aqui em vez de passado por cada call site, para uma rota de ação nova
 * não conseguir chegar sem intent e escapar de toda regra escrita em cima de uma.
 * Enter e Space ativam: pressionam o que estiver com foco, então uma regra sobre
 * ativação tem de cobrir tecla, não só clique.
 */
const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);

function intentOf(
  toolName: string,
  key: string | undefined,
): PolicyContext["intent"] {
  switch (toolName) {
    case "computer_click":
      return "activate";
    case "computer_key":
      return key && ACTIVATING_KEYS.has(key) ? "activate" : "type";
    case "computer_type":
      return "type";
    case "computer_navigate":
      return "navigate";
    default:
      return undefined;
  }
}

async function write(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    session: Session;
    actor: ActionActor;
    element: BrowserElement | undefined;
    ref: string | undefined;
    key?: string | undefined;
    pageUrl: string;
    decision: PolicyDecision;
    failure?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType: entry.failure
      ? "computer.action_failed"
      : entry.decision.allowed
        ? "computer.action_allowed"
        : "computer.action_refused",
    targetType: "computer",
    targetId: entry.session.target.runtimeId,
    // Só uma linha real de users pode ir na FK. O ator local de desenvolvimento
    // não é uma — escrevê-lo aqui faz a linha inteira falhar na constraint. Quem
    // foi está no payload de qualquer jeito.
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      ...targetPayload(entry.session.target),
      subject: entry.session.subject,
      actor: entry.actor.id,
      page: entry.pageUrl,
      ref: entry.ref ?? null,
      ...(entry.key ? { key: entry.key } : {}),
      // Deliberadamente ausente: o texto digitado. `element.name` é rótulo que a
      // página mostra, não algo que a pessoa digitou — seguro e é a parte que o
      // investigador realmente precisa.
      element: entry.element
        ? { role: entry.element.role, name: entry.element.name }
        : "not in the current snapshot",
      ...(entry.failure ? { failure: entry.failure } : {}),
      decision: {
        allowed: entry.decision.allowed,
        mode: entry.decision.mode,
        source: entry.decision.source,
        rule: entry.decision.matched,
        carriedOut: entry.decision.forward,
      },
    },
  });
}

/** Uma linha para um handover — sem elemento, sem decisão de política. */
async function writeControlEvent(
  auditStore: AuditStore,
  eventType:
    | "computer.help_requested"
    | "computer.control_taken"
    | "computer.control_released",
  session: Session,
  actor: ActionActor,
  reason?: string,
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "computer",
    targetId: session.target.runtimeId,
    ...(actor.userId ? { actorUserId: actor.userId } : {}),
    payload: {
      ...targetPayload(session.target),
      subject: session.subject,
      actor: actor.id,
      ...(reason ? { reason } : {}),
    },
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
