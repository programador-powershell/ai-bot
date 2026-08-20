import { defineConfig } from "vitest/config";

/*
 * A metade Bun da suíte (ver vitest.config.ts): os testes do chassis forkado
 * do openbot. Rodam sob o runtime Bun (`bun x --bun vitest run --config
 * vitest.chassis.config.ts`) porque o banco do chassis é `bun:sqlite` (§4.4)
 * — módulo nativo do Bun, inexistente no Node.
 */
export default defineConfig({
  test: {
    name: "chassis",
    include: ["server/tests/**/*.test.ts"],
    // O preload que o bunfig do openbot fazia: eventsource avaliado como ESM
    // antes de qualquer require() CJS do @modelcontextprotocol/sdk.
    setupFiles: ["./server/tests/support/preload.ts"],
  },
});
