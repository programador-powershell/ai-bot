# Integração total com o openbot — revisão de arquitetura e plano

> Ordem do dono: *"revise se está com a arquitetura correta conforme desenho e
> com integração total com openbot"*. Este documento é a revisão (leitura, sem
> uma linha de implementação): a matriz camada a camada contra o desenho da
> spec §2, o que o Bun 1.4 homologado muda nas decisões do M0, e o plano em
> ondas do fork do chassis do openbot para dentro do ai-bot-2.
>
> Base: ai-bot-2 em `b3cd6db` (M11) + working tree da migração Bun em curso;
> openbot pinado em `06a1a84` (MIT); m0-inventario.md e m1-plano.md desta pasta.
> Auditado em 2026-08-20.

---

## 1. O desenho que serve de régua

O §2 da spec fixa o caminho de uma intenção do usuário até um arquivo que
existe de verdade:

```
USER → OPENBOT UI → OPENBOT SERVER (auth / policy / audit / action gateway)
     → HARNESS KERNEL → NEEDLE
     → CONTROL PLANE (Goal / DAG / Task / Scheduler / WorkspacePlan / Lease)
     → WORKER DAEMONs → container efêmero → staging → fence → promote → PUTER
```

A revisão confere o ai-bot-2 REAL contra cada elo. O resumo honesto antes da
matriz: **o miolo está construído e testado; as duas pontas não existem** — a
ponta de cima (UI e server do openbot) nunca foi forkada, e a ponta de baixo
(Puter) nunca foi começada. E há um buraco no meio: o scheduler e o
worker-daemon estão ambos prontos, mas **não se falam** — o elo
`CONTROL PLANE → WORKER DAEMONs` é hoje um seam sem implementação.

---

## 2. Matriz camada a camada

Legenda: **✔** no lugar (código + teste) · **✔ solto** pronto mas NÃO montado
no server · **FALTA** não existe · **DIVERGE** existe, mas de forma diferente
do desenho.

| Elo do desenho | Estado | Onde está no ai-bot-2 | Nota |
| --- | --- | --- | --- |
| OPENBOT UI | **FALTA** | — (não há `app/` no ai-bot-2) | O fork nunca aconteceu. A UI do produto hoje é o `apps/desktop` do ai-bot antigo (Tauri/React), fora deste repo, falando com o gateway **Go** |
| OPENBOT SERVER — auth | **FALTA** | — | Só existe token compartilhado no transporte. Nada de better-auth, roles, guards, dev-actor |
| OPENBOT SERVER — policy | **DIVERGE** (por decisão) | `packages/plugins/action-gateway/src/gate.ts` | D3/R5: o Gate portado é o motor único; CEL não entrou. A divergência é deliberada e este doc propõe mantê-la (ver §4.5) |
| OPENBOT SERVER — audit | **✔ solto / parcial** | `action-gateway/src/service.ts` | audit-before-act existe (envelopes duráveis `tool.call`/`tool.result`, falha de escrita IMPEDE o efeito — mais forte que o oráculo). Faltam o leitor e as rotas de auditoria do openbot (`server/src/audit.ts`) |
| OPENBOT SERVER — action gateway | **✔ solto** | `packages/plugins/action-gateway` | Gate + govern() + Tool Output Gateway + Artifact Store prontos e testados — e **não montados**: `server/src/montagem.ts` sobe só event-log, session-bus e transporte |
| OPENBOT SERVER — channels/threads | **DIVERGE** | `harness-openbot-bridge/src/{stream,eventbus}.ts` | Nosso protocolo hello/ready/replay/re-hello (forma do stream.go, compat E3) no lugar dos channels do openbot. A conversa é o event log — decisão R3, correta e mantida |
| OPENBOT SERVER — MCP | **FALTA** | — | O padrão do openbot (grant primeiro, `mcp.*` na mesma policy, não-leitura=escrita, audit de `not_granted`) era KEEP do M0 e não foi trazido |
| OPENBOT SERVER — componentes generativos | **FALTA** | — | Contrato manifest/grants/decisão-por-render era KEEP do M0 e não foi trazido |
| HARNESS KERNEL | **✔** | `packages/harness-kernel` | Clean-room completo (E1): Context, plugin 3 formas, Service, ctx.effect, 5 modos de dispatch, compose |
| Event log / StorageDriver | **✔** | `packages/domain/events` | `node:sqlite` atrás de `StorageDriver`; mutex por sessão; teste de corrida; fixtures do oráculo Go |
| Transporte WS | **✔** (implementação provisória) | `harness-openbot-bridge/src/{ws,router}.ts` | RFC 6455 clean-room e roteador HTTP mínimo escritos **porque "Hono aguarda TI/SI"**. Com Bun 1.4 + fork, ambos trocam de implementação sob o mesmo seam (`RoteadorHttp`) — o clean-room vira fallback/teste |
| NEEDLE | **✔** | `packages/plugins/needle-orchestrator` + `packages/providers/needle` | Cascata com constantes calibradas + golden tests; provider HTTP loopback com `Ready()` que degrada. "Cérebro, não autoridade" (spec §6) respeitado |
| Registry de especialistas | **✔ solto** | `packages/plugins/specialist-registry` | Catálogo como dado, overlay tudo-ou-nada, onChange — pronto e não montado (a montagem ainda usa lista provisória por parâmetro) |
| Context runtime + agent loop | **✔ solto** | `packages/plugins/context-runtime` | history/fitToContext/cápsula/checkpoint + agent loop no funil (E6, M1 leva 3) — não montado |
| CONTROL PLANE — Goal/DAG/Task | **✔** | `packages/domain/{goals,tasks}` | Tetos 3/4/24 duráveis por Goal (D6), DAG, refusal conservador, journal, readiness |
| CONTROL PLANE — Scheduler | **✔ motor / FALTA o elo** | `packages/plugins/cluster-scheduler` | `chooseWorker` (§28) e `CrewEngine` (ondas/recusa/escalação) prontos — mas o `TaskExecutor` é um seam **só implementado em teste**. Não existe cliente HTTP dos verbos §36: o scheduler NÃO liga o worker-daemon de verdade |
| CONTROL PLANE — WorkspacePlan/staging/fence/promote | **✔** | `packages/domain/workspace` | Plano congelado, materialização, Promote com cerca worker+época. Backend v1 é **local** — o Puter troca o backend depois sem mudar a cerca (assim foi desenhado) |
| CONTROL PLANE — Lease/época | **✔** | `packages/domain/workers` | Fleet com época que sobrevive a reinício, as 3 saídas do Acquire, seam FleetState (memória/arquivo) |
| WORKER DAEMONs | **✔ ilhado** | `worker-daemon/` | Os 9 verbos da spec §36, token de enrolamento em tempo constante, reporta sem seq, publica-e-para, sem Docker passthrough. Ninguém o chama em produção |
| Container efêmero | **✔** | `worker-daemon/src/docker-runtime.ts` | dockerode (aprovado M11) com hardening §37 (CapDrop ALL, no-new-privileges, tetos, rede fail-closed); detecção honesta sem engine |
| RuntimeResolver | **FALTA** | — (`domain/runtime` tem só fingerprint/requirements) | Nada resolve fs/git/proc no runtime da TAREFA quando ele não é local — a dívida 6 do cluster continua aberta |
| PUTER | **FALTA** | — | Nem `providers/puter` nem `plugins/puter-workspace` (previstos no m1-plano §1) existem. Promote hoje entrega em pasta local |
| agent-computer | **✔** | `agent-computer/` | Playwright real, sessão por runtimeId (cirurgia §3/§32 feita), ARIA teto 200, Take the Wheel, egress anti-SSRF. Pendência declarada: screencast fora |
| browser-runtime / runtime-snapshots | **✔ soltos** | `packages/plugins/{browser-runtime,runtime-snapshots}` | Seam `ctx.browser` task-scoped e inventário de snapshots com LRU (M10/M11) — não montados |

### As três leituras que a matriz entrega

1. **A arquitetura interna está correta e na ordem certa.** Kernel → events →
   transporte → gateway → needle → control plane → daemon → container →
   staging/fence/promote seguem o desenho, com as invariantes portadas COM os
   testes que as definem. Nenhuma camada foi construída fora do lugar.
2. **A divergência central é uma só: o server é montagem própria, não o do
   openbot.** Foi a consequência direta do R1 do M0 (Bun barrado → sem o
   chassis Hono+Bun → transporte clean-room "aguardando TI/SI"). Com o Bun 1.4
   homologado, essa causa caiu — e com ela cai a justificativa de manter o
   server como reescrita. Auth, channels-admin, MCP, componentes generativos,
   knowledge, connectors e credentials eram KEEPs do M0 que ficaram órfãos da
   decisão; o fork os traz de volta.
3. **Os elos que faltam são exatamente os do fim do fluxo:** UI (openbot),
   scheduler→daemon (o executor real), RuntimeResolver e Puter. Nenhum deles é
   redesenho — todos têm o seam esperando (TaskExecutor, backend do
   WorkspaceManager, RoteadorHttp).

---

## 3. O que o Bun 1.4 homologado muda — e o que não muda

### Caduca

| Decisão do M0 | Situação nova |
| --- | --- |
| **R1** (Bun → Node 24 + pnpm) | Caduca. O repo já está migrando (working tree: `packageManager: bun@1.4.0`, `bun.lock`, scripts `bun x`). O custo de porte "9 pontos Bun" do openbot **evapora**: `Bun.serve`, `createBunWebSocket` e `bun:sqlite` rodam nativos |
| `@hono/node-server` / `@hono/node-ws` (m0 §3.1) | Saem da lista — eram os adaptadores para Node. O Hono entra pelo fork e fala com `Bun.serve` direto |
| WS RFC 6455 clean-room como transporte de produção | Vira implementação de fallback/teste do seam. A produção usa o WS nativo do Bun via Hono — menos código artesanal para manter (I6 — deadlines por operação — continua redesenhado sobre o contrato "Lagged → 1013 → replay", que é o que os testes fixam) |

### NÃO caduca (e o doc registra por quê)

| Decisão | Continua valendo porque |
| --- | --- |
| **R3 — SEM CopilotKit Intelligence** | I1 é incompatibilidade de produto, não de runtime: conversa no SaaS contradiz o local-first e o boot com licença obrigatória. **O log de eventos nosso É a conversa.** O `copilot.ts` do openbot monta o runtime "always in Intelligence mode" — esse mount não sobe aqui |
| **R2 — SEM Postgres nesta estação** | Homologação e local-first não mudaram. O que muda é o caminho: o drizzle do fork troca `drizzle-orm/bun-sql`+`postgres` por **`drizzle-orm/bun-sqlite`** (driver `bun:sqlite` nativo, zero dependência nova) para as tabelas do chassis. **A interface `StorageDriver` continua a verdade** para o event log (ver §4.4) |
| **R5/I4 — um motor de política só (Gate)** | O incidente "política declarada e não lida" (3x na casa) é a razão, e ela não tem relação com Bun. cel-js chega com o fork e **sai na cirurgia** (§4.5) |
| **R6/I3 — botId → {taskRunId, workerId, leaseEpoch, runtimeId}** | Cirurgia de modelo, não de runtime. Metade já feita (agent-computer, supervisor→docker-runtime); o restante está no server/app do openbot e entra no plano (§5, onda 4) |
| **R9 — kernel clean-room** | O harness continua developer preview de um fork; nada disso mudou com Bun. O kernel é nosso e fica |
| **R10 — Needle via HTTP** | cgo continua sem tradução; o provider HTTP está pronto e testado |
| **R7/R8, D1–D7** | Lease com época, container efêmero, sequenciador no orquestrador, executor server-side — decisões de arquitetura do cluster, indiferentes ao runtime |

**Verificação obrigatória da migração Bun** (a onda 0 do §5): o driver de
eventos usa `node:sqlite` (`DatabaseSync`); o Bun implementa `node:sqlite`
sobre o motor do `bun:sqlite`, mas a prova é a suíte — em especial o teste de
corrida (200 appends, RS5) e os testes Windows de rename/descritor — verde
**sob Bun** antes de qualquer fork por cima.

---

## 4. O plano da integração total: forkar o chassis

### 4.1 O que entra e o que não entra

**Entra** (do pin `06a1a84`, MIT, com atribuição no THIRD_PARTY_NOTICES.md):

- `openbot/app/` → `ai-bot-2/app/` — a UI React (TanStack Router/Query,
  Tailwind 4, shadcn/base-ui): shell autenticado, admin, agents, channels,
  computer (Take the Wheel/needs-you), gallery de componentes, settings, skills.
- `openbot/server/` → **fundido** em `ai-bot-2/server/` — Hono + Bun.serve:
  auth (better-auth + roles/guards + dev-actor), audit (store+reader),
  channels (rotas/threads/watchdogs), components (store/routes/sandboxed),
  computer (gateway/routes/policy — com cirurgia, §4.5), connectors,
  credentials, knowledge (sem pgvector), plugins/MCP (catalogue/mcp/store),
  db (drizzle, com cirurgia §4.4), config, tenant-package.

**Não entra** (já decidido no M0 e reconfirmado):

- `worker/` (esqueleto de 3 linhas — o nosso worker-daemon é o real),
- `supervisor/` e `agent-computer/` deles (**já portados COM a cirurgia** —
  `worker-daemon/src/docker-runtime.ts` e `ai-bot-2/agent-computer/`),
- `agent-bot/`, `agent-langgraph/`, `spire/`, `scripts/start.sh`,
- o mount do CopilotKit Intelligence (`copilot.ts` — ver §4.6),
- `postgres` (o pacote npm) e qualquer caminho Postgres.

### 4.2 Como o server deles e o nosso viram UM

O princípio do m1-plano §1 não muda: **o server é montagem, não lógica**. O
fork não substitui a montagem — ele dá a ela o chassis HTTP que faltava:

1. O `RoteadorHttp` (seam que já existe em `harness-openbot-bridge/src/router.ts`)
   ganha a implementação **Hono**; o roteador mínimo clean-room vira o dublê de
   testes.
2. `Bun.serve` multiplexa fetch+upgrade (o desenho original do
   `openbot/server/src/index.ts`); o upgrade entrega no NOSSO protocolo
   hello/ready/replay (`stream.ts`) — os channels do openbot não trazem
   transporte próprio de conversa (R3).
3. Cada grupo de rotas do openbot entra como **plugin do kernel** via bridge
   (auth, audit-reader, components, computer, plugins/MCP, knowledge,
   connectors, credentials) — testável sem processo de pé, como os demais.
4. `montagem.ts` passa a listar TODOS os plugins: os 3 de hoje + os 7 prontos e
   soltos (action-gateway, specialist-registry, needle-orchestrator,
   context-runtime, cluster-scheduler, browser-runtime, runtime-snapshots) +
   os novos do fork. Montagem que cresce é o sinal de que o desenho estava
   certo — lógica nova em `montagem.ts` continua proibida.

### 4.3 Onde o que já está pronto se encaixa (nada disso se refaz)

| Peça pronta | Papel na integração |
| --- | --- |
| **agent loop** (`context-runtime/loop.ts`) | O executor server-side (R4/D5) que o openbot não tinha — resolve a I2 por construção. Os channels forkados viram espectadores do log; o loop roda headless |
| **agent-computer** (nosso) | O `computer/client.ts` do server forkado passa a apontar para ele (mesmos verbos HTTP), via o plugin `browser-runtime` (`ctx.browser`, task-scoped §32) |
| **worker-daemon + docker-runtime** | Substitui o `supervisor/` do openbot por inteiro; o `computer/supervisor.ts` do server forkado (client do supervisor deles) é aposentado na onda 4 |
| **action-gateway (Gate + govern)** | O motor que o `computer/gateway.ts` forkado passa a consultar (§4.5); o funil único de TODO efeito — MCP e componentes generativos inclusive |
| **domain/* + cluster-scheduler** | O control plane que o openbot simplesmente não tem (lá não há fila/lease/scheduler) — entra intacto, ganhando na onda 5 o executor real |
| **needle-orchestrator + provider** | O degrau NEEDLE do desenho; intocado |
| **event log + bridge (stream/eventbus)** | A conversa e o replay — o que substitui o Intelligence (R3); os channels forkados leem/escrevem AQUI |

### 4.4 Banco: avaliação e proposta (drizzle × StorageDriver)

O openbot usa drizzle com schemas `pg-core` sobre `drizzle-orm/bun-sql` +
`postgres`. Avaliação dos caminhos com Bun homologado e sem Postgres:

- (a) Reescrever os stores do openbot sobre o nosso `StorageDriver` — custo
  alto (dezenas de tabelas relacionais viram chave-valor forçado) e joga fora
  os testes deles;
- (b) Trazer drizzle + `bun:sqlite` (`drizzle-orm/bun-sqlite`) para o chassis —
  cirurgia mecânica `pg-core`→`sqlite-core`, mantém os stores e testes do
  openbot quase 1:1, zero dependência nativa nova;
- (c) Postgres — barrado (R2).

**Proposta: (b), com fronteira dura.** Dois arquivos, duas verdades que não se
misturam:

| Arquivo | Dono | Conteúdo |
| --- | --- | --- |
| `events.db` | **StorageDriver** (`domain/events`, `node:sqlite`) | Event log, sessões, seq, replay, truncate, aprovações duráveis — **a verdade do produto**. Drizzle NUNCA toca aqui |
| `chassis.db` | drizzle + `bun:sqlite` | O relacional do chassis: auth/roles, grants de componentes e MCP, policy-config, audit relacional do openbot, knowledge (sem vetor), connectors, credentials |

A interface `StorageDriver` continua a verdade e o ponto de troca para um
deploy multiusuário futuro. pgvector segue **pendência declarada** (I7) — o
knowledge forkado entra sem busca vetorial.

### 4.5 Política: o govern() deles com o motor nosso (cel-js sai)

O `computer/gateway.ts` forkado mantém o envelope govern() (audit-before-act,
ref resolvido server-side, policy relida a cada decisão) — mas quem decide é o
**Gate** do action-gateway, não CEL. O `policy-store` vira configuração do
Gate; o default permissivo-auditado do openbot (`allow:["true"]`) é substituído
pelo fail-closed do Gate (desconhecido = ask). `cel-js` chega no fork físico e
**é removido na onda 3** — dois motores é o cenário I4, e essa decisão é
anterior e independente do Bun. Se o dono quiser CEL como linguagem de regra,
a discussão é "CEL como sintaxe DO Gate", nunca segundo motor.

### 4.6 CopilotKit: o corte honesto

O boot do openbot **aborta sem licença Intelligence** (I1 — "no degraded
mode"). Logo o fork físico já nasce com o mount do `copilot.ts` fora do boot;
o chat do app (que hoje fala `@copilotkit/react-core`) fica atrás de flag até a
onda 2 religá-lo no nosso protocolo WS. `@copilotkit/runtime` e
`@copilotkit/react-core` entram no lockfile do fork **com prazo de morte
declarado** (onda 2/3) — dependência que "ia sair depois" e ficou é como o
apps.zip de 5 GB: entra no histórico calada. `@ag-ui/*` sai junto, a menos que
a onda 2 decida mantê-lo como protocolo de bots EXTERNOS (decisão registrada
na onda, não default).

### 4.7 A cirurgia botId → execution target (o resto dos 12 pontos)

Feito: `agent-computer/` (sessões/perfis por runtimeId) e `supervisor` →
`docker-runtime.ts` (labels por taskRun/época). Restam no chassis forkado
(ocorrências de `botId` no pin, a tratar na onda 4):

- `server/src/computer/gateway.ts`, `client.ts`, `routes.ts`, `schema.ts` —
  sessão/target por `{taskRunId, runtimeId}`;
- `server/src/computer/supervisor.ts` — aposentado (worker-daemon assume);
- `server/src/channels/stall-guard.ts`, `turn-watchdog.ts` — passam a vigiar
  execuções (TaskRun), não bots;
- `server/src/plugins/store.ts`, `routes.ts` — grants MCP por especialista
  (chave do Gate), não por botId;
- `server/src/index.ts` — composição;
- `app/src/components/computer/needs-you.ts`,
  `app/src/lib/copilot/computer-activity.ts`, `app/src/lib/agents/bot-names.ts`
  — presença/atividade lidas do runtime-snapshots (estado da TAREFA).

---

## 5. O plano em ondas (cada uma entregável e testável)

O padrão da casa: onda fecha com aceite rodando, ou não fecha.

### Onda 0 — Bun verde (fechar o que está no working tree)

- **Entrega:** migração pnpm→Bun 1.4 committada: `bun install`, `bun x tsc
  --build`, `bun x vitest run` — suíte INTEIRA verde sob Bun no Windows.
- **Aceite:** teste de corrida do event log (RS5) e testes de
  rename/descritor/fsync passando sob Bun (`node:sqlite` sobre o motor do
  Bun provado, não presumido); `trustedDependencies` do playwright honrado
  (postinstall roda). Corrigir o resíduo do working tree: `workspaces` lista
  `"shared"` e o diretório não existe.

### Onda 1 — Fork físico: o chassis de pé

- **Entrega:** `app/` e `server/` do pin `06a1a84` dentro do ai-bot-2;
  exclusões do §4.1 aplicadas no primeiro commit (nunca "depois"); db em
  drizzle+`bun:sqlite` (§4.4) com migrações geradas; mount do Intelligence
  fora do boot (§4.6); testes deles portados bun:test→vitest.
- **Aceite:** `bun x tsc --build` e a suíte verde; server sobe com
  `Bun.serve`, `/health` ok, login dev-actor funciona; app renderiza o shell
  autenticado (chat atrás de flag, desligado); NENHUMA rota Postgres viva;
  THIRD_PARTY_NOTICES atualizado (MIT openbot + Apache-2.0/BSD-3 remanescentes).

### Onda 2 — Uma conversa: o event log como verdade dentro do chassis

- **Entrega:** channels do openbot lendo/escrevendo o NOSSO event log (session
  bus); WS do chassis servindo hello/ready/replay/re-hello via Bun nativo;
  `RoteadorHttp` ganha a implementação Hono (clean-room vira dublê de teste);
  chat do app religado no nosso protocolo (CopilotKit react-core sai do
  caminho da conversa).
- **Aceite:** as 3 invariantes de ordem do stream (E3) passam servidas pelo
  chassis; **compat dupla:** o desktop Tauri atual E o app forkado conectam no
  mesmo server e renderizam a mesma sessão gravada do oráculo Go; contrapressão
  (1013 → replay) com socket lento.

### Onda 3 — Governo unificado: todos os efeitos num funil só

- **Entrega:** montagem completa (os 7 plugins soltos + os do fork);
  `computer/gateway.ts` decidindo pelo Gate (cel-js REMOVIDO do lockfile);
  MCP (plugins/*) e componentes generativos entrando pelo action-gateway
  (grants por especialista, decisão por chamada, `not_granted` auditado,
  não-leitura=escrita); rotas de leitura de auditoria sobre os envelopes.
- **Aceite:** bateria do permissions_test + fixtures govern intactas; o
  teste-espelho "efeito sem decisão do portão não executa" cobre TAMBÉM rota
  MCP e render de componente; aprovação pendente sobrevive a reinício e
  REAPARECE na UI forkada.

### Onda 4 — Cirurgia botId no chassis

- **Entrega:** os pontos do §4.7; `computer/*` do server falando com o NOSSO
  agent-computer via `ctx.browser` (task-scoped); `computer/supervisor.ts`
  aposentado; presença da UI alimentada pelo runtime-snapshots.
- **Aceite:** browser nasce no open da execução e morre no close (nenhum
  perfil permanente por bot); Take the Wheel recusa (não enfileira) com o
  cartão na UI forkada; stall-guard/watchdog disparam por TaskRun.

### Onda 5 — O elo que falta: scheduler → worker-daemon de verdade

- **Entrega:** `TaskExecutor` concreto — cliente HTTP dos 9 verbos §36 com
  lease/época viajando no despacho; **RuntimeResolver** em `domain/runtime`:
  admissão por requisitos (§28 já pronto) + resolução de fs/git/proc no
  runtime da TAREFA (host|docker|wsl|vps — fecha a dívida 6).
- **Aceite:** integração loopback ponta a ponta: Goal → plano congelado →
  despacho → container efêmero → staging → **fence** → promote; teste de
  preempção (época velha publica → recusado, resultado não vira verdade);
  daemon que perde o orquestrador publica e PARA; reinício do server no meio
  de uma onda não zera débito nem duplica despacho.

### Onda 6 — Puter: a ponta de baixo

- **Entrega:** `packages/providers/puter` + `packages/plugins/puter-workspace`
  — backend do WorkspaceManager (materializa Puter→disco local; promote
  staging→Puter), árvore `/Bots/<oficio>/`, `/Goals/<id>/`, `/Shared/` por
  conta (1 conta = 1 pessoa).
- **Aceite:** a MESMA suíte do manager passa com o backend puter (a cerca não
  muda uma linha — a promessa do v1 cobrada aqui); artefato promovido aparece
  no Puter e o não-promovido NUNCA; sobe metadado/resultado, nunca o
  descartável do container (spec: snapshot em duas camadas).

### Onda 7 — Paridade da UI e desligamento do Go

- **Entrega:** as superfícies do PRODUTO (o mapa do Stage.tsx: rails, avatares
  mulberry32, medidor, cartões Approval/Ask/Delegation/Notice, busca) portadas
  para dentro do app forkado; Tauri continua o host desktop (webview no app);
  screencast do agent-computer (a pendência declarada) entra atrás do session
  guard.
- **Aceite:** roteiro de paridade das 10 superfícies com replay de sessões
  reais do Go — mesma tela, cartões fechados ao reabrir; avatares byte-a-byte
  (RS8 — conceito visual é do dono, porte literal); só então a remoção do
  `services/gateway` Go vira tarefa própria referenciando a suíte que o
  substituiu.

Dependências entre ondas: 0→1→2→3→4 em série (cada uma monta sobre a
anterior); a 5 depende só da 0 (pode andar em paralelo com 2–4); a 6 depende
da 5; a 7 fecha tudo.

---

## 6. Dependências novas que o fork puxa (registro de homologação)

O dono aprovou a **integração total** — esta lista registra a homologação
implícita, versão do pin, com destaque de risco. Ainda assim, pela política da
casa (aprovação por dependência), a tabela segue para TI/SI como registro.
Já homologados antes (não relistados): Bun 1.4, playwright 1.62.1, dockerode,
vitest, typescript, @xyflow/react, thinking-orbs, xterm.js.

### 6.1 Server (runtime)

| Dependência | Versão (pin openbot) | Para quê | Risco/observação |
| --- | --- | --- | --- |
| `hono` | ^4.10.0 | Framework HTTP do chassis | Baixo. MIT, sem nativo. Elimina o roteador clean-room de produção |
| `drizzle-orm` | ^0.45.2 | ORM do `chassis.db` (driver `bun:sqlite`) | Baixo. A fronteira do §4.4 impede que vire caminho do event log |
| `better-auth` + `@better-auth/drizzle-adapter` | ^1.6.27 | Auth local (sessões, roles) | **DESTAQUE:** framework de auth é superfície de segurança — revisar config (sem provedores externos nesta estação; senhas nunca em log); era DELETE no M0 por vir acoplado ao Intelligence, volta aqui como auth LOCAL por decisão própria |
| `@modelcontextprotocol/sdk` | ^1.30.0 | Cliente MCP dos plugins | Médio: superfície de rede para servidores MCP de terceiros — só catálogo governado pelo Gate, fail-closed já é a regra portada |
| `yaml` | ^2.9.0 | Config/tenant-package | Baixo |
| `cel-js` | ^0.8.2 | Motor de política do openbot | **DESTAQUE: entra no fork e SAI na onda 3** (R5/I4). Não escrever regra nova em CEL no intervalo |
| `@copilotkit/runtime` | 1.67.1 | Runtime do chat openbot | **DESTAQUE: prazo de morte onda 2/3** (§4.6). Nunca em modo Intelligence |
| `@ag-ui/client` | 0.0.57 | Protocolo de bots externos | **DESTAQUE:** sai com o CopilotKit, salvo decisão registrada na onda 2 de mantê-lo para bots externos |
| `postgres` | — | — | **NÃO ENTRA** (R2). Morre na onda 1 com a troca de driver |

### 6.2 App (runtime)

| Dependência | Versão | Para quê | Risco/observação |
| --- | --- | --- | --- |
| `react`, `react-dom` | ^19.2.0 | Base da UI | Baixo (upgrade do 18 da casa — conferir com o padrão dos produtos Multiplike) |
| `@tanstack/react-router`, `react-query`, `react-form` | ^1.170 / ^5.101 / ^1.33 | Rotas/dados/forms | Baixo; ecossistema maduro |
| `zod` | ^4.4.3 | Schemas | Baixo — atenção: major 4 (o m0 §3.1 propunha ^3; alinhar) |
| `tailwindcss` 4 + `@tailwindcss/vite`, `tailwind-merge`, `tw-animate-css`, `class-variance-authority`, `clsx` | pin do fork | Estilo | **DESTAQUE de padrão:** a casa usa styled-components nos produtos — registrar que o ai-bot-2 herda Tailwind do chassis (decisão de produto, não técnica) |
| `@base-ui/react`, `shadcn`, `@shadcn/react` | pin do fork | Componentes | Médio: preferir componentes VENDORIZADOS (gerados no repo) a dependência viva do gerador |
| `@tabler/icons-react`, `@fontsource-variable/inter`, `motion` | pin do fork | Ícones/fonte/animação | Baixo |
| `streamdown`, `prompt-area` | ^2.5.0 / ^0.6.3 | Render de markdown em stream / input do chat | **DESTAQUE supply-chain:** pacotes pequenos e menos conhecidos — inspecionar código no install e pinar exato |
| `boring-avatars` | ^2.0.4 | Avatares do openbot | **DESTAQUE: remover na onda 7** — o conceito de avatar do produto é do dono (mulberry32, 8 campos); dois sistemas de avatar é confusão visual |
| `@copilotkit/react-core`, `@ag-ui/core`, `better-auth` (client) | pin do fork | Chat/protocolo/auth | react-core e ag-ui com prazo de morte (onda 2); better-auth client acompanha o server |

### 6.3 Dev-only

`drizzle-kit` ^0.31.10 (migrações), `@vitejs/plugin-react`, `vite` ^7,
`happy-dom` + `@happy-dom/global-registrator`, `@testing-library/react` +
`user-event`, `@types/*`, `eventsource` (dev do server). `@biomejs/biome`:
**não trazer** — a casa tem lint/format próprios; formatação do fork passa
pelo padrão do repo host. `@copilotkit/aimock`: só enquanto os testes herdados
precisarem; morre com o runtime.

---

## 7. Riscos e decisões que ficam com o dono

| # | Ponto | Posição desta revisão |
| --- | --- | --- |
| 1 | **Duas UIs** (desktop Tauri do produto × app do openbot) | Proposta do §5: o app forkado é a BASE (auth/admin/computer/gallery), as superfícies do produto portam para dentro dele na onda 7 e o Tauri segue como host desktop. A alternativa (manter o desktop e forkar só o server) reduz a onda 7 mas abandona "OPENBOT UI" do desenho — decisão do dono |
| 2 | **better-auth numa estação single-user** | Custo aceitável (o desenho prevê multiusuário no Puter: 1 conta por pessoa); manter dev-actor como caminho local |
| 3 | **cel-js fora mesmo com "integração total"** | Manter R5. Integração total ≠ dois motores de política; o incidente I4 é a régua. Se o dono discordar, registrar ANTES da onda 3 |
| 4 | **pgvector/knowledge** | Continua pendência declarada (I7): knowledge forkado entra sem busca vetorial; saídas futuras: sqlite-vec (homologar) ou Postgres num deploy servidor |
| 5 | **React 19 + Tailwind 4 × padrão Multiplike (React 18 + styled-components)** | Herdar do chassis e registrar a exceção; reescrever o estilo do fork seria maior que o fork |
| 6 | **Screencast do agent-computer** | Pendência declarada desde o porte; entra na onda 7 com as atribuições Apache-2.0/BSD-3 (RS7) |
| 7 | **Ordem de commit da onda 0** | O working tree tem a migração Bun não committada; fechar ANTES do fork físico — fork por cima de migração pela metade é bisect impossível |
