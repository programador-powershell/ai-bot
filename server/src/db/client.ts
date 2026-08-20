import { Database as BunSqlite } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

/*
 * [Cirurgia §4.4 — bun:sqlite no lugar de Postgres]
 * O openbot abria um pool `Bun.SQL` contra o Postgres; aqui o banco do chassis
 * é um ARQUIVO (chassis.db) atrás do driver nativo `bun:sqlite` — embutido,
 * síncrono, sem pool. O parâmetro `options.max` do original foi mantido na
 * assinatura para os call sites de teste não mudarem, mas é inerte e diz isso
 * em alto e bom som aqui: não existe pool para limitar.
 *
 * FRONTEIRA DURA (o §4.4 inteiro): este arquivo é a verdade RELACIONAL do
 * chassis (auth/roles, grants, policy, audit do openbot, knowledge sem vetor).
 * O event log das conversas mora no StorageDriver (@aibot2/domain-events) e o
 * drizzle NUNCA toca lá.
 */
export function createDatabase(
  databaseUrl: string,
  // Inerte no SQLite (sem pool); mantido só para os call sites herdados.
  _options: { max?: number } = {},
) {
  const client = new BunSqlite(sqlitePath(databaseUrl), { create: true });
  // WAL: leitura concorrente com escrita sem SQLITE_BUSY no caminho comum.
  client.run("PRAGMA journal_mode = WAL;");
  // As FKs com cascade do schema só valem se o PRAGMA estiver ligado — no
  // SQLite ele nasce DESLIGADO, e um cascade que não roda é dado órfão calado.
  client.run("PRAGMA foreign_keys = ON;");
  return drizzle({ client, schema });
}

/**
 * Aceita o caminho puro ("./chassis.db", ":memory:") e também a forma
 * "file:...", para o mesmo valor de DATABASE_URL servir ao drizzle-kit.
 */
function sqlitePath(databaseUrl: string): string {
  return databaseUrl.startsWith("file:")
    ? databaseUrl.slice("file:".length)
    : databaseUrl;
}

/**
 * Aplica as migrações geradas (server/drizzle) no banco do chassis.
 *
 * No boot e nos testes, porque um deployment novo começa do zero (a decisão
 * do openbot de colapsar a cadeia numa migração só continua valendo) e um
 * teste precisa do MESMO schema que a produção — gerado, não improvisado.
 */
export function migrateDatabase(database: Database): void {
  migrate(database, {
    // fileURLToPath, não .pathname: no Windows o pathname vem "/C:/..." e o
    // fs quer "C:\...". Mesma pasta gerada pelo drizzle-kit (server/drizzle).
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
}

export type Database = ReturnType<typeof createDatabase>;
