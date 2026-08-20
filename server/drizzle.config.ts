import { defineConfig } from "drizzle-kit";

/*
 * [Cirurgia §4.4] dialeto sqlite (bun:sqlite) no lugar do postgresql do
 * openbot. O DATABASE_URL é o caminho do arquivo chassis.db; o default cobre
 * o `drizzle-kit generate`, que só lê o schema e não abre banco nenhum.
 */
const databaseUrl = process.env.DATABASE_URL ?? "file:./chassis.db";

export default defineConfig({
  dialect: "sqlite",
  /**
   * Every schema file, listed explicitly.
   *
   * Files missing from this list are invisible to `generate`; existing tables still work, but the
   * next generated migration treats them as absent. Add the file here in the same change that adds
   * the schema file.
   */
  schema: [
    "./src/db/schema/core.ts",
    "./src/db/schema/computer.ts",
    "./src/db/schema/coworker.ts",
    "./src/db/schema/components.ts",
    "./src/db/schema/plugins.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
