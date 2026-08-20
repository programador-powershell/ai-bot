import {
  createDatabase,
  type Database,
  migrateDatabase,
} from "../../src/db/client";

/**
 * [Cirurgia §4.4] O original limitava o POOL Postgres da suíte (TEST_POOL);
 * com bun:sqlite não há pool para limitar — a constante fica pelos call sites
 * herdados e é inerte, como o próprio createDatabase declara.
 */
export const TEST_POOL = { max: 2 } as const;

/**
 * Um banco do chassis NOVO, em memória, com o schema GERADO aplicado.
 *
 * Em memória de propósito: cada arquivo de teste ganha um banco isolado sem
 * arquivo em disco — o que também evita o EBUSY do Windows na limpeza (handle
 * do sqlite ainda aberto quando o rm chega, visto na onda 0 sob Bun).
 * E `migrateDatabase` em vez de DDL improvisada: o teste tem que rodar sobre
 * o MESMO schema que a produção aplica no boot, senão ele prova outra coisa.
 */
export function createTestDatabase(): Database {
  const database = createDatabase(":memory:");
  migrateDatabase(database);
  return database;
}
