# Avisos de terceiros (THIRD PARTY NOTICES)

Este repositório contém código PORTADO E ADAPTADO de projetos de terceiros.
Este arquivo preserva as atribuições exigidas pelas licenças — e as que o
próprio projeto de origem declara.

## openbot — MIT

- **O quê:**
  1. o `agent-computer/` deste repositório é porte adaptado do
     `agent-computer` do openbot (parser de snapshot ARIA com allowlist de
     roles, máquina de estados Take the Wheel, verificação de alvo de
     navegação — esta última estendida aqui com resolução de DNS —, e a forma
     geral do servidor HTTP do computador). O
     `packages/plugins/browser-runtime` deriva o contrato de cliente do mesmo
     projeto;
  2. **fork físico do chassis (Onda 1 da integração total,
     docs/integracao-openbot.md §4/§5):** o `app/` (UI React completa:
     TanStack Router/Query, Tailwind 4, shell autenticado, admin, agents,
     channels, computer, gallery, settings, skills), o servidor Hono forkado
     FUNDIDO em `server/src/` (auth better-auth + dev-actor, audit,
     channels/threads/watchdogs, components/sandboxed, computer
     gateway/policy, connectors, credentials, knowledge, plugins/MCP, db
     drizzle, config, tenant-package), os testes em `server/tests/` e
     `app/tests/`, o pacote de exemplo `examples/fintech/` e o gerador
     `scripts/generate-app-config.ts`.
- **Origem:** repositório `openbot` (CopilotKit), pinado no commit `06a1a84`,
  espelhado em `estudo-migracao/openbot` durante a migração.
- **Adaptações principais:**
  - no agent-computer (porte antigo): Bun → Node (`node:http`), sessão por
    `runtimeId`/TaskRun em vez de perfil permanente por bot (spec §3/§32),
    parser YAML do snapshot reimplementado sem a dependência `yaml`
    (subconjunto do serializador do Playwright), egress com resolução de DNS
    antes do veredito, comentários e mensagens em pt-BR;
  - no chassis (fork da Onda 1): banco relacional migrado de Postgres para
    **drizzle + `bun:sqlite`** (`chassis.db`; schemas pg-core → sqlite-core,
    transações síncronas, LISTEN/NOTIFY → anúncio in-process, pgvector fora —
    knowledge sem busca vetorial, pendência I7); testes portados de bun:test
    para vitest; exclusões do §4.1 aplicadas no primeiro gesto (`worker/`,
    `supervisor/`, `agent-bot/`, `agent-langgraph/`, `spire/` e o pacote
    `postgres` não entraram); comentários novos em pt-BR;
  - na Onda 2 (conversa = event log): **`@copilotkit/runtime` removido do
    server** — o mount do Intelligence e o runtime de chat morreram
    (`copilot.ts` ficou só com o registro de agentes e a mensagem de papel
    permanente); a conversa é servida pelo NOSSO protocolo WS
    (hello/ready/replay) sobre `Bun.serve`, e os channels leem/escrevem o
    event log; o chat do app fala esse protocolo (`app/src/lib/chat`) — o
    `@copilotkit/react-core` saiu do caminho da conversa e permanece SÓ no
    preview do playground, atrás de stub com prazo final na onda 3; decisão
    registrada da onda: `@ag-ui/*` PERMANECE como protocolo de bots externos.
- **Licença:**

```
MIT License

Copyright (c) 2026 CopilotKit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## steel-browser — Apache-2.0

O screencast do openbot (`agent-computer/src/screencast.ts`) declara derivar o
loop de servidor do **steel-browser** (Apache-2.0). O screencast ainda NÃO foi
portado para este repositório (pendência declarada da frente E8); a atribuição
fica registrada desde já porque a linhagem acompanha o porte quando ele vier.

## Chrome DevTools — BSD-3-Clause

O mesmo screencast do openbot declara derivar o mapeamento de eventos de
teclado do `InputModel.ts` do **Chrome DevTools** (BSD-3-Clause). Vale a mesma
nota acima: entra com o porte do screencast.

## Playwright — Apache-2.0

`playwright@1.62.1` é dependência (não vendorizada) do `agent-computer` — o
Chromium é baixado pelo instalador oficial do Playwright. Licença Apache-2.0,
Microsoft Corporation.
