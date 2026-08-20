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
- **Chassis do openbot forkado** (MIT, `06a1a84`): `app/` (UI React — TanStack Router/Query + Tailwind 4) e o servidor Hono fundido em `server/src/` (auth better-auth + dev-actor, audit, channels, components, computer, connectors, credentials, knowledge, plugins/MCP), com `Bun.serve` multiplexando fetch+upgrade.
- Banco relacional do chassis em **drizzle + `bun:sqlite`** (`chassis.db`, migrações geradas) — fronteira dura com o event log (`events.db`, StorageDriver).
- Suíte Vitest com **1261 testes** em duas invocações: núcleo (os 727 de antes) + app sob Node, e os 455 do chassis sob o runtime Bun (`bun:sqlite`).

## :new: Releases Notes

### :up: V.2
### :warning: Latest Changes

- **Onda 1 da integração total (docs/integracao-openbot.md §5):** fork físico do `app/` e `server/` do openbot para dentro do repo, com as exclusões do §4.1 aplicadas no primeiro gesto (`worker/`, `supervisor/`, `agent-bot/`, `agent-langgraph/`, `spire/` e o pacote `postgres` nunca entraram).
- DB do chassis migrado de Postgres para **drizzle + `bun:sqlite`** (§4.4): schemas pg-core→sqlite-core, migrações geradas (`server/drizzle`, aplicadas no boot), trilha de auditoria append-only por triggers, transações síncronas (callback async no driver síncrono commita antes do corpo), LISTEN/NOTIFY→anúncio in-process. Nenhuma rota Postgres viva.
- **Mount do CopilotKit Intelligence fora do boot** (§4.6/R3): o server sobe SEM SaaS em modo `local` (variáveis `INTELLIGENCE_*` presentes derrubam o boot, em vez de passarem caladas); chat do app atrás da flag `VITE_CHAT_ENABLED` (desligada) até a onda 2 religá-lo no nosso protocolo WS.
- Login **dev-actor** (`OPENBOT_DEV_NO_AUTH=true`) funcionando; shell autenticado do app renderiza (home, agents, admin, settings) contra o server forkado.
- Testes do openbot portados de bun:test para **vitest** (61 arquivos); a suíte roda em duas invocações (`test:nucleo` sob Node, `test:chassis` sob Bun — `bun:sqlite` só existe no runtime Bun).
- `bunfig.toml` com `linker = "hoisted"`: o isolated do Bun 1.4 estoura MAX_PATH do Windows neste worktree profundo (ENAMETOOLONG).

### :pushpin: Fixes

- Índice de expressão `channels_recent_activity_idx` consertado à mão na migração (o drizzle-kit serializa quebrado no dialeto sqlite) e protegido por teste.
- Caminhos `file://` no Windows via `fileURLToPath` (o `.pathname` vinha `/C:/...` e quebrava o migrator e o tenant-package).

### :construction_worker: Refactors

- Transações do chassis sincronizadas (profile-store, channels, tenant-package, sync-persistence) com locks FOR UPDATE/SHARE aposentados — o `BEGIN IMMEDIATE` do sqlite é a serialização.

## :wrench: Instalação

Pré-requisitos: **Bun ≥ 1.4** e **Node ≥ 24** (o Vitest e o tsc executam sob Node via shebang).

Instala as dependências do workspace (gera/valida o `bun.lock`).

```
bun install
```

Roda a suíte inteira (duas invocações: núcleo+app sob Node e chassis sob Bun, inclui Chromium real via Playwright).

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
│   ├── app                     # UI forkada do openbot (React 19, TanStack Router/Query, Tailwind 4)
│   ├── server                  # Chassis Hono forkado (src/*) FUNDIDO com a montagem do kernel (src/montagem)
│   ├── examples/fintech        # Tenant package default (agents/channels/model em YAML)
│   ├── scripts                 # generate-app-config.ts (gera app/src/lib/generated)
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

| Nome                    | Descrição                                                                     |
| ----------------------- | ----------------------------------------------------------------------------- |
| `bun run test`          | Suíte Vitest completa (núcleo+app sob Node e chassis sob Bun)                  |
| `bun run test:nucleo`   | Só o núcleo (packages/daemon/agent-computer/montagem) e o app, sob Node        |
| `bun run test:chassis`  | Só os testes do chassis forkado, sob o runtime Bun (`bun:sqlite`)              |
| `bun run typecheck`     | `tsc --build` sobre as project references de todos os pacotes                  |
| `server: bun run dev`   | Sobe o chassis com `Bun.serve` (`/health`, auth, admin, canais)                |
| `app: bun run dev`      | Vite do app (proxy `/api` → server; `APP_PORT`/`SERVER_PORT`)                  |

## :computer: Acesso

Para subir o server local: na pasta `server/`, com `DATABASE_URL=file:./chassis.db`,
`KEY_ENCRYPTION_KEY` (32 bytes base64), `MANAGED_AGENT_AG_UI_URL` e
`OPENBOT_DEV_NO_AUTH=true`, rode `bun run dev` (porta `PORT`, padrão 3001) e o
`bun run dev` do `app/` (padrão 3010).

Para o primeiro acesso use o **dev-actor** (`OPENBOT_DEV_NO_AUTH=true`): toda
requisição entra como `dev@openbot.local` (administrador) — só em
desenvolvimento local; o chat fica atrás da flag `VITE_CHAT_ENABLED`
(desligada até a onda 2).

## :book: Documentação

### :link: [docs/](./docs)
