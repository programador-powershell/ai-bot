import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/*
 * A suíte roda em DUAS invocações porque os runtimes são dois (Onda 1):
 *  - esta config (runtime Node, `bun x vitest run`): o núcleo que já existia
 *    (packages/worker-daemon/agent-computer/montagem, com node:sqlite) e o
 *    app forkado (happy-dom);
 *  - vitest.chassis.config.ts (runtime Bun, `bun x --bun vitest run`): os
 *    testes do chassis forkado, que falam com o chassis.db via `bun:sqlite`
 *    — módulo que só existe sob o Bun.
 * Rodar TUDO sob Bun hoje quebra a limpeza dos testes com arquivo sqlite no
 * Windows (EBUSY: o node:sqlite do Bun segura o handle no close) — visto na
 * onda 0; quando isso sarar, as duas invocações podem voltar a ser uma.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "nucleo",
          exclude: [...configDefaults.exclude, "server/tests/**", "app/**"],
        },
      },
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./app/src", import.meta.url)),
          },
        },
        test: {
          name: "app",
          environment: "happy-dom",
          include: [
            "app/tests/**/*.test.{ts,tsx}",
            "app/src/**/*.test.{ts,tsx}",
          ],
          server: {
            deps: {
              // Externalizados, esses pacotes chegam ao Node com import de
              // .css dentro do dist (index.css do react-core) e o loader ESM
              // do Node não sabe o que fazer; inline faz o Vite transformá-los
              // como faz com o código do app.
              inline: [/@copilotkit\//, /@ag-ui\//],
            },
          },
        },
      },
    ],
  },
});
