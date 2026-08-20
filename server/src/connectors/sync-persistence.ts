import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  chunks,
  connectorCursors,
  documentAcls,
  documents,
  syncRuns,
} from "../db/schema";
import type { ConnectorChange } from "./contract";

export function createSyncPersistence(
  database: Database,
  connectorInstanceId: string,
) {
  return {
    async persistBatch(changes: ConnectorChange[], cursor: string | null) {
      // [Cirurgia bun:sqlite] Transação síncrona (.all()/.run()) — o driver é
      // síncrono e callback async commitaria antes do corpo; ver
      // channels/routes.ts para a nota completa.
      database.transaction(
        (transaction) => {
          for (const change of changes) {
            if (change.kind === "delete") {
              transaction
                .update(documents)
                .set({ deletedAt: new Date(), updatedAt: new Date() })
                .where(
                  and(
                    eq(documents.connectorInstanceId, connectorInstanceId),
                    eq(documents.sourceId, change.sourceId),
                  ),
                )
                .run();
              continue;
            }
            const [document] = transaction
              .insert(documents)
              .values({
                connectorInstanceId,
                sourceId: change.sourceId,
                title: change.title,
                canonicalUrl: change.canonicalUrl,
                metadata: change.metadata,
                contentHash: change.contentHash,
                deletedAt: null,
                updatedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [documents.connectorInstanceId, documents.sourceId],
                set: {
                  title: change.title,
                  canonicalUrl: change.canonicalUrl,
                  metadata: change.metadata,
                  contentHash: change.contentHash,
                  deletedAt: null,
                  updatedAt: new Date(),
                },
              })
              .returning({ id: documents.id })
              .all();
            if (!document)
              throw new Error("Document upsert did not return an ID.");
            transaction
              .delete(chunks)
              .where(eq(chunks.documentId, document.id))
              .run();
            transaction
              .delete(documentAcls)
              .where(eq(documentAcls.documentId, document.id))
              .run();
            if (change.chunks.length) {
              transaction
                .insert(chunks)
                .values(
                  change.chunks.map((chunk) => ({
                    documentId: document.id,
                    position: chunk.position,
                    content: chunk.content,
                    // [I7] Sem pgvector: o embedding é guardado como JSON
                    // (texto) para o dado não se perder; nada o consulta até
                    // a decisão registrada no plano (sqlite-vec/Postgres).
                    embedding: JSON.stringify(chunk.embedding),
                  })),
                )
                .run();
            }
            if (change.acls.length) {
              transaction
                .insert(documentAcls)
                .values(
                  change.acls.map((acl) => ({
                    documentId: document.id,
                    ...acl,
                  })),
                )
                .run();
            }
          }
          transaction
            .insert(syncRuns)
            .values({
              connectorInstanceId,
              status: "succeeded",
              completedAt: new Date(),
              stats: { changes: changes.length },
            })
            .run();
          if (cursor !== null) {
            transaction
              .insert(connectorCursors)
              .values({ connectorInstanceId, cursor, updatedAt: new Date() })
              .onConflictDoUpdate({
                target: connectorCursors.connectorInstanceId,
                set: { cursor, updatedAt: new Date() },
              })
              .run();
          }
        },
        { behavior: "immediate" },
      );
    },
    async cursor() {
      const [record] = await database
        .select({ cursor: connectorCursors.cursor })
        .from(connectorCursors)
        .where(eq(connectorCursors.connectorInstanceId, connectorInstanceId));
      return record?.cursor ?? null;
    },
  };
}
