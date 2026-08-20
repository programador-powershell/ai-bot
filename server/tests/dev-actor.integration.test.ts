import { afterAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
import { createTestDatabase } from "./support/database";
import { users } from "../src/db/schema";

// [Cirurgia §4.4] Banco do chassis em MEMÓRIA com o schema gerado aplicado
// (bun:sqlite) — nada de Postgres nesta estação (R2).
//
// [Cirurgia bun:sqlite] O original embrulhava cada cenário numa transação
// async e terminava com um throw para o ROLLBACK desfazer a armação. Com o
// driver síncrono esse embrulho é uma armadilha: o COMMIT corre antes do
// corpo (cada await adia para microtask) e o teste "passa" com a semântica
// trocada em silêncio. Os cenários viraram sequenciais sobre um banco em
// memória exclusivo do arquivo — não há o que desfazer entre processos.
const database = createTestDatabase();

afterAll(async () => {
  await database.$client.close();
});

describe("development actor persistence", () => {
  test("does not access the database when disabled", async () => {
    const inaccessibleDatabase = {
      get insert(): never {
        throw new Error("disabled initialization accessed the database");
      },
    };

    expect(await initializeDevActorUser(inaccessibleDatabase, false)).toBe(
      false,
    );
  });

  test("writes only when enabled and restores the canonical user identity", async () => {
    await database.delete(users).where(eq(users.id, DEV_ACTOR.id));

    expect(await initializeDevActorUser(database, false)).toBe(false);
    expect(
      await database.select().from(users).where(eq(users.id, DEV_ACTOR.id)),
    ).toEqual([]);

    expect(await initializeDevActorUser(database, true)).toBe(true);
    const firstRows = await database
      .select()
      .from(users)
      .where(eq(users.id, DEV_ACTOR.id));
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      name: DEV_ACTOR.name ?? DEV_ACTOR.email,
      emailVerified: false,
      groups: [],
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });

    await database
      .update(users)
      .set({
        email: `changed-${randomUUID()}@example.test`,
        name: "Changed",
      })
      .where(eq(users.id, DEV_ACTOR.id));
    expect(await initializeDevActorUser(database, true)).toBe(true);

    const restoredRows = await database
      .select()
      .from(users)
      .where(eq(users.id, DEV_ACTOR.id));
    expect(restoredRows).toHaveLength(1);
    expect(restoredRows[0]).toMatchObject({
      id: DEV_ACTOR.id,
      email: DEV_ACTOR.email,
      name: DEV_ACTOR.name ?? DEV_ACTOR.email,
    });
  });

  test("fails loudly when another user owns the development email", async () => {
    const conflictingUserId = `dev-actor-conflict-${randomUUID()}`;

    await database.delete(users).where(eq(users.id, DEV_ACTOR.id));
    await database.insert(users).values({
      id: conflictingUserId,
      email: DEV_ACTOR.email,
      name: "Conflicting User",
    });

    try {
      // unique(email): o upsert do ator dev bate no dono do e-mail e TEM de
      // falhar alto — um dev-actor calado em cima do usuário de outra pessoa
      // é exatamente o que este teste existe para impedir.
      await expect(initializeDevActorUser(database, true)).rejects.toThrow();
      expect(
        await database.select().from(users).where(eq(users.id, DEV_ACTOR.id)),
      ).toEqual([]);
    } finally {
      // Armação desfeita à mão (sem rollback para fazê-lo por nós).
      await database
        .delete(users)
        .where(eq(users.id, conflictingUserId));
    }
  });
});
