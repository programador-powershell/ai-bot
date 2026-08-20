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
- Suíte Vitest com **1293 testes** em duas invocações: núcleo + app sob Node (825), e os 468 do chassis sob o runtime Bun (`bun:sqlite`, `Bun.serve`).

## :new: Releases Notes

### :up: V.2.1
### :warning: Latest Changes

- **Onda 2 da integração total (docs/integracao-openbot.md §5) — uma conversa:** o chassis serve `hello/ready/replay/re-hello` pelo **WS nativo do Bun** (`Bun.serve`, `server/src/stream/`) em `/v1/stream`; as 3 invariantes de ordem do stream (E3) passam SERVIDAS PELO CHASSIS com os MESMOS testes nomeados (`server/tests/stream-invariantes.test.ts`).
- **Compat dupla provada:** as transcrições reais do gateway Go (`test-fixtures/ws/*.jsonl`) reproduzidas por valor contra o transporte do chassis, e o teste "duas janelas" liga o hello do desktop e o do app forkado NO MESMO server recebendo a MESMA sessão (`server/tests/stream-compat.test.ts`).
- **Channels = event log:** a conversa das threads é o log de envelopes (`server/src/channels/conversa.ts` — prompt vira `message` durável via session bus; `GET /api/threads/:id/messages` lê do replay); mapeamento thread→sessão por identidade (o chassis.db guarda só metadados); `/api/capabilities` agora anuncia `durableHistory: true` sem mentir.
- **Chat do app religado no NOSSO protocolo:** `app/src/lib/chat/` (transporte com token no primeiro frame, resumeFrom que continua a resposta, projeção pura do replay) e a superfície `ConversaDoLog` no canal e no chat direto; `VITE_CHAT_ENABLED` agora LIGA por padrão (a flag desliga em diagnóstico).
- **RoteadorHttp ganhou a implementação Hono** (`RoteadorHono`, produção do chassis — o `/health` do oráculo responde no processo fundido); o seam mudou para fetch e o `MiniRoteador` clean-room virou dublê de teste, com a MESMA bateria rodando nas duas implementações.
- **Morte anunciada paga:** `@copilotkit/runtime` saiu do server (mount do Intelligence e runtime de chat mortos; `copilot.ts` ficou só com o registro de agentes); `@copilotkit/react-core` saiu do caminho da conversa (resta SÓ no preview do playground, atrás de stub com prazo final na onda 3). Decisão registrada: `@ag-ui/*` permanece como protocolo de bots EXTERNOS.
- Contrapressão servida pelo chassis: cliente lento leva **1013** e o `resumeFrom` recompõe exatamente o que faltou (`server/tests/stream-contrapressao.test.ts`).

### :pushpin: Fixes

- **Drain do Bun perde a borda** (Bun 1.4/Windows): `send()` feito de dentro do dispatch do callback `drain` encrava o flush do socket para sempre (buffered congela e nem polling anda). O adaptador (`conexao-bun.ts`) acorda escritores por MACROTASK e espera drenagem por polling+evento.
- **`ws.close()` do Bun descarta o que está enfileirado** (o cliente via 1006 e perdia o prefixo): o close do adaptador drena antes de fechar (linger de 5s), preservando o contrato "prefixo contíguo, depois o close frame".
- Envio sem conexão no chat do app não engole o Enter: o composer desliga com o aviso ao lado enquanto o status não é `ready` (a lição do desktop, por construção).

### :construction_worker: Refactors

- O protocolo de stream ganhou o seam `ConexaoDeStream` (`conexao.ts`): o `StreamServer` atende qualquer transporte; o RFC 6455 clean-room (`WsConn`) virou o dublê de teste/transporte Node, como o plano §3 mandava.
- Apoio de teste compartilhado (`teste-fixtures.ts`): fixtures do oráculo e o `StoreComGancho` com UMA definição para as duas suítes (Node e chassis).

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
