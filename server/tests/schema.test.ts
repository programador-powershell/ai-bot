import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { getTableName } from "drizzle-orm";
// [Cirurgia §4.4] sqlite-core no lugar do pg-core — o schema mudou de dialeto.
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  accounts,
  agentPreferences,
  agentProfiles,
  agents,
  agentVisibilityValues,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  chunks,
  connectorCursors,
  connectorInstances,
  credentials,
  documentAcls,
  documents,
  intelligenceChannelMappings,
  sessions,
  syncRuns,
  userRoles,
  users,
  verifications,
} from "../src/db/schema";

describe("OpenBot database schema", () => {
  test("defines the core runtime records", () => {
    expect(
      [
        users,
        sessions,
        accounts,
        verifications,
        userRoles,
        agents,
        channels,
        channelMemberships,
        channelAgents,
        credentials,
        connectorInstances,
        connectorCursors,
        syncRuns,
        documents,
        chunks,
        documentAcls,
        auditEvents,
        intelligenceChannelMappings,
      ].map(getTableName),
    ).toEqual([
      "users",
      "sessions",
      "accounts",
      "verifications",
      "user_roles",
      "agents",
      "channels",
      "channel_memberships",
      "channel_agents",
      "credentials",
      "connector_instances",
      "connector_cursors",
      "sync_runs",
      "documents",
      "chunks",
      "document_acls",
      "audit_events",
      "intelligence_channel_mappings",
    ]);
  });

  test("keeps document embeddings and ACLs separate from document metadata", () => {
    expect(Object.keys(documents)).toEqual(
      expect.arrayContaining([
        "id",
        "connectorInstanceId",
        "sourceId",
        "canonicalUrl",
      ]),
    );
    expect(Object.keys(chunks)).toEqual(
      expect.arrayContaining(["documentId", "embedding"]),
    );
    expect(Object.keys(documentAcls)).toEqual(
      expect.arrayContaining(["documentId", "principal", "effect"]),
    );
  });

  test("includes Better Auth's verified Google identity records", () => {
    expect(Object.keys(users)).toContain("emailVerified");
    expect(Object.keys(sessions)).toEqual(
      expect.arrayContaining(["ipAddress", "userAgent"]),
    );
    expect(Object.keys(accounts)).toEqual(
      expect.arrayContaining(["userId", "providerId", "accountId"]),
    );
  });

  test("defines the exact agent profile and roster preference contracts", () => {
    expect([agentProfiles, agentPreferences].map(getTableName)).toEqual([
      "agent_profiles",
      "agent_preferences",
    ]);
    // [Cirurgia §4.4] O SQLite não tem tipo enum: o vocabulário vive no
    // schema (text({ enum })) e é isto que o contrato agora fixa.
    expect(agentVisibilityValues).toEqual(["public", "private"]);

    const profileConfig = getTableConfig(agentProfiles);
    const preferenceConfig = getTableConfig(agentPreferences);

    expect(
      profileConfig.columns.map((column) => ({
        name: column.name,
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      { name: "agent_id", notNull: true, hasDefault: false, primary: true },
      {
        name: "owner_user_id",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      { name: "title", notNull: true, hasDefault: false, primary: false },
      {
        name: "role_description",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "avatar_seed",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "visibility",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "deleted_at",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
      {
        name: "created_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
      {
        name: "updated_at",
        notNull: true,
        hasDefault: true,
        primary: false,
      },
    ]);

    expect(
      preferenceConfig.columns.map((column) => ({
        name: column.name,
        sqlType: column.getSQLType(),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
        primary: column.primary,
      })),
    ).toEqual([
      {
        name: "user_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "agent_id",
        sqlType: "text",
        notNull: true,
        hasDefault: false,
        primary: false,
      },
      {
        name: "hidden_at",
        // [Cirurgia §4.4] timestamp virou época em ms (integer) no sqlite.
        sqlType: "integer",
        notNull: false,
        hasDefault: false,
        primary: false,
      },
    ]);

    expect(
      [...profileConfig.foreignKeys, ...preferenceConfig.foreignKeys].map(
        (foreignKey) => {
          const reference = foreignKey.reference();
          return {
            sourceColumns: reference.columns.map((column) => column.name),
            targetTable: getTableName(reference.foreignTable),
            targetColumns: reference.foreignColumns.map(
              (column) => column.name,
            ),
            onDelete: foreignKey.onDelete,
            onUpdate: foreignKey.onUpdate,
          };
        },
      ),
    ).toEqual([
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        // [Cirurgia §4.4] FK do sqlite-core guarda undefined quando o onUpdate
        // nao foi declarado (o pg-core materializava "no action").
        onUpdate: undefined,
      },
      {
        sourceColumns: ["owner_user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "set null",
        // [Cirurgia §4.4] FK do sqlite-core guarda undefined quando o onUpdate
        // nao foi declarado (o pg-core materializava "no action").
        onUpdate: undefined,
      },
      {
        sourceColumns: ["user_id"],
        targetTable: "users",
        targetColumns: ["id"],
        onDelete: "cascade",
        // [Cirurgia §4.4] FK do sqlite-core guarda undefined quando o onUpdate
        // nao foi declarado (o pg-core materializava "no action").
        onUpdate: undefined,
      },
      {
        sourceColumns: ["agent_id"],
        targetTable: "agents",
        targetColumns: ["id"],
        onDelete: "cascade",
        // [Cirurgia §4.4] FK do sqlite-core guarda undefined quando o onUpdate
        // nao foi declarado (o pg-core materializava "no action").
        onUpdate: undefined,
      },
    ]);

    expect(
      preferenceConfig.primaryKeys.map((primaryKey) => ({
        name: primaryKey.getName(),
        columns: primaryKey.columns.map((column) => column.name),
      })),
    ).toEqual([
      {
        name: "agent_preferences_user_id_agent_id_pk",
        columns: ["user_id", "agent_id"],
      },
    ]);

    expect(
      profileConfig.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : undefined,
        ),
        unique: index.config.unique,
        // [Cirurgia §4.4] Índice do sqlite não tem "method" (btree era do pg).
      })),
    ).toEqual([
      {
        name: "agent_profiles_visibility_deleted_idx",
        columns: ["visibility", "deleted_at"],
        unique: false,
      },
    ]);
  });

  test("keeps the agent profile migration aligned with the schema", async () => {
    const migration = await readFile(
      new URL("../drizzle/0000_schema.sql", import.meta.url),
      "utf8",
    );
    const normalizedMigration = migration.replace(/\s+/g, " ").trim();

    // [Cirurgia §4.4] As âncoras abaixo são o DDL sqlite GERADO (drizzle-kit,
    // dialeto sqlite): sem CREATE TYPE (enum virou text), timestamps como
    // época em ms com default no banco, e FKs inline na própria tabela.
    expect(normalizedMigration).toContain(
      "CREATE TABLE `agent_profiles` ( `agent_id` text PRIMARY KEY NOT NULL, `owner_user_id` text, `title` text NOT NULL, `role_description` text NOT NULL, `avatar_seed` text NOT NULL, `visibility` text NOT NULL, `deleted_at` integer, `created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL, `updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL",
    );
    expect(normalizedMigration).toContain(
      "CREATE TABLE `agent_preferences` ( `user_id` text NOT NULL, `agent_id` text NOT NULL, `hidden_at` integer, PRIMARY KEY(`user_id`, `agent_id`)",
    );
    expect(normalizedMigration).toContain(
      "FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade",
    );
    expect(normalizedMigration).toContain(
      "FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null",
    );
    expect(normalizedMigration).toContain(
      "FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade",
    );
    expect(normalizedMigration).toContain(
      "CREATE INDEX `agent_profiles_visibility_deleted_idx` ON `agent_profiles` (`visibility`,`deleted_at`)",
    );
    // As três coisas escritas à mão na migração (ver o cabeçalho dela) têm de
    // sobreviver a uma regeneração: o índice de expressão e os dois triggers
    // que mantêm a trilha de auditoria append-only.
    expect(normalizedMigration).toContain(
      "CREATE INDEX `channels_recent_activity_idx` ON `channels` (COALESCE(`last_message_at`, `created_at`) DESC)",
    );
    expect(normalizedMigration).toContain("audit_events_append_only_update");
    expect(normalizedMigration).toContain("audit_events_append_only_delete");
  });
});
