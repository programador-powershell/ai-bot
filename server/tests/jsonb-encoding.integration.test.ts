import { describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../src/audit";
import { createTestDatabase } from "./support/database";

/**
 * A jsonb column must hold JSON, not a string that looks like it.
 *
 * [Cirurgia §4.4] No Postgres o risco era a dupla serialização do driver; no
 * SQLite o contrato é o mesmo com outro verificador: o valor gravado tem de
 * ser TEXTO JSON canônico (uma serialização só), para `json_type(...)` dizer
 * "object" e `payload->>'bot'` continuar respondendo. O teste segue afirmando
 * em SQL, contra um banco real (em memória, com o schema gerado), sobre a
 * FORMA armazenada — nunca sobre o que volta pela aplicação.
 */

const database = createTestDatabase();
const suite = randomUUID().slice(0, 8);
const agentId = `agent_jsonb_${suite}`;

describe("what a jsonb column actually stores", () => {
  test("an object written through the schema is stored as queryable JSON", async () => {
    const { agents } = await import("../src/db/schema");
    await database.insert(agents).values({
      id: agentId,
      name: agentId,
      type: "remote_ag_ui",
      configuration: {
        endpoint: "https://example.test/ag-ui",
        nested: { a: 1 },
      },
    });

    const [row] = database.all<{ shape: string; endpoint: string }>(
      sql`select json_type(configuration) as shape,
                 configuration->>'endpoint' as endpoint
          from agents where id = ${agentId}`,
    );

    expect(row?.shape).toBe("object");
    // The SQL-queryability property: a key is reachable through JSON operators.
    expect(row?.endpoint).toBe("https://example.test/ag-ui");
  });

  test("an audit payload is queryable by its own fields", async () => {
    const store = createAuditStore(database);
    const marker = `bot_${suite}`;
    await recordAuditEvent(store, {
      eventType: "component.function_called",
      targetType: "component",
      targetId: `test_${suite}`,
      payload: { bot: marker, function: "botActivity" },
    });

    const [row] = database.all<{ shape: string; bot: string }>(
      sql`select json_type(payload) as shape, payload->>'bot' as bot
          from audit_events where target_id = ${`test_${suite}`}`,
    );

    expect(row?.shape).toBe("object");
    expect(row?.bot).toBe(marker);
    // Left in place: the trail is append-only, so a test cannot tidy up after itself. One row.
  });

  test("the whole trail is objects, not strings", async () => {
    // A deployment that has run the migration has no string-shaped payloads left. Written as a sweep
    // rather than a single row because the failure this guards against is partial by nature: a new
    // column added without the ./json.ts type would pass every test above and fail only here.
    const [row] = database.all<{ strings: number }>(
      sql`select count(*) as strings from audit_events
          where json_type(payload) <> 'object'`,
    );
    expect(row?.strings).toBe(0);
  });
});
