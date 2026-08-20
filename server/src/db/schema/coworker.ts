/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 *
 * [Cirurgia §4.4] pg-core → sqlite-core; `pgEnum` vira `text({ enum })` com o
 * vocabulário exportado em `agentVisibilityValues` (o SQLite não tem enum).
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { agents, users } from "./core";

const nowMs = () => sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs());

export const agentVisibilityValues = ["public", "private"] as const;

export const agentProfiles = sqliteTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    visibility: text("visibility", { enum: agentVisibilityValues }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

export const agentPreferences = sqliteTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: integer("hidden_at", { mode: "timestamp_ms" }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);
