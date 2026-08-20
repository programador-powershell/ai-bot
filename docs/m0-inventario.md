# M0 — Inventário consolidado (openbot × deepseek-harness × ai-bot)

> Documento de fechamento do M0 do **ai-bot-2**. Consolida os três mapas de
> inventário produzidos sobre os repositórios de estudo e fixa as decisões de
> fronteira: o que fica, o que é portado, o que é substituído e o que morre.
> Cada linha carrega o porquê — a matriz sem justificativa vira lista de
> desejos, e lista de desejos não sobrevive à primeira semana de M1.

Auditado em 2026-08-20.

---

## 1. Commits pinados

Os três repositórios são **referência de leitura**, não dependência. Pinamos
commit exato porque "a versão que estava lá quando estudamos" é a única
afirmação verificável — branch move, tag às vezes também.

| Repositório | Commit | Tag/estado | Licença | Papel no ai-bot-2 |
| --- | --- | --- | --- | --- |
| `estudo-migracao/openbot` (CopilotKit/openbot) | `06a1a84` | "Take back the two features that only worked on one machine (#21)" | MIT | Base estrutural: gateway de ações, agent-computer (browser), supervisor Docker, contratos de componentes/MCP |
| deepseek-harness | `141eb6f` | `dsh-v0.1.0-rc.8` (developer preview) | MIT (com ressalvas — ver §6) | Referência de **filosofia**: kernel de plugins, seams abstratos, efeitos reversíveis, loop trocável. **Clean-room, zero import** |
| `ai-bot` (ai-orchestrator, este worktree) | `73f858d` | V.2.2 (Onda 5 da paridade) | interno | Fonte do produto: roteamento em cascata, crew, store durável, permissions.Gate, UI Tauri/React inteira |

O que significa "pinado" na prática: qualquer afirmação deste documento sobre
comportamento desses repos vale **para esses commits**. O harness em especial
avisa breaking changes explicitamente (README.md:9-11) — o rc.8 vive no
dist-tag `next` do npm, nem é o `latest`.

---

## 2. Matriz KEEP / PORT / REPLACE / DELETE

Critério de classificação:

- **KEEP** — código ou desenho do openbot (já TS/MIT) que entra no ai-bot-2
  com adaptação, não reescrita.
- **PORT** — lógica do ai-bot em Go que é reescrita em TS **preservando
  contrato e constantes** (os cabeçalhos comentados dos arquivos Go são a
  especificação; os testes Go viram a bateria de compatibilidade).
- **REPLACE** — a função continua existindo, mas a implementação é trocada por
  decisão de política (homologação TI/SI) ou de arquitetura (cluster).
- **DELETE** — não entra. Nem como stub.

### 2.1 KEEP (do openbot)

| Item | Onde está hoje | Por que fica |
| --- | --- | --- |
| **agent-computer** (Playwright 1.62.1 + perfil persistente + ARIA snapshot `mode:"ai"` teto 200 elementos + screencast CDP + Take the Wheel) | `openbot/agent-computer/src/*` | É TS puro, MIT, e resolve um problema que o ai-bot não tem resolvido (browser do bot). O Take the Wheel — humano no controle **recusa** ação do bot, não enfileira — e o segredo humano que audita só rótulo+contagem são decisões que não queremos redescobrir. Cirurgia obrigatória: `sessions: Map<botId,...>` e perfil por bot viram por **runtime/taskRun** (ver incompatibilidade I3) |
| **supervisor Docker** (4 verbos, nomes DERIVADOS, único dono do socket, label de posse) | `openbot/supervisor/src/*` | O desenho "botId validado por regex, nomes nunca aceitos de fora, só age em containers com o próprio label" é a forma certa de isolar o Docker socket. Muda o vocabulário: de `computers/:botId/ensure` (1:1 permanente) para provisionar **execuções efêmeras por tarefa** — o doc do cluster do ai-bot é explícito: "worker é computador, CONTAINER É EXECUÇÃO" |
| **Padrão govern(): audit-before-act + ref resolvido server-side + policy relida a cada decisão** | `openbot/server/src/computer/gateway.ts` | Três invariantes que valem ouro: (1) o ref age contra o snapshot que o **server** buscou, nunca o label que o modelo mandou; (2) a linha de audit nasce **antes** do efeito; (3) regra nova vale na próxima ação sem restart. O motor de política em si é REPLACE (ver 2.3 R5) |
| **Contrato de componentes generativos** (manifest anunciado, grants por bot, decisão por chamada, data functions com grant próprio) | `openbot/app/src/lib/copilot/gallery-registry.ts` + `server/src/components/*` | O ai-bot não tem equivalente e o desenho é bom: o cliente anuncia, o server governa, cada render pede decisão. Entra adaptado ao registry de especialistas |
| **Padrão MCP** (grant primeiro, mesma policy com contexto `mcp.*`, tool não classificada como read = write, audit até de `not_granted`) | `openbot/server/src/plugins/{mcp,store,catalogue}.ts` | "Não classificado positivamente como leitura = escrita" é fail-closed aplicado a catálogo — exatamente a régua da casa |

### 2.2 PORT (do ai-bot Go → TS)

O critério do que porta é simples: tudo que é **produto** (comportamento que o
usuário vê ou invariante que protege o usuário) porta com contrato idêntico;
tudo que é **consequência do Go** (stdlib-only, WebSocket à mão, JSONL porque
SQLite não está na stdlib) não porta — vira REPLACE.

| Item | Fonte Go | Contrato a preservar |
| --- | --- | --- |
| **Roteamento em cascata** | `supervisor/{router,intent,classifier,needle}.go` | Constantes calibradas no harness needle-router-pro (`MinConfidence=0.55`, `MinMargin=0.15`, `saturation=26.0`, `NeedleMinConfidence=0.78`, `NeedleToolBudget=5`, `attachmentWeight=2*saturation`, `deliverableBonus=8.0`, `deliverableWindow=28`) — **não são chute, não rechutar**. Ordem da decisão: /mode → explícito → sticky → anexo → pergunta-não-é-pedido → entregável único → limiar léxico c/ margem → Needle top-5 → LLM → fallback. Modo é DA CONVERSA (1º input grava `SessionMeta.Specialist`; sticky custa zero). `ParseModeCommand` corta no primeiro whitespace e devolve o texto intacto para id inválido |
| **Crew** (recusa-como-falha, escalação-não-é-falha, Promote como única verdade) | `supervisor/crew.go`, `dag.go` | `refusal()` conservador (≤280 chars, markers por prefixo com verbos de recusa — falso positivo reprova trabalho feito, que é pior); `ESCALAR:` sai com `Escalated=true, OK=false`, conta no portão mas não em failures; resultado só vira verdade via `Workspaces.Promote` (cerca worker+época) antes de `done.OK=true`; plano congelado UMA vez no despacho |
| **Tetos MaxDepth/MaxChildren/MaxTotal = 3/4/24** | `permissions.DefaultPolicy` + `crewPolicy`/`crewBudget` | Os valores e os 3 pontos de aplicação (profundidade antes do plano; orçamento depois do plano e antes da execução; retry debita só unfinished). A **residência** muda: sai de `context.Context` de processo e vai para store durável — é a dívida 4 do arquitetura-cluster.md, e o incidente "política declarada e não lida" já aconteceu três vezes na casa |
| **Tool Output Gateway + Artifact Store** | `supervisor/tool_gateway.go`, `store/artifacts.go` | 12KiB inline (20000 para as 7 ferramentas de contrato estruturado); projeção 1500 head + 3000 tail (invertida para tailHeavy: proc.run, diagnostics.run, git.commit, git.diff); integral content-addressed sha256[:8], 64MiB, temp+rename; `context.fetch` por fatia (offset negativo lê do fim). REGRA de ouro: a UI recebe o INTEGRAL, nunca a projeção — projeção no editor é arquivo corrompido e salvável |
| **history() + fitToContext** | `supervisor/supervisor.go`, `context_budget.go` | ToolResult dobra como UMA mensagem user (nunca duas — o orçamento partiria call de result); Delegate dobra 2x chaveado por Done; system nunca cai; corta pelo começo; `minKeptMessages=2`, `floorTokens=256`; mensagem que não cabe entra truncada no meio com marca |
| **Envelope numerado + replay + re-hello** | `transport/stream.go`, `store/store.go` | As 3 invariantes de ordem: assinar o bus ANTES de ler lastSeq; re-hello reapresenta token e o leitor PARA até o ack; liveOnly começa no lastSeq do ready. Cliente atrasado → close 1013 → replay. fsync só em kinds duráveis |
| **permissions.Gate** | `permissions/permissions.go` + `supervisor.go` (digestOf/askApproval) | Ordem fixa: DeniedTools → AgentTools → especialista+catálogo → concessões (digest primeiro, depois session POR ESPECIALISTA) → modo (desconhecido=ask). `digest=sha256(raiz\0especialista\0tool\0args)[:8]` — "aprovar sempre" não vale noutro repo nem noutro especialista. Timeout 10min RECUSA (silêncio ≠ consentimento); decisão humana vira envelope durável ANTES do efeito |
| **UI→ferramenta pelo mesmo funil** | `supervisor/ui_tools.go` | Whitelist fechada de 9 (fs.read/list/search/write/patch, git.status/diff, flow.validate, context.fetch); recusa de whitelist NÃO deixa envelope; desfecho lido do LOG (uiOutcome), não do texto; proc.run/rede/segredo/commit FORA mesmo com aprovação — XSS na webview viraria execução a um clique |
| **Overlay de especialistas** | `specialist/overlay.go` + `router.go` (OnChange) | Catálogo é DADO, troca a quente, tudo-ou-nada; conjuntos fechados de surface/rail/avatar espelham a UI (switch sem default = tela vazia); roteador reconstrói caches via OnChange. O `atomic.Pointer` evapora em JS single-thread — só fica o gancho |
| **Truncate durável + busca** | `store/{truncate,search}.go` | O prefixo VIRA a sessão (mesmos seq): replay, Since, SyncedSeq clampado e índice continuam sem caso especial a jusante. Fechar descritor antes do rename (Windows). Busca só de KindMessage, teto 20/3, snippet ±60 bytes em fronteira de rune |
| **Needle via sidecar** | `needle/sidecar.go` | Processo separado, uma pergunta por vez, `Ready()` degrada a cascata quando morre. É o modelo do port — cgo não tem tradução e nem queremos (ver §5 R4) |
| **UI inteira do desktop** | `apps/desktop/src/*` | Já é TS/React — não é port, é mudança de backend. Contratos que a UI exige do server novo: SessionMeta{BotID≠Specialist, ParentID, LastGoal}, filha órfã sobe à raiz, sinal de conversa é lastSeq (não turns), Avatar de 8 campos com conjuntos fechados e PRNG mulberry32, superfícies decoradas na rota, medidor CHARS_PER_TOKEN=4 (os dois lados erram junto; sem modelo/janela o medidor SOME), Reasoning:true efêmero, ApprovalCard/AskCard/DelegationPopup/NoticePopup com eco durável |

### 2.3 REPLACE

| # | O que sai | O que entra | Por quê |
| --- | --- | --- | --- |
| R1 | **Bun 1.3.14** (runtime do openbot) | **Node 24 + corepack pnpm** | Bun não é homologado pela TI/SI; a casa já roda Node+pnpm. O mapa do openbot provou que o acoplamento é casca fina: 9 pontos enumeráveis, nenhum em lógica de negócio. Custo: `serve` → `@hono/node-server`, WS Bun → `@hono/node-ws`/`ws`, `Bun.spawn` → `node:child_process`, bun:test → vitest |
| R2 | **PostgreSQL 17 + pgvector + Drizzle/bun-sql** | **`node:sqlite` atrás de interface `StorageDriver`** | Postgres não é homologado e o produto é local-first — o ai-bot já provou que roda sem servidor de banco. `node:sqlite` é builtin do Node 24 (zero dependência para TI). A interface existe para que Postgres possa voltar num deploy multiusuário sem reescrever consumidores. Perda real: pgvector (busca vetorial de knowledge) fica sem substituto homologado — pendência registrada, não resolvida em M1 |
| R3 | **CopilotKit Intelligence** (threads/memória no SaaS, obrigatório, "no degraded mode") | **Event log local** (o store do ai-bot, portado sobre StorageDriver) | Maior divergência entre openbot e o produto. Conversa no SaaS contradiz o local-first e cria dependência de licença no boot. O ai-bot já tem o desenho completo (seq por sessão, replay, truncate) — o openbot só contribui o aviso "nada pode ser conhecível só pelo socket; refetch no reconnect", que mantemos |
| R4 | **Loop de tools no navegador** (frontend tools; sem aba aberta o bot não age) | **Executor server-side** (agent loop próprio, molde AgentFactory do harness) | Requisito de TaskRun headless: o cluster despacha tarefa para worker sem UI aberta. O loop do openbot encerra o run no tool call e depende do app para continuar — incompatível por construção (I2) |
| R5 | **Policy CEL (cel-js)** do openbot | **permissions.Gate portado** como motor único | Dois motores de política = duas verdades. O Gate do ai-bot já cobre o produto (ordem fixa, digest com escopo, timeout que recusa) sem dependência externa; o que o openbot contribui é o envelope govern() (audit-before-act, ref server-side) — os dois se fundem: envelope do openbot, motor do ai-bot. Evita homologar cel-js |
| R6 | **botId como chave universal** (container, volume, perfil, sessão, identidade — 12 arquivos no openbot) | **{taskRunId, workerId, leaseEpoch, runtimeId}** | Não existe lease/epoch/preempção no openbot ("ensure é idempotente por nome; posse implícita") e o ai-bot já sofreu o equivalente (workerID sintético misturado com PC físico em crew.go). Separar TaskRunID (lógico, com tentativa) de WorkerID (máquina) desde o dia 1 é construção nova, não refatoração — mais barato agora do que cirurgia depois |
| R7 | **JSONL local como estado de cluster + .lock por PID** | **StorageDriver para estado + lease com prazo/heartbeat; sequenciador no orquestrador** | Dívidas 1–3 do arquitetura-cluster.md, confirmadas em código. O PID .lock tem incidente documentado (lock_windows.go: handle vivo mente sobre processo morto) e `process.kill(pid,0)` em Node REPETE o bug — a autoridade muda, não a implementação |
| R8 | **Containers permanentes por bot** (sbx de vida longa; ai-jail fixo na VPS) | **Container efêmero por tarefa** | "Resultado que só existe no container é resultado que não existe" — o container nasce para a execução e morre com o estrago dentro; o resultado só existe se promovido (Promote) |
| R9 | **Kernel do harness via npm** (`@deepseek-ai/cordis` 4.0.1 + cosmokit + schemastery) | **Clean-room: `packages/harness-kernel` próprio** | Recomendação do mapa do harness, adotada (fundamentação completa no m1-plano.md §2). Resumo: developer preview com breaking changes anunciadas; o `cordis` deles é fork com 18 modificações locais (acompanhar releases = acompanhar o roadmap DELES); ~2.7k linhas no subconjunto que precisamos; cada dep npm nova é homologação por unidade |
| R10 | **Needle por cgo** (`session_cgo.go`, tag `needle`, needle.dll) | **Needle Pro via HTTP local** (provider `providers/needle`) | cgo não tem tradução em Node e FFI (koffi) seria dependência nativa nova para TI/SI. O contrato do sidecar já existe e já degrada a cascata quando indisponível — vira HTTP local com o mesmo `Ready()` |

### 2.4 DELETE

| Item | Por quê |
| --- | --- |
| `openbot/worker/` | Esqueleto de 3 linhas ("idle"); não há fila/lease/scheduler em lugar nenhum do repo. Nosso worker-daemon nasce do desenho do ai-bot, não daqui |
| CopilotKit Runtime v2 + licença + Better Auth | Acoplados ao Intelligence (R3); o ai-bot-2 não tem SaaS no boot. Auth local entra depois, por decisão própria |
| `agent-bot/` e `agent-langgraph/` | Proof-of-concept de endpoint AG-UI sem tools próprios; o loop do ai-bot-2 é o agent loop harness-style (R4) — esses processos não têm papel |
| SPIRE/SPIFFE (`spire/`, `supervisor/identity.ts`, `Bun.spawn` da CLI) | Opcional até no openbot ("sem SPIRE o produto roda"); identidade por workload é problema de um cluster que ainda não existe. Fica anotado como evolução, sem stub |
| `scripts/start.sh` | POSIX (lsof/curl/python3), não roda nativo no Windows — a máquina-alvo da casa. Boot novo em Node/launch.json |
| Payloads Claude Code / `@anthropic-ai/claude-agent-sdk` do harness | Licença proprietária ("SEE LICENSE IN LICENSE.md", explicitamente não permissiva no THIRD_PARTY_NOTICES). O clean-room não pode nem olhar esses diretórios como referência de código |
| `services/gateway` (Go) — **ao final do port** | O Go nunca foi requisito do produto: stdlib-only, WebSocket RFC6455 à mão, JSONL à mão e fold de acentos hardcoded são consequência do contexto Go+homologação. Fica vivo durante a transição como **oráculo dos testes de compatibilidade** (fixtures gravadas dele validam o server TS) e morre quando a paridade fechar |
| jsonb custom do drizzle/bun-sql | Existia por causa da dupla serialização do driver Bun; sem Bun e sem Postgres, o problema evapora. O teste `jsonb-encoding.integration.test.ts` fica citado como aviso, não portado |

---

## 3. Dependências externas para submissão à TI/SI

Política da casa: **aprovação por dependência, versão exata**. Já homologados
(não re-submeter): @xyflow/react, thinking-orbs, xterm.js, ffmpeg.

### 3.1 Runtime (obrigatórias para o M1)

| Dependência | Versão proposta | Para quê | Observação de risco |
| --- | --- | --- | --- |
| `hono` | ^4 (pin exato na submissão) | Framework HTTP do server — o openbot já o usa e as rotas migram quase 1:1 | MIT; sem nativo; superfície pequena |
| `@hono/node-server` | ^1 | Adapter Hono→Node (substitui `Bun.serve`) | MIT; primeira-parte do projeto Hono |
| `@hono/node-ws` (ou `ws` ^8) | ^1 | WebSocket no Node (substitui a API de WS do Bun e o ws.go artesanal) | Decidir UMA: preferência por `@hono/node-ws` (integra o upgrade no roteador); `ws` é alternativa mais madura. A semântica deadline-por-operação do Go vira timers manuais — redesenho documentado, não cópia |
| `playwright` | 1.62.1 (mesma do openbot) | agent-computer: Chromium, ARIA snapshot `mode:"ai"`, engine aria-ref | Apache-2.0; baixa o browser no install (postinstall a declarar na submissão) |
| `dockerode` | ^4 | Supervisor: única superfície de acesso ao Docker socket | Apache-2.0; o processo que o usa é o único com o socket montado (ro) |
| `zod` | ^3 (alinhar à versão já usada no desktop) | Schemas de parâmetros de tools/componentes | MIT; o desktop provavelmente já traz — confirmar antes de submeter em duplicidade |

### 3.2 Dev-only

| Dependência | Versão | Para quê |
| --- | --- | --- |
| `vitest` | ^3 | Testes (substitui bun:test do openbot e complementa `go test` como bateria de compatibilidade). A casa já usa Vitest no frontend — confirmar se a homologação cobre uso em packages de server |
| `typescript`, `vite`, `esbuild` | as do repo host | Já presentes no monorepo do ai-bot (regra: o ai-bot segue a config do host) — sem submissão nova |

### 3.3 Explicitamente EVITADAS (a decisão poupa homologação)

| Evitada | Como |
| --- | --- |
| `@deepseek-ai/cordis` + `cosmokit` + `@standard-schema/spec` (+ `js-yaml`, `node-addon-require-builtin` nativo se composição YAML) | Clean-room do kernel (R9) |
| `cel-js` | Motor de política é o Gate portado (R5) |
| `postgres`/`drizzle-orm` | `node:sqlite` builtin (R2) |
| `koffi`/`node-pty` (nativos) | Needle via HTTP (R10); terminal já mora no host Rust/Tauri (ConPTY) e continua lá |
| `write-file-atomic`/`proper-lockfile` | temp+fsync+rename e lease com heartbeat implementados em `node:fs` — disciplina manual documentada, ~100 linhas, mais barato que duas homologações |

### 3.4 Serviço externo (não é pacote, mas passa pela mesma régua)

- **Needle Pro via HTTP local**: o classificador local deixa de ser cgo/sidecar
  stdio e vira chamada HTTP a um serviço na máquina. Submeter à TI/SI o
  desenho: endpoint local (loopback apenas), sem dados saindo da máquina,
  indisponibilidade degrada a cascata para o degrau LLM (comportamento já
  especificado no `Ready()` do sidecar Go).

---

## 4. Riscos

| # | Risco | Mitigação |
| --- | --- | --- |
| RS1 | **Bun→Node**: o porte é raso mas os detalhes mordem — `serve` multiplexando fetch+upgrade em `server/src/index.ts` do openbot é o ponto mais delicado; testes todos em bun:test | Portar os 9 pontos enumerados no mapa; bateria vitest ANTES de mexer no código portado (o teste fixa o contrato) |
| RS2 | **Harness é developer preview**: breaking changes anunciadas; o `cordis` npm deles é fork (18 modificações, incl. hardening de fiber.ts) — misturar docs do cordis upstream com o fork produz divergência silenciosa | Clean-room elimina o risco de dependência; o risco residual é conceitual (copiar uma semântica que eles vão abandonar) — mitigado pinando 141eb6f como referência de leitura estática |
| RS3 | **PostgreSQL não homologado → node:sqlite**: single-writer por natureza; multi-processo (worker-daemon + server) não pode compartilhar o arquivo à vontade | Interface StorageDriver com regra "um escritor por store"; workers **reportam, não gravam** (o sequenciador mora no orquestrador — já era o desenho do cluster). WAL mode para leitura concorrente local. Pendência declarada: pgvector/knowledge sem equivalente |
| RS4 | **Needle Pro via HTTP**: disponibilidade (processo local pode não estar de pé) e versão do modelo divergir da calibração | O contrato já degrada (cascata pula para LLM); golden tests do needle-router-pro rodam contra o serviço na CI local para detectar deriva de calibração |
| RS5 | **Event loop do Node não protege nada entre awaits**: o seq atômico do Go era `sync.Mutex + O_APPEND`; ler-último-seq/escrever com await no meio reabre a corrida | Mutex assíncrono POR SESSÃO (fila de appends); mesmo padrão para truncate e dobra de cápsula. Teste de corrida (appends concorrentes) é critério de aceite do M1-E2 |
| RS6 | **Windows**: rename sobre descritor aberto falha; não há fsync de diretório; `process.kill(pid,0)` mente sobre processo morto com handle vivo (incidente documentado em lock_windows.go) | Disciplina temp→fsync→close→**rename**; autoridade de posse vira lease com prazo (que já era o destino do cluster) — não reimplementar PID-check |
| RS7 | **Licença**: o harness embute payloads proprietários do Claude Code; o supervisor do openbot herda trechos steel-browser (Apache-2.0) e DevTools (BSD-3) no screencast | Payloads proprietários nunca entram (DELETE); manter os headers de atribuição Apache-2.0/BSD-3 nos arquivos derivados do screencast; NOTICE consolidado no repo |
| RS8 | **Bot Grok/avatares**: conceito visual é do usuário (duas interpretações já rejeitadas) | Portar `grok_professional_avatar_v3.ts` e `BotAvatar.tsx` byte-a-byte; qualquer evolução visual passa pelo dono do conceito |

---

## 5. Incompatibilidades encontradas

Coisas que **não se resolvem com adaptação** — exigiram decisão (todas já
refletidas na matriz):

- **I1 — Intelligence SaaS × local-first.** O openbot não tem modo degradado:
  sem licença e sem o SaaS, o boot aborta. Conversas/threads/memória de lá não
  migram para cá; o event log é reconstruído localmente (R3). O único artefato
  aproveitável é o mapeamento determinístico de thread-identity como ideia.
- **I2 — Frontend tool loop × TaskRun headless.** No openbot o bot PARA no tool
  call e o navegador continua o trabalho. Cluster com worker sem UI é
  impossível nesse desenho. Executor vai para o server (R4) — e o app passa a
  ser espectador com os mesmos cartões de aprovação.
- **I3 — botId universal × posse com época.** openbot: posse implícita,
  idempotência por nome de container, zero preempção. ai-bot: workerID
  sintético e PC físico dividem nome de campo. Nenhum dos dois tem o modelo
  certo — {taskRunId, workerId, leaseEpoch, runtimeId} é construção nova (R6).
- **I4 — Dois motores de política.** CEL (openbot) e Gate (ai-bot) avaliam
  coisas parecidas com semânticas diferentes (o default de fábrica do openbot é
  `allow:["true"]` — permissivo auditado; o Gate nega desconhecido). Convivência
  criaria o pior cenário: regra válida num motor e ignorada no outro — de novo
  "política declarada e não lida". Um motor só (R5), fail-closed do Gate.
- **I5 — bun-sql/jsonb × qualquer outro driver.** A dupla serialização que
  motivou o tipo jsonb custom não existe fora do Bun; portar o tipo seria
  portar a cicatriz sem a ferida.
- **I6 — WebSocket com deadline por operação × libs Node.** `ws`/`@hono/node-ws`
  não têm SetRead/WriteDeadline; `WriteTextBurst` (N frames sob um lock) não
  tem equivalente direto. A semântica visível — "Lagged → close 1013 → cliente
  refaz replay" — é o contrato; a mecânica interna é redesenhada sobre
  bufferedAmount/timers, com teste de contrapressão próprio.
- **I7 — pgvector × node:sqlite.** Busca vetorial de knowledge/conectores não
  tem caminho homologado. Fica FORA do M1, registrado como pendência com duas
  saídas futuras (sqlite-vec a homologar, ou Postgres homologado num deploy
  servidor).
- **I8 — start.sh POSIX × Windows.** Sem tradução: boot novo.
- **I9 — bail/waterfall do harness × nada nosso.** O ai-bot não tem sistema de
  eventos tipados; o openbot também não. O kernel clean-room introduz os 5
  modos (emit/parallel/serial/bail/waterfall) — é adição, não conflito, mas
  significa que NENHUM teste existente cobre essa camada: a suíte do kernel
  nasce do zero (M1-E1).

---

## 6. Nota de licenças (fechamento)

- **openbot** `06a1a84`: MIT no repo. Trechos derivados no screencast
  (steel-browser Apache-2.0, DevTools InputModel BSD-3) exigem manutenção de
  atribuição nos arquivos que mantivermos (KEEP do agent-computer).
- **deepseek-harness** `141eb6f`: MIT no monorepo, MAS o THIRD_PARTY_NOTICES
  declara payloads Claude Code sob licença proprietária e o SDK Anthropic como
  "SEE LICENSE IN README.md". Como a decisão é clean-room sem import, nada
  disso nos alcança — desde que a disciplina de clean-room seja real: **ler a
  forma, não copiar linha**. O aviso AGPL-clean-room da memória do harness
  antigo continua valendo como método.
- **ai-bot** `73f858d`: código interno da casa; o destino de publicação é só o
  remote `pessoal` (programador-powershell), regra já registrada.
