/*
 * O boot do chassis forkado do openbot (MIT — THIRD_PARTY_NOTICES.md), com as
 * três cirurgias da Onda 1 declaradas:
 *  - §4.6/R3: o mount do CopilotKit Intelligence NÃO sobe — o server nasce sem
 *    SaaS e sem degraded-mode fingido; copilot.ts fica fora do boot com prazo
 *    de morte (onda 2/3).
 *  - §4.4/R2: o banco do chassis é bun:sqlite (chassis.db) com migrações
 *    geradas aplicadas AQUI no boot; nenhuma rota Postgres viva.
 *  - O listener LISTEN/NOTIFY do Postgres virou anúncio in-process (um
 *    processo, um banco embutido) — ver channels/events.ts.
 * O restante preserva o desenho original: Bun.serve multiplexa fetch+upgrade,
 * o proxy do live screen termina a sessão aqui e disca para dentro com token.
 */
import { join } from "node:path";
import { serve } from "bun";
import { createAgentProfileStore } from "./agents/profile-store";
import { createApp } from "./app";
import { criarConversaDoCanal } from "./channels/conversa";
import { carregarConfig as carregarConfigDoStream } from "./montagem/config";
import {
  CAMINHO_DO_STREAM,
  TETO_DE_CONTRAPRESSAO_BYTES,
  criarStreamDoChassi,
  ehStreamDoChassi,
  type DadosDoStreamDoChassi,
} from "./stream/transporte";
import { createAuditReader, createAuditStore, recordAuditEvent } from "./audit";
import { createAuth } from "./auth";
import { DEV_ACTOR, initializeDevActorUser } from "./auth/dev-actor";
import { createRoleRepository } from "./auth/guards";
import type { OpenBotRole } from "./auth/roles";
import {
  createChannelEventHub,
  createInProcessAnnouncer,
} from "./channels/events";
import { createChannelStore } from "./channels/routes";
import { createThreadIdentity } from "./channels/thread-identity";
import { websocket as channelSocket } from "./channels/socket";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import { createComputerClient } from "./computer/client";
import { createComputerGateway } from "./computer/gateway";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import { createSupervisorClient } from "./computer/supervisor";
import { loadConfig } from "./config";
import { createConnectorAdminService } from "./connectors";
import {
  createCredentialAdminService,
  createCredentialStore,
} from "./credentials";
import { createDatabase, migrateDatabase } from "./db/client";
import { CHASSIS_BOT_TOOLS, criarExecutorDoChassi } from "./governo/executor";
import { criarFunilDoChassi } from "./governo/funil";
import { montarNucleo } from "./montagem/montagem";
import { createPluginStore } from "./plugins/store";
import {
  createPackageStatusReader,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";

/**
 * Who is asking, for an authenticated upgrade (o proxy do live screen).
 *
 * One resolver, because a run has two questions to answer about the same person: whose threads and
 * memory these are, and which coworkers they may run. Answering them from different places is how
 * one person ends up running another's private coworker, or reading their thread.
 */
async function resolveRequestActor(request: Request): Promise<{
  id: string;
  name: string;
  role: OpenBotRole;
}> {
  if (config.devNoAuth) {
    return { id: DEV_ACTOR.id, name: DEV_ACTOR.email, role: DEV_ACTOR.role };
  }
  const session = await auth?.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new Error("This request requires a signed-in user.");
  }
  const roles = await roleRepository.rolesForUser(user.id);
  if (!roles.includes("admin") && !roles.includes("user")) {
    throw new Error("This request requires an authorized user.");
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? user.id,
    role: roles.includes("admin") ? "admin" : "user",
  };
}

/** A projeção usada pelo guard manual do upgrade (middleware não roda em upgrade). */
const identifyUser = async (request: Request) => {
  const { id, name } = await resolveRequestActor(request);
  return { id, name };
};

const config = loadConfig();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);

/*
 * [Onda 2→3] A config do stream é a MESMA do transporte de referência
 * (AIBOT_DATA_DIR/AIBOT_TOKEN/AIBOT_ALLOW_ORIGINS, token materializado no
 * primeiro boot): é o que deixa o desktop Tauri atual e o app forkado discarem
 * O MESMO server com o mesmo segredo (compat dupla). O event log e o session
 * bus agora nascem DENTRO do kernel (montagem completa, mais abaixo) — o
 * stream é criado depois dos stores do chassis, porque o executor do funil
 * precisa deles.
 */
const configDoStream = carregarConfigDoStream();

const database = createDatabase(config.databaseUrl);
// Migrações geradas, aplicadas no boot: um deployment novo começa do zero e o
// schema que vale é o gerado — nunca DDL improvisada (§4.4).
migrateDatabase(database);
await initializeDevActorUser(database, config.devNoAuth);
// The vault, built before the agent store because a customer's agent may sit behind a key and that
// key belongs here rather than on the agent row. See agents/auth-header.ts.
const credentialStore = createCredentialStore(database);
const agentVault = {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: config.keyEncryptionKey,
};
const agentProfileStore = createAgentProfileStore(
  database,
  config.managedAgentAgUiUrl,
  agentVault,
);
// Read here rather than beside the synchronise below, because the package names the deployment and
// the channel store needs that name before it can mint a thread id.
const tenantPackage = await loadTenantPackage(config.tenantPackageDirectory);
const threadIdentity = createThreadIdentity(
  config.deploymentId ?? tenantPackage.tenantId,
);
const channelEvents = createChannelEventHub();
const channelStore = createChannelStore(
  database,
  agentProfileStore,
  threadIdentity,
  // In-process, de propósito: quem grava atividade anuncia no hub deste
  // processo (o que o pg_notify fazia entre instâncias). Ver channels/events.ts.
  createInProcessAnnouncer(channelEvents),
);
/**
 * Which components each Bot may answer with.
 *
 * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
 * of its own should start with four rows, and the only thing that can enumerate them is
 * the app that compiled them. It announces itself on load; this process learns what exists from that,
 * and owns only what may be done with it.
 */
const componentStore = createComponentStore(database);
const roleRepository = createRoleRepository(database);
await synchronizeTenantPackage(database, tenantPackage);
const auth = config.auth ? createAuth(config, database) : undefined;
// One computer each, when a supervisor is configured to give them out. Without one every Bot shares
// the computer at `baseUrl`, which is what a laptop wants and is honest about being one machine.
const supervisor = config.computer?.supervisor
  ? createSupervisorClient(config.computer.supervisor)
  : undefined;
const computerClient = config.computer
  ? createComputerClient({
      baseUrl: config.computer.baseUrl,
      allowPrivateHosts: config.computer.allowPrivateHosts,
      ...(config.computer.token ? { token: config.computer.token } : {}),
      ...(supervisor
        ? { resolveBaseUrl: (botId: string) => supervisor.locate(botId) }
        : {}),
    })
  : undefined;
// What Bots may do on their computers. Configuration supplies the deployment's default; an
// administrator can change it while running, and a restart returns to the configured one.
const policyStore = createPolicyStore(
  config.computer?.policy ?? DEFAULT_ACTION_POLICY,
  database,
);
// A boundary an administrator set is read back before the first action is decided, so a restart no
// longer silently returns to the configured default.
const policySource = await policyStore.load();

/*
 * Record which boundary this process started with.
 *
 * The trail records the boundary a process starts with, so later audit reads can distinguish the
 * configured default from any administrator-updated policy that was persisted before restart.
 *
 * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
 * unavailable, and the row is a note for a reader rather than something the server depends on.
 */
const bootAuditStore = createAuditStore(database);

/**
 * What a Bot can reach beyond its own computer.
 *
 * Built here rather than beside the component store because it needs the policy, and it needs the
 * same policy the computer gateway enforces rather than one of its own. A deployment that has said
 * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
 * the change would arrive through a browser or through a tool call.
 */
const sandboxedStore = createSandboxedStore(database, bootAuditStore);

const pluginStore = createPluginStore({
  database,
  auditStore: bootAuditStore,
  credentials: credentialStore,
  encryptionKey: config.keyEncryptionKey,
  policy: () => policyStore.get(),
});

void recordAuditEvent(bootAuditStore, {
  eventType: "computer.policy_loaded",
  targetType: "policy",
  payload: {
    ...policyStore.get(),
    source:
      policySource === "the database"
        ? "an administrator, saved in this deployment"
        : config.computer?.policy
          ? "configuration"
          : "the built-in default",
    note:
      policySource === "the database"
        ? "Set while running and kept. A restart returns to this."
        : "The deployment default. Anything an administrator sets from here is kept.",
  },
}).catch(() => undefined);

/*
 * Record whether each Bot has a computer of its own.
 *
 * Without a supervisor every Bot shares the browser at `AGENT_COMPUTER_URL`. That is a fine way to
 * run on a laptop, but the shared isolation state must be visible rather than inferred.
 */
void recordAuditEvent(bootAuditStore, {
  eventType: "computer.isolation_loaded",
  targetType: "computer",
  payload: supervisor
    ? {
        isolation: "one computer per Bot",
        note: "Each Bot gets its own container, its own /workspace and its own browser profile.",
      }
    : {
        isolation: "one shared computer",
        note: "No supervisor is configured, so every Bot uses the same browser. Sessions, files and logins are shared between them. Set COMPUTER_SUPERVISOR_URL to give each Bot its own.",
      },
}).catch(() => undefined);

console.info(
  JSON.stringify({
    type: "computer-isolation",
    isolation: supervisor ? "one computer per Bot" : "one shared computer",
    ...(supervisor
      ? {}
      : {
          warning:
            "Every Bot shares one browser. Set COMPUTER_SUPERVISOR_URL for a computer each.",
        }),
  }),
);
/*
 * [Onda 3] A MONTAGEM COMPLETA: o kernel sobe com TODOS os plugins — os 7 que
 * estavam prontos e soltos + os seams declarados (montagem.ts) — e o chassis
 * entrega ao funil o executor REAL do que já existe aqui: mcp.call e
 * componentes generativos, decididos por chamada pelos grants do chassis.db.
 * O event log (events.db) e o session bus passam a ser os do kernel — a
 * fronteira do §4.4 continua: drizzle nunca toca neles.
 */
const nucleo = await montarNucleo(
  { dataDir: configDoStream.dataDir },
  {
    tools: criarExecutorDoChassi({
      pluginStore,
      componentStore,
      auditStore: bootAuditStore,
    }),
    chassisBotTools: CHASSIS_BOT_TOOLS,
    ...(config.computer
      ? {
          browser: {
            baseUrl: config.computer.baseUrl,
            token: config.computer.token ?? "",
          },
        }
      : {}),
    log: (mensagem, campos) => {
      console.warn(`[kernel] ${mensagem}`, campos ?? "");
    },
  },
);
const eventLog = nucleo.ctx.eventos;
const sessionBus = nucleo.ctx.sessionBus;
const conversa = criarConversaDoCanal(eventLog, sessionBus);
const funil = criarFunilDoChassi({
  gateway: nucleo.ctx.actionGateway,
  conversa,
  pluginStore,
});

/*
 * [Onda 3] As aprovações que ficaram pendentes quando o processo anterior
 * morreu voltam a ter waiter e PRAZO — contado do ts original do pedido, não
 * do boot. O cartão reaparece na UI pelo replay; a decisão chega pelo stream.
 */
const aprovacoesRearmadas = await nucleo.ctx.actionGateway.rearmPendingApprovals();
if (aprovacoesRearmadas > 0) {
  console.info(
    JSON.stringify({
      type: "approvals-rearmed",
      count: aprovacoesRearmadas,
      note: "Pedidos de aprovação de antes do reinício voltaram à espera com o prazo original.",
    }),
  );
}

const streamDoChassi = criarStreamDoChassi({
  store: eventLog,
  bus: sessionBus,
  token: configDoStream.token,
  allowOrigins: configDoStream.allowOrigins,
  // [Onda 3] O ready anuncia o catálogo REAL do specialist-registry, lido a
  // cada hello (overlay a quente troca o catálogo sem derrubar o processo) —
  // a observação do conferente da Onda 2 era exatamente "hoje sai vazio".
  specialists: () => nucleo.ctx.specialists.ids(),
  onInbound: (sessionId, envelope) => {
    // [Onda 3] A decisão humana do cartão de aprovação entra no funil —
    // inclusive para pedidos REARMADOS de antes do reinício.
    if (envelope.kind === "approval.decision") {
      const payload = envelope.payload as
        | { callId?: unknown; allow?: unknown; scope?: unknown; comment?: unknown }
        | undefined;
      if (typeof payload?.callId !== "string" || typeof payload.allow !== "boolean") {
        return;
      }
      try {
        nucleo.ctx.actionGateway.decide({
          callId: payload.callId,
          allow: payload.allow,
          ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
          ...(typeof payload.comment === "string" ? { comment: payload.comment } : {}),
        });
      } catch (erro) {
        // Decisão sem pedido pendente: clique repetido, duas janelas, ou um
        // cartão de outra vida do processo que o prazo já fechou. Barulho no
        // log, nunca queda — e nunca consentimento inventado.
        console.warn(
          JSON.stringify({
            type: "approval-decision",
            message: erro instanceof Error ? erro.message : String(erro),
          }),
        );
      }
      return;
    }
    // O funil de entrada da onda 2: prompt vira envelope durável no log.
    void conversa.receberDoTransporte(sessionId, envelope).catch((erro) => {
      console.error(
        JSON.stringify({
          type: "stream-inbound",
          message: erro instanceof Error ? erro.message : String(erro),
          note: "Um prompt que não pôde ser gravado NÃO vira resposta fantasma; o cliente reenvia.",
        }),
      );
    });
  },
  log: (mensagem, campos) => {
    // Campos sensíveis nunca chegam aqui — o transporte loga TAMANHOS de
    // token, nunca o valor (a mesma régua do transporte de referência).
    console.warn(`[stream] ${mensagem}`, campos ?? "");
  },
});

/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      type: "unhandled-rejection",
      message: reason instanceof Error ? reason.message : String(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    }),
  );
});

/*
 * [§4.6] Sem mountCopilotRuntime e sem stall-guard no boot: os dois vigiavam
 * streams do Intelligence, que não sobe aqui. O stall-guard volta na onda 2
 * vigiando execuções servidas pelo NOSSO event log (e na onda 4 passa a
 * disparar por TaskRun). O parâmetro copilotHandler do createApp fica ausente
 * — as rotas do chassis não mudam de forma por isso.
 */
const app = createApp(
  config,
  auth,
  roleRepository,
  createAuditReader(database),
  createCredentialAdminService(
    config.keyEncryptionKey,
    credentialStore,
    createAuditStore(database),
  ),
  createPackageStatusReader(database),
  createConnectorAdminService(
    tenantPackage.knowledgeSources,
    database,
    createCredentialAdminService(
      config.keyEncryptionKey,
      credentialStore,
      createAuditStore(database),
    ),
  ),
  // O runtime do Intelligence NÃO é montado (§4.6): o chat do app fica atrás
  // de flag até a onda 2 religá-lo no nosso protocolo WS.
  undefined,
  computerClient,
  // The only path to an acting call.
  computerClient
    ? createComputerGateway({
        client: computerClient,
        auditStore: bootAuditStore,
        // Read on every decision rather than captured once, so a rule an administrator adds while the
        // server is running applies to the very next action instead of after a restart.
        policy: () => policyStore.get(),
        // Stop, reset and the listing act on containers when there are containers to act on.
        ...(supervisor ? { supervisor } : {}),
      })
    : undefined,
  policyStore,
  // Bots as durable objects, and the channels they run in.
  agentProfileStore,
  channelStore,
  channelEvents,
  // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
  bootAuditStore,
  componentStore,
  // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
  // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
  pluginStore,
  // Components authored in the browser. Their governance is the component store's; this owns only
  // the source, which is the part a rebuild would otherwise have owned.
  sandboxedStore,
  // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
  threadIdentity,
  // [Onda 2] A conversa é o event log: as rotas de thread leem do replay.
  conversa,
  // [Onda 2] O token do stream para o navegador autenticado — o hello continua
  // sendo quem autentica o socket (token no primeiro frame, nunca na URL).
  { token: configDoStream.token, path: CAMINHO_DO_STREAM },
  // [Onda 3] O funil: MCP e componentes generativos entram pelo action-gateway.
  funil,
  // [Onda 3] A leitura de auditoria sobre os envelopes (admin), incluindo as
  // aprovações pendentes reconstruídas do replay.
  {
    store: eventLog,
    pendentes: (sessionId) => nucleo.ctx.actionGateway.pendingApprovals(sessionId),
  },
);

/**
 * The live screen, proxied.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app.
 */
const toStreamUrl = (baseUrl: string, botId: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(config.computer?.token ?? "")}`;

/**
 * Which Bot's screen. The Bot is named in the path and its computer is located the same way every
 * other call locates it, so the live stream cannot point at a different Bot's browser.
 */
const streamPathBotId = (pathname: string): string | null => {
  const match = pathname.match(/^\/api\/computers\/([^/]+)\/stream$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = { upstream: string; inward?: WebSocket };

/**
 * Bun takes exactly one WebSocket handler for the server, and THREE features need one: the app
 * proxies the computer stream, it pushes channel activity through Hono's adapter, and [Onda 2] o
 * transporte da CONVERSA (hello/ready/replay em /v1/stream) fala pelo WS nativo. So this one
 * dispatches on what the upgrade attached — a proxy socket carries `upstream`, o nosso stream
 * carrega o marcador `streamDoChassi`, a Hono socket carries neither — rather than any feature
 * quietly taking the slot and breaking the others on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
type SocketData = StreamData | DadosDoStreamDoChassi | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

serve<SocketData>({
  port,
  websocket: {
    // Teto de fila por socket ALTO de propósito: quem desconecta cliente lento
    // é o barramento (folga → atrasado → 1013 → replay), nunca um descarte
    // mudo de frame no transporte — buraco no meio do stream é o defeito que o
    // protocolo existe para impedir.
    backpressureLimit: TETO_DE_CONTRAPRESSAO_BYTES,
    open(ws) {
      if (ehStreamDoChassi(ws.data)) {
        streamDoChassi.aoAbrir(ws as Parameters<typeof streamDoChassi.aoAbrir>[0]);
        return;
      }
      if (!isProxiedStream(ws.data)) {
        channelSocket.open(asChannelSocket(ws));
        return;
      }
      const inward = new WebSocket(ws.data.upstream);
      ws.data.inward = inward;
      // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
      // should be dropped, not queued, because a stale frame is worse than a missing one.
      inward.onmessage = (event) => {
        try {
          ws.send(String(event.data));
        } catch {
          inward.close();
        }
      };
      inward.onclose = () => ws.close();
      inward.onerror = () => ws.close();
    },
    message(ws, raw) {
      if (ehStreamDoChassi(ws.data)) {
        streamDoChassi.aoReceber(
          ws as Parameters<typeof streamDoChassi.aoReceber>[0],
          typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array),
        );
        return;
      }
      if (!isProxiedStream(ws.data)) {
        channelSocket.message(asChannelSocket(ws), raw);
        return;
      }
      if (ws.data.inward?.readyState === 1) ws.data.inward.send(String(raw));
    },
    close(ws, code, reason) {
      if (ehStreamDoChassi(ws.data)) {
        streamDoChassi.aoFechar(
          ws as Parameters<typeof streamDoChassi.aoFechar>[0],
          code,
          reason,
        );
        return;
      }
      if (!isProxiedStream(ws.data)) {
        channelSocket.close(asChannelSocket(ws), code, reason);
        return;
      }
      ws.data.inward?.close();
    },
    drain(ws) {
      // Só o nosso stream escreve com contrapressão consciente; os outros
      // donos do slot não esperam drain.
      if (ehStreamDoChassi(ws.data)) {
        streamDoChassi.aoDrenar(ws as Parameters<typeof streamDoChassi.aoDrenar>[0]);
      }
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    // [Onda 2] O upgrade da CONVERSA vem antes de tudo: /v1/stream é o mesmo
    // caminho que o desktop já disca no gateway Go — compat dupla exige o
    // mesmo endereço, o mesmo hello e a mesma régua de origem.
    if (
      url.pathname === CAMINHO_DO_STREAM &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return streamDoChassi.upgrade(request, server) as Response;
    }

    // As rotas HTTP do transporte (o /health do oráculo) respondem ANTES do
    // app forkado: é o RoteadorHono (implementação de produção do seam) — e o
    // /health que o desktop conhece vence o do openbot no processo fundido.
    const respostaDoTransporte = await streamDoChassi.roteador.despacharSeSua(request);
    if (respostaDoTransporte !== undefined) {
      return respostaDoTransporte;
    }

    const streamBotId = streamPathBotId(url.pathname);
    if (
      streamBotId !== null &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (!config.computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      // The session guard, applied by hand because middleware does not run on an upgrade. An
      // unauthenticated socket here would be the whole point of the proxy defeated.
      const actor = await identifyUser(request).catch(() => null);
      if (!actor) {
        return new Response("Sign in first.", { status: 401 });
      }
      // Located per Bot when there is a supervisor, and the one shared computer when there is not.
      let upstream: string;
      try {
        upstream = toStreamUrl(
          supervisor
            ? await supervisor.locate(streamBotId)
            : config.computer.baseUrl,
          streamBotId,
        );
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      if (server.upgrade(request, { data: { upstream } })) {
        return undefined as unknown as Response;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    }
    return app.fetch(request, { server });
  },
});

if (config.devNoAuth) {
  // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
  console.warn(
    "OPENBOT_DEV_NO_AUTH is on: every request is treated as " +
      `${DEV_ACTOR.email} (administrator). Local development only.`,
  );
}

// [R2] O listener do Postgres saiu com o Postgres. [Onda 2→3] O que o
// encerramento deve é ao STREAM (fechar os WS vivos com 1001 — o cliente sabe
// que deve reconectar com resumeFrom) e ao KERNEL: o dispose desmonta os
// plugins em ordem reversa e solta o event log — no Windows, um handle de
// sqlite aberto prende o arquivo.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    streamDoChassi.fecharTodas();
    void nucleo.dispose().finally(() => process.exit(0));
  });
}

console.info(
  `AI-BOT 2 server (chassis openbot) listening on http://localhost:${port} — stream em ${CAMINHO_DO_STREAM}, event log em ${join(configDoStream.dataDir, "events.db")}`,
);
