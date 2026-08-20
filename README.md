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
- **Uma conversa só (Onda 2):** o chassis serve o protocolo `hello/ready/replay/re-hello` pelo WS nativo do Bun em `/v1/stream`; os channels leem/escrevem o event log (a conversa É o log) e o chat do app fala o mesmo protocolo do desktop Tauri — compat dupla provada por valor contra as fixtures do oráculo Go.
- Banco relacional do chassis em **drizzle + `bun:sqlite`** (`chassis.db`, migrações geradas) — fronteira dura com o event log (`events.db`, StorageDriver).
- **Governo unificado (Onda 3):** montagem COMPLETA do kernel no server de produção (os 7 plugins + seams declarados), motor de regras clean-room no action-gateway (cel-js fora do lockfile), MCP e componentes generativos entrando pelo funil (grants por chamada, unknown=write), aprovação humana durável que renasce após reinício com o prazo original, e rotas admin de auditoria sobre os envelopes.
- Suíte Vitest com **1325 testes** em duas invocações: núcleo + app sob Node (844), e os 481 do chassis sob o runtime Bun (`bun:sqlite`, `Bun.serve`).

## :new: Releases Notes

### :up: V.2.2
### :warning: Latest Changes

- **Onda 3 da integração total (docs/integracao-openbot.md §5) — governo unificado:** o server de produção monta o kernel COMPLETO (`server/src/montagem/montagem.ts` lista os 7 plugins prontos + seams provisórios DECLARADOS em `seams.ts` — Toolbox, modelo M2 e TaskExecutor da Onda 5 falham alto com o motivo, nunca fingem), e o `ready` do stream anuncia o **catálogo REAL** do specialist-registry, lido a cada hello (overlay a quente vale na conexão seguinte).
- **cel-js FORA do lockfile (§4.5):** o motor das regras do computer gateway é reimplementação clean-room própria (`packages/plugins/action-gateway/src/rules.ts` — parse inteiro antes de avaliar, identificador ausente falha fechado, curto-circuito absorve só erro de resolução); o envelope govern() do openbot foi mantido e a bateria de fixtures passou intacta. Política declarada TEM teste provando que é lida (`rules.test.ts`).
- **MCP e componentes generativos pelo funil:** `/api/plugins/call`, `/api/components/:name/decision` e `/:name/call` entram pelo action-gateway (`server/src/governo/{funil,executor}.ts`) — grants por especialista conferidos POR CHAMADA, `not_granted` auditado, ferramenta MCP não classificada como leitura = ESCRITA também no risco do portão (escrita pergunta na política "aprovar edições"); o teste-espelho "efeito sem decisão do portão não executa" cobre as duas rotas (`server/tests/governo-funil.test.ts`).
- **Aprovação durável que RENASCE:** `rearmPendingApprovals()` devolve waiter e prazo aos pedidos órfãos de reinício — o prazo continua contando do **ts original** (vencido durante a queda recusa já), decisão pós-reinício re-executa com os args do `tool.call` durável; na UI forkada o cartão (`approval-card.tsx`) é projeção do replay (`approval.request` sem decisão = cartão de novo na tela) e a decisão viaja pelo stream (`approval.decision`).
- **Rotas de auditoria sobre os ENVELOPES** (`/api/admin/envelopes*`): sessões, replay recortado nos kinds de auditoria (tool.call/tool.result/approval.*) com payload redigido pela MESMA régua da trilha relacional, e as pendências vivas por sessão.
- **Morte anunciada paga (prazo da Onda 2/3):** o import inerte de `@copilotkit/react-core/v2` em `chat-transcript.tsx` morreu — a linha de ferramenta do transcript é desenho próprio (`ToolLine`); o que resta de react-core é SÓ o preview do playground.

### :pushpin: Fixes

### :construction_worker: Refactors

- `montarServidor` virou `montarNucleo` + transporte: o chassis (Bun.serve) e o sidecar Node montam o MESMO núcleo por uma lista só; o `StreamServer` e as rotas do transporte aceitam catálogo como PROVEDOR vivo (lista fixa continua valendo para teste/config estática).
- O boot do chassis (`server/src/index.ts`) passou a receber event log e session bus do kernel (`ctx.eventos`/`ctx.sessionBus`); o encerramento desmonta pelo `dispose()` do kernel.

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
