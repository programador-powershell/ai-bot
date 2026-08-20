/**
 * Computer tables: agent computers, sessions, computer-use audit.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or coworker.ts to do it.
 *
 * [Cirurgia §4.4] pg-core → sqlite-core: `deny`/`allow` eram `text[]` e viram
 * `textArray` (JSON em texto, ver ./json.ts); timestamp → época em ms.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { textArray } from "./json";

/**
 * The boundary this deployment is enforcing, kept where a restart cannot lose it.
 *
 * This table keeps policy across restarts. The policy can be changed while running, and a restart
 * must not silently return to the default.
 *
 * One row, by construction. A deployment has one boundary, so the primary key is a constant and every
 * write is an upsert onto it. A table that can hold two policies is a table that will eventually hold
 * two and have to decide between them, and "which of these is in force" is not a question this should
 * ever be able to ask.
 *
 * Memory is still the cache. The gateway asks for the policy on every action, so it reads from
 * memory; this is the record that survives a restart, not something on the path of a click.
 */
export const actionPolicy = sqliteTable("action_policy", {
  /** Always `current`. See the note above on there being exactly one. */
  id: text("id").primaryKey(),
  /** `enforce` or `dry-run`. Not an enum: the policy module owns that vocabulary. */
  mode: text("mode").notNull(),
  deny: textArray("deny").notNull(),
  allow: textArray("allow").notNull(),
  /** Who last changed it, for the Admin page and the trail. */
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
});
