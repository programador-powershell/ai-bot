import { expect, test } from "vitest";
import { createDatabase } from "../src/db/client";

// [Cirurgia §4.4] O original abria a fronteira tipada contra uma URL Postgres
// sem consultar nada; aqui a mesma promessa vale para o bun:sqlite em memória.
test("creates a typed database boundary without opening a query", () => {
  const database = createDatabase(":memory:");

  expect(database.query.users).toBeDefined();
});

test("aceita a forma file: do DATABASE_URL (a mesma que o drizzle-kit lê)", () => {
  const database = createDatabase("file::memory:");

  expect(database.query.users).toBeDefined();
});
