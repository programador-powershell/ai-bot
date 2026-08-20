import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  deploymentPackages,
} from "../db/schema";
import { authFromConfiguration, storeAgentAuth } from "./auth-header";
import { canManageAgent } from "./profile-policy";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Pick<Database, "select"> | Pick<Transaction, "select">;

/** Something that can read profiles: the pool, or a caller's open transaction. */
export type ProfileReadExecutor = DatabaseExecutor;

export type AgentProfileStore = {
  list(actor: AgentActor, hidden?: boolean): Promise<AgentProfile[]>;
  get(actor: AgentActor, id: string): Promise<AgentProfile | null>;
  /**
   * `get`, but on the caller's own transaction and holding the profile against deletion until that
   * transaction ends.
   *
   * A caller that writes rows referencing an agent has to validate it here rather than through
   * `get`: a deletion committing between the check and the insert would leave rows pointing at an
   * agent that no longer runs.
   *
   * [Cirurgia bun:sqlite] SÍNCRONO, de propósito: quem chama está dentro de
   * uma transação síncrona (o driver é síncrono), e um retorno em Promise só
   * resolveria DEPOIS do COMMIT — exatamente a janela que este método existe
   * para fechar. O "hold" do FOR SHARE virou desnecessário: a transação
   * imediata do sqlite serializa o escritor que apagaria o perfil.
   */
  getWithin(
    executor: ProfileReadExecutor,
    actor: AgentActor,
    id: string,
  ): AgentProfile | null;
  create(actor: AgentActor, input: CreateAgentInput): Promise<AgentProfile>;
  update(
    actor: AgentActor,
    id: string,
    input: CreateAgentInput,
  ): Promise<AgentProfile>;
  duplicate(actor: AgentActor, id: string): Promise<AgentProfile>;
  setHidden(actor: AgentActor, id: string, hidden: boolean): Promise<void>;
  softDelete(actor: AgentActor, id: string): Promise<void>;
};

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} was not found.`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentNotManageableError extends Error {
  constructor(id: string) {
    super(`Agent ${id} cannot be managed by this actor.`);
    this.name = "AgentNotManageableError";
  }
}

export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent ${id} is protected.`);
    this.name = "ProtectedAgentError";
  }
}

const joinedProjection = {
  id: agents.id,
  name: agents.name,
  title: agentProfiles.title,
  roleDescription: agentProfiles.roleDescription,
  avatarSeed: agentProfiles.avatarSeed,
  visibility: agentProfiles.visibility,
  ownerUserId: agentProfiles.ownerUserId,
  packageId: deploymentPackages.id,
  hiddenAt: agentPreferences.hiddenAt,
  deletedAt: agentProfiles.deletedAt,
  configuration: agents.configuration,
};

function joinedProfiles(executor: DatabaseExecutor, actor: AgentActor) {
  return executor
    .select(joinedProjection)
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .leftJoin(
      agentPreferences,
      and(
        eq(agentPreferences.agentId, agents.id),
        eq(agentPreferences.userId, actor.id),
      ),
    )
    .leftJoin(deploymentPackages, eq(deploymentPackages.id, agents.packageId));
}

function accessFilter(actor: AgentActor) {
  if (actor.role === "admin") return undefined;

  return or(
    eq(agentProfiles.visibility, "public"),
    eq(agentProfiles.ownerUserId, actor.id),
  );
}

function mapProfile(
  row: Awaited<
    ReturnType<ReturnType<typeof joinedProfiles>["execute"]>
  >[number],
): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
    avatarSeed: row.avatarSeed,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    systemOwned: row.packageId !== null,
    hidden: row.hiddenAt !== null,
    deletedAt: row.deletedAt,
    endpoint: endpointOf(row.configuration),
    // Whether a key is set, never which. The form needs to show "a key is set" so a person does not
    // wipe one by saving an unrelated edit; showing the value would put a secret in a screenshot.
    hasAuth: authFromConfiguration(row.configuration) !== null,
  };
}

/**
 * The AG-UI address this coworker runs on, read back out of its stored configuration.
 *
 * Needed so an edit does not destroy it. The edit form is the same form as create, so without the
 * current endpoint to fill it with, saving a change of title would submit an empty endpoint and
 * convert an external agent back into the built-in one. That failure is silent and total: the Bot
 * keeps working, so nothing looks broken, and it is simply no longer their agent.
 */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

/*
 * [Cirurgia bun:sqlite] Síncrono (.all()) para poder rodar DENTRO de uma
 * transação síncrona — ver a nota do getWithin. Os call sites que awaitavam
 * continuam funcionando (await sobre valor puro).
 */
function findAccessibleProfile(
  executor: DatabaseExecutor,
  actor: AgentActor,
  id: string,
): AgentProfile | null {
  const [row] = joinedProfiles(executor, actor)
    .where(
      and(
        eq(agents.id, id),
        isNull(agentProfiles.deletedAt),
        accessFilter(actor),
      ),
    )
    .all();
  return row ? mapProfile(row) : null;
}

/*
 * [Cirurgia bun:sqlite] Os locks FOR UPDATE/FOR SHARE do Postgres saíram: o
 * SQLite não tem lock de linha — a transação com behavior "immediate" toma o
 * lock de ESCRITOR do banco inteiro no BEGIN, que é a serialização que esses
 * helpers compravam (deleção correndo contra referência bloqueia na porta).
 * Removidos em vez de virarem no-ops calados, para nenhum leitor achar que
 * ainda existe lock de linha aqui.
 */

function requireManageable(actor: AgentActor, profile: AgentProfile) {
  if (profile.systemOwned) throw new ProtectedAgentError(profile.id);
  if (!canManageAgent(actor, profile)) {
    throw new AgentNotManageableError(profile.id);
  }
}

function newAgentId() {
  return `agent_${crypto.randomUUID()}`;
}

export function createAgentProfileStore(
  database: Database,
  managedAgentAgUiUrl: URL,
  /**
   * Where a customer agent's key is kept. Optional so a deployment without a vault still runs; an
   * agent with a key then simply cannot be created, which is better than storing it in the clear.
   */
  vault?: { store: CredentialStore; encryptionKey: string },
): AgentProfileStore {
  const managedConfiguration = {
    endpoint: managedAgentAgUiUrl.toString(),
  };

  return {
    async list(actor, hidden = false) {
      const rows = await joinedProfiles(database, actor).where(
        and(
          isNull(agentProfiles.deletedAt),
          accessFilter(actor),
          hidden
            ? isNotNull(agentPreferences.hiddenAt)
            : isNull(agentPreferences.hiddenAt),
        ),
      );
      return rows.map(mapProfile);
    },

    async get(actor, id) {
      return findAccessibleProfile(database, actor, id);
    },

    getWithin(executor, actor, id) {
      // Sem FOR SHARE no sqlite — a transação imediata do chamador já é o
      // lock (ver a nota na interface).
      return findAccessibleProfile(executor, actor, id);
    },

    async create(actor, input) {
      const id = newAgentId();
      // [Cirurgia bun:sqlite] O cofre é gravado ANTES da transação: a
      // criptografia é assíncrona de verdade e o callback da transação tem de
      // ser síncrono (ver channels/routes.ts). No original o vault JÁ escrevia
      // por fora desta transação (conexão própria do pool), então a semântica
      // de falha não muda: um create que falha depois pode deixar credencial
      // órfã no cofre — revogável, nunca vazada.
      const auth =
        input.auth && vault
          ? await storeAgentAuth({
              store: vault.store,
              encryptionKey: vault.encryptionKey,
              agentId: id,
              header: input.auth.header,
              value: input.auth.value,
            })
          : undefined;
      return database.transaction((transaction) => {
        transaction
          .insert(agents)
          .values({
            id,
            name: input.name,
            type: "remote_ag_ui",
            // Their endpoint if they gave one, ours if they did not. Validated before it reaches here;
            // see endpoint.ts for why a stored URL is a security decision and not a text field.
            //
            // The key, if there is one, goes to the vault and only its reference is stored here. See
            // auth-header.ts for why a bearer token must not sit next to the endpoint.
            configuration: {
              ...(input.endpoint
                ? { endpoint: input.endpoint }
                : managedConfiguration),
              ...(auth ? { auth } : {}),
            },
          })
          .run();
        transaction
          .insert(agentProfiles)
          .values({
            agentId: id,
            ownerUserId: actor.id,
            title: input.title,
            roleDescription: input.roleDescription,
            avatarSeed: id,
            visibility: input.visibility,
          })
          .run();

        const profile = findAccessibleProfile(transaction, actor, id);
        if (!profile) throw new AgentNotFoundError(id);
        return profile;
      });
    },

    async update(actor, id, input) {
      // Cofre antes da transação — mesma razão (e mesma semântica) do create.
      const auth =
        input.auth && vault
          ? await storeAgentAuth({
              store: vault.store,
              encryptionKey: vault.encryptionKey,
              agentId: id,
              header: input.auth.header,
              value: input.auth.value,
            })
          : undefined;
      return database.transaction(
        (transaction) => {
          const profile = findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const updatedAt = new Date();
          /**
           * The endpoint and the key change here too, not only at creation.
           *
           * The form sends both and the route validates both, so an edit that dropped them looked
           * like it had worked: the screen reported success and the Bot kept answering at the old
           * address, which is the worst way to move an endpoint. A key is replaced only when one is
           * supplied, because the form cannot show what is stored and sending nothing means "leave
           * it alone" rather than "remove it".
           */
          const [row] = transaction
            .select({ configuration: agents.configuration })
            .from(agents)
            .where(eq(agents.id, id))
            .limit(1)
            .all();
          const configuration = {
            ...((row?.configuration ?? {}) as Record<string, unknown>),
            ...(input.endpoint ? { endpoint: input.endpoint } : {}),
            ...(auth ? { auth } : {}),
          };
          transaction
            .update(agents)
            .set({ name: input.name, configuration, updatedAt })
            .where(eq(agents.id, id))
            .run();
          transaction
            .update(agentProfiles)
            .set({
              title: input.title,
              roleDescription: input.roleDescription,
              visibility: input.visibility,
              updatedAt,
            })
            .where(eq(agentProfiles.agentId, id))
            .run();

          const updated = findAccessibleProfile(transaction, actor, id);
          if (!updated) throw new AgentNotFoundError(id);
          return updated;
        },
        { behavior: "immediate" },
      );
    },

    async duplicate(actor, id) {
      return database.transaction(
        (transaction) => {
          const source = findAccessibleProfile(transaction, actor, id);
          if (!source) throw new AgentNotFoundError(id);

          const duplicateId = newAgentId();
          transaction
            .insert(agents)
            .values({
              id: duplicateId,
              name: source.name,
              type: "remote_ag_ui",
              configuration: managedConfiguration,
            })
            .run();
          transaction
            .insert(agentProfiles)
            .values({
              agentId: duplicateId,
              ownerUserId: actor.id,
              title: source.title,
              roleDescription: source.roleDescription,
              avatarSeed: source.avatarSeed,
              visibility: "private",
            })
            .run();

          const duplicate = findAccessibleProfile(
            transaction,
            actor,
            duplicateId,
          );
          if (!duplicate) throw new AgentNotFoundError(duplicateId);
          return duplicate;
        },
        { behavior: "immediate" },
      );
    },

    async setHidden(actor, id, hidden) {
      database.transaction(
        (transaction) => {
          const profile = findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);

          transaction
            .insert(agentPreferences)
            .values({
              userId: actor.id,
              agentId: id,
              hiddenAt: hidden ? new Date() : null,
            })
            .onConflictDoUpdate({
              target: [agentPreferences.userId, agentPreferences.agentId],
              set: { hiddenAt: hidden ? new Date() : null },
            })
            .run();
        },
        { behavior: "immediate" },
      );
    },

    async softDelete(actor, id) {
      database.transaction(
        (transaction) => {
          const profile = findAccessibleProfile(transaction, actor, id);
          if (!profile) throw new AgentNotFoundError(id);
          requireManageable(actor, profile);

          const deletedAt = new Date();
          transaction
            .update(agentProfiles)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(eq(agentProfiles.agentId, id))
            .run();
        },
        { behavior: "immediate" },
      );
    },
  };
}
