/*
 * [Cirurgia §4.4 — pg-core → sqlite-core, mecânica e declarada]
 * - `pgTable` → `sqliteTable`; `boolean` → `integer({ mode: "boolean" })`;
 *   `timestamp withTimezone` → `integer({ mode: "timestamp_ms" })` (Date nas
 *   duas pontas, época em milissegundos no disco);
 * - `pgEnum` → `text({ enum })` — o vocabulário fica no schema, o SQLite não
 *   tem tipo enum;
 * - `uuid().defaultRandom()` → `text().$defaultFn(crypto.randomUUID)`;
 * - `text().array()` → `textArray` (JSON em texto, ver ./json.ts);
 * - `vector` (pgvector) → `text` com JSON — knowledge entra SEM busca vetorial
 *   (pendência declarada I7 do plano; sqlite-vec seria homologação nova).
 * Os comentários originais do openbot (MIT) foram mantidos onde a decisão
 * continua a mesma.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
// NOT a raw text column: JSON payloads go through one canonical serialisation
// so SQL JSON operators such as `payload->>'bot'` stay queryable. See ./json.ts.
import { jsonb, textArray } from "./json";

// Época em ms como default do BANCO (não só do drizzle), para que um INSERT
// cru em teste ou migração também ganhe carimbo — o papel que o defaultNow()
// cumpria no Postgres.
const nowMs = () => sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs());

const randomUuid = () => crypto.randomUUID();

export const roleValues = ["admin", "user"] as const;
export const agentTypeValues = ["built_in", "remote_ag_ui"] as const;
export const credentialKindValues = [
  "model",
  "connector",
  // A customer's own agent behind a key. Its own kind so "what does this deployment hold" stays true.
  "agent",
  // A token for an MCP server. Same vault and same revocation as everything else, so the server row
  // holds a pointer and never the secret.
  "mcp",
] as const;
export const connectorTypeValues = ["google_drive", "onedrive"] as const;
export const syncStatusValues = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;
export const aclEffectValues = ["allow", "deny"] as const;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  groups: textArray("groups").notNull().default(sql`'[]'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("accounts_provider_account_idx").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verifications = sqliteTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: roleValues }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const deploymentPackages = sqliteTable("deployment_packages", {
  id: text("id").primaryKey().$defaultFn(randomUuid),
  tenantId: text("tenant_id").notNull().unique(),
  sourcePath: text("source_path").notNull(),
  checksum: text("checksum").notNull(),
  loadedAt: integer("loaded_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs()),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: agentTypeValues }).notNull(),
  configuration: jsonb("configuration").notNull(),
  packageId: text("package_id").references(() => deploymentPackages.id, {
    onDelete: "set null",
  }),
  override: jsonb("override"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    suggestedPrompts: textArray("suggested_prompts")
      .notNull()
      .default(sql`'[]'`),
    allowedGroups: textArray("allowed_groups").notNull().default(sql`'[]'`),
    packageId: text("package_id").references(() => deploymentPackages.id, {
      onDelete: "set null",
    }),
    override: jsonb("override"),
    /**
     * The last thing said in this channel, denormalised so a roster is one indexed read.
     *
     * Channel grain, not per-member: what was said last is a property of the conversation, and a copy
     * per member is the same fact stored N times, drifting. Per-member state, what somebody has read
     *, belongs on the membership instead.
     *
     * Written by whoever ran the agent, from the client that already received the reply, so it is a
     * cache of what a client observed rather than an authoritative mirror of the thread.
     */
    lastMessage: text("last_message"),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
    /** Which agent spoke, so a channel with several can show the right one. Null for a person. */
    lastMessageAgentId: text("last_message_agent_id").references(
      () => agents.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * The order the channel list is drawn in.
     *
     * On the expression, not on the column, because the list sorts by the last thing said and falls
     * back to when the channel was made. An index on `last_message_at` alone does not serve that
     * ordering, so the sort would fall back to a scan on exactly the query drawn on every page.
     *
     * Declared here rather than only in a migration. An index that exists in the database and not in
     * the schema is invisible to `generate`, so the next generated migration proposes a schema
     * without it and it is silently dropped.
     */
    index("channels_recent_activity_idx").on(
      sql`COALESCE(${table.lastMessageAt}, ${table.createdAt}) DESC`,
    ),
  ],
);

export const channelMemberships = sqliteTable(
  "channel_memberships",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

export const channelAgents = sqliteTable(
  "channel_agents",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.agentId] })],
);

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey().$defaultFn(randomUuid),
  kind: text("kind", { enum: credentialKindValues }).notNull(),
  provider: text("provider").notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  keyId: text("key_id").notNull(),
  metadata: jsonb("metadata").notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const connectorInstances = sqliteTable("connector_instances", {
  id: text("id").primaryKey().$defaultFn(randomUuid),
  type: text("type", { enum: connectorTypeValues }).notNull(),
  credentialId: text("credential_id").references(() => credentials.id, {
    onDelete: "set null",
  }),
  status: text("status", { enum: syncStatusValues })
    .notNull()
    .default("pending"),
  sourceMetadata: jsonb("source_metadata").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const connectorCursors = sqliteTable("connector_cursors", {
  connectorInstanceId: text("connector_instance_id")
    .primaryKey()
    .references(() => connectorInstances.id, { onDelete: "cascade" }),
  cursor: text("cursor"),
  updatedAt: updatedAt(),
});

export const webhookSubscriptions = sqliteTable("webhook_subscriptions", {
  id: text("id").primaryKey().$defaultFn(randomUuid),
  connectorInstanceId: text("connector_instance_id")
    .notNull()
    .references(() => connectorInstances.id, { onDelete: "cascade" }),
  providerSubscriptionId: text("provider_subscription_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
});

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey().$defaultFn(randomUuid),
    connectorInstanceId: text("connector_instance_id")
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    status: text("status", { enum: syncStatusValues }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" })
      .notNull()
      .default(nowMs()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    error: text("error"),
    stats: jsonb("stats").notNull(),
  },
  (table) => [
    index("sync_runs_connector_started_at_idx").on(
      table.connectorInstanceId,
      table.startedAt,
    ),
  ],
);

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey().$defaultFn(randomUuid),
    connectorInstanceId: text("connector_instance_id")
      .notNull()
      .references(() => connectorInstances.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    metadata: jsonb("metadata").notNull(),
    contentHash: text("content_hash").notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("documents_connector_source_idx").on(
      table.connectorInstanceId,
      table.sourceId,
    ),
    index("documents_connector_deleted_idx").on(
      table.connectorInstanceId,
      table.deletedAt,
    ),
  ],
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey().$defaultFn(randomUuid),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    content: text("content").notNull(),
    /**
     * [I7 — pendência declarada] Era `vector(1536)` do pgvector. Sem Postgres
     * não há busca vetorial nesta estação: o embedding fica guardado como
     * JSON (texto) para o dado não se perder, e NENHUMA consulta o usa até a
     * decisão sqlite-vec/Postgres-servidor registrada no plano.
     */
    embedding: text("embedding").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("chunks_document_position_idx").on(
      table.documentId,
      table.position,
    ),
    index("chunks_document_idx").on(table.documentId),
  ],
);

export const documentAcls = sqliteTable(
  "document_acls",
  {
    id: text("id").primaryKey().$defaultFn(randomUuid),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    principal: text("principal").notNull(),
    effect: text("effect", { enum: aclEffectValues }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("document_acls_document_principal_effect_idx").on(
      table.documentId,
      table.principal,
      table.effect,
    ),
    index("document_acls_principal_idx").on(table.principal),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey().$defaultFn(randomUuid),
    /**
     * Who did it, as an id rather than a reference. No foreign key: the trail is append-only, so any
     * cascade the database wanted to run against it would be an update the trigger refuses, and a
     * user who had done anything could never be deleted.
     */
    actorUserId: text("actor_user_id"),
    eventType: text("event_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("audit_events_created_at_idx").on(table.createdAt)],
);

export const intelligenceChannelMappings = sqliteTable(
  "intelligence_channel_mappings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.channelId] }),
    uniqueIndex("intelligence_channel_mappings_thread_idx").on(table.threadId),
  ],
);
