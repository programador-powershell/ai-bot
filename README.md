<div align="center">

# AI-BOT 2

Monorepo TypeScript — OpenBot como chassis, kernel plugável clean-room, Needle Pro orquestradora e control plane distribuído.

</div>

## :heavy_check_mark: Features

- Workspace **Bun 1.4** (`workspaces` no `package.json` raiz, lockfile único `bun.lock`).
- Kernel plugável (`harness-kernel`) + ponte OpenBot (`harness-openbot-bridge`) com transporte WS/HTTP.
- Domínios puros (`packages/domain/*`): eventos com `node:sqlite`, goals, tasks (DAG), runtime, workers e workspace.
- Plugins (`packages/plugins/*`): action-gateway, browser-runtime, cluster-scheduler, context-runtime, needle-orchestrator, runtime-snapshots, specialist-registry.
- `agent-computer`: Playwright/Chromium real com snapshot ARIA e egress anti-SSRF.
- `worker-daemon`: daemon do PC físico com executor local e Docker (dockerode) atrás do seam `ContainerRuntime`.
- Suíte com 727 testes Vitest (inclui Chromium real e SQLite real).

## :new: Releases Notes

### :up: V.1
### :warning: Latest Changes

- Toolchain migrado de pnpm para **Bun 1.4**: `workspaces` no `package.json` raiz, `packageManager: bun@1.4.0`, `bun.lock` versionado; `pnpm-lock.yaml` e `pnpm-workspace.yaml` removidos.
- `trustedDependencies: ["playwright"]` — o Bun NÃO roda postinstall de terceiros por padrão; o postinstall do Playwright é necessário para validar/baixar o Chromium (com o cache `%LOCALAPPDATA%\ms-playwright` presente não há re-download).
- Scripts passam pelo Bun: `bun run test` → `bun x vitest run` e `bun run typecheck` → `bun x tsc --build`. O Bun respeita o shebang `#!/usr/bin/env node` dos binários, então Vitest/tsc executam sob Node ≥ 24 — o Bun é o toolchain (install, lockfile, scripts), não o runtime dos testes.
- Entrada morta `shared` removida da lista de workspaces (a pasta nunca existiu; o pnpm ignorava em silêncio e o Bun recusa, com razão).

### :pushpin: Fixes

### :construction_worker: Refactors

## :wrench: Instalação

Pré-requisitos: **Bun ≥ 1.4** e **Node ≥ 24** (o Vitest e o tsc executam sob Node via shebang).

Instala as dependências do workspace (gera/valida o `bun.lock`).

```
bun install
```

Roda a suíte inteira (727 testes, inclui Chromium real via Playwright).

```
bun run test
```

Confere os tipos de todos os pacotes (project references).

```
bun run typecheck
```

## :file_folder: Diretórios

```
├── ai-bot-2
│   ├── agent-computer          # Computador do agente: Playwright/Chromium real, ARIA snapshot, egress anti-SSRF
│   ├── server                  # Montagem do orquestrador: config + kernel + plugins (só composição)
│   ├── worker-daemon           # Daemon do PC físico: 9 verbos da spec §36, executor local e Docker
│   ├── packages
│   │   ├── harness-kernel      # Kernel plugável clean-room
│   │   ├── harness-openbot-bridge  # Ponte de transporte (WS/HTTP) no estilo OpenBot
│   │   ├── domain              # events (node:sqlite), goals, runtime, tasks, workers, workspace
│   │   ├── plugins             # action-gateway, browser-runtime, cluster-scheduler, context-runtime,
│   │   │                       # needle-orchestrator, runtime-snapshots, specialist-registry
│   │   └── providers           # needle
│   ├── docs                    # m0-inventario, m1-plano, estudos
│   └── test-fixtures           # Logs reais do gateway Go para os testes de compat de replay
└── ...
```

## :rocket: Executáveis

| Nome                | Descrição                                                       |
| ------------------- | --------------------------------------------------------------- |
| `bun run test`      | Suíte Vitest completa do workspace (727 testes)                  |
| `bun run typecheck` | `tsc --build` sobre as project references de todos os pacotes    |

## :book: Documentação

### :link: [docs/](./docs)
