import { customType } from "drizzle-orm/sqlite-core";

/**
 * A `jsonb` column that actually stores JSON.
 *
 * [Cirurgia §4.4 — bun:sqlite] No openbot este tipo existia para evitar a dupla
 * serialização do driver Postgres. No SQLite o motivo muda mas o contrato fica:
 * o valor é gravado como TEXTO JSON canônico (uma serialização só, aqui), para
 * que os operadores JSON do SQLite (`payload->>'bot'`, `json_type(...)`)
 * continuem enxergando um objeto consultável — a mesma promessa que o original
 * fazia ao Postgres. Leituras voltam como objeto, então nenhum call site muda.
 *
 * Use this everywhere instead of a raw text column for JSON payloads.
 */
export const jsonb = customType<{
  data: Record<string, unknown>;
  driverData: string;
}>({
  dataType: () => "text",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) =>
    JSON.parse(String(value)) as Record<string, unknown>,
});

/**
 * [Cirurgia §4.4] Coluna de lista de strings. O Postgres tinha `text[]`; o
 * SQLite não tem array, então a lista vira TEXTO JSON. É deliberadamente um
 * tipo próprio (e não `text` solto) para que nenhum call site precise saber a
 * representação — a mesma razão do `jsonb` acima.
 */
export const textArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType: () => "text",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => JSON.parse(String(value)) as string[],
});
