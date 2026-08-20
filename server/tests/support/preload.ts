/**
 * Loaded before any test file, to make module loading deterministic.
 *
 * Deep inside the runtime's dependencies, `@modelcontextprotocol/sdk`
 * does `require("eventsource")` from CommonJS, and eventsource ships as ESM only. Bun permits that
 * only when the module has already been evaluated as ESM by something earlier in the process, so
 * whether it works depends on the order the suite happened to be walked, an order that changes
 * whenever a test file is added or renamed.
 *
 * The failure is not a failing test. The file throws while being imported, so its tests are never
 * registered and never reported.
 *
 * Importing it here evaluates it as ESM once, before anything requires it, so the order no longer
 * decides the outcome. `eventsource` is declared as a dev dependency of this package for the same
 * reason; test determinism depends on it.
 *
 * [Porte bun:test→vitest] No openbot isto era o preload do bunfig.toml
 * (scripts/test-preload.ts); aqui vira o setupFiles do vitest.chassis.config,
 * porque a suíte do chassis roda sob o runtime Bun e o problema é idêntico.
 */

import "eventsource";
