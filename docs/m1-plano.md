# M1 — Plano concreto: kernel + adapter + árvore de plugins + testes de compatibilidade

> O M1 não entrega produto — entrega a **fundação verificável**: um kernel de
> plugins clean-room, o domínio como pacotes puros, os primeiros plugins reais
> e, acima de tudo, a bateria de compatibilidade que prova que o TS se comporta
> como o Go se comportava. A régua do M1 é uma só: **nenhuma etapa fecha sem o
> teste que a define passando** — porque a alternativa ("porto agora, testo no
> fim") é exatamente como se perde as invariantes que os comentários do Go
> passaram meses acumulando.

Baseado no m0-inventario.md (mesma pasta). Auditado em 2026-08-20.

---

## 1. Estrutura de pastas proposta

Camadas de fora para dentro: **apps** (processos), **packages/domain** (tipos e
regras puras, sem I/O), **packages/plugins** (comportamento montável no
kernel), **packages/providers** (implementações concretas de seams). A regra de
dependência é a do harness, que é a que queremos copiar: consumidor depende do
**seam** (definição), nunca do provider concreto.

```
ai-bot-2/
├── docs/
│   ├── m0-inventario.md
│   └── m1-plano.md
├── app/                              # UI (React/Vite; port do apps/desktop atual — Tauri continua o host)
├── server/                           # orquestrador Node 24 (Hono): monta o kernel, expõe HTTP/WS
├── agent-computer/                   # KEEP do openbot (Playwright, ARIA, screencast, Take the Wheel)
│                                     #   cirurgia: sessões/perfis por runtimeId, não por botId
├── shared/                           # contratos entre processos: protocol (envelopes), SURFACES/RAILS,
│                                     #   Avatar (8 campos, conjuntos fechados), tipos de TaskDispatch
├── worker-daemon/                    # daemon do PC físico: registra-se, recebe TaskDispatch,
│                                     #   REPORTA eventos (nunca grava seq — sequenciador é do server)
└── packages/
    ├── harness-kernel/               # clean-room: Context, plugin (3 formas), Service, ctx.effect,
    │                                 #   eventos tipados (emit/parallel/serial/bail/waterfall), disposers
    ├── harness-openbot-bridge/       # adapter: monta plugins do kernel como rotas/middleware Hono
    │                                 #   e traduz o padrão govern() do openbot para o pipeline de eventos
    ├── domain/
    │   ├── goals/                    # Goal (o pedido do usuário como entidade, dono das conversas-filhas)
    │   ├── tasks/                    # Task/TaskRun: TaskRunID lógico (com tentativa) — NUNCA o nome da máquina
    │   ├── workers/                  # Worker = PC físico; lease com época e prazo (substitui .lock por PID)
    │   ├── workspace/                # Plan congelado, materialização, Promote (cerca worker+época)
    │   ├── runtime/                  # Runtime da TAREFA (host|docker|wsl|vps) — não da sessão
    │   └── events/                   # event log: kinds, seq por sessão, durabilidade por kind, replay
    └── plugins/
        ├── needle-orchestrator/      # a cascata de roteamento (constantes calibradas) + degrau Needle
        ├── context-runtime/          # history()/fitToContext/medidor — a dobra da conversa em prompt
        ├── cluster-scheduler/        # ondas, tetos 3/4/24 em store durável, recusa/escalação, retry
        ├── puter-workspace/          # workspace por Bot/Goal (não por sessão) sobre o provider puter
        ├── runtime-snapshots/        # estado de execução observável (o que alimenta presença/avatar)
        ├── action-gateway/           # o funil único: Gate portado + audit-before-act + Tool Output Gateway
        ├── specialist-registry/      # overlay como dado, troca a quente, OnChange para o roteador
        └── browser-runtime/          # seam do computador do bot; consome agent-computer via HTTP
    └── providers/
        ├── puter/                    # storage/workspace concreto do puter-workspace
        └── needle/                   # cliente HTTP do Needle Pro (loopback; Ready() degrada a cascata)
```

Por que `harness-openbot-bridge` existe como pacote e não como código no
server: o server deve ser **montagem**, não lógica — a lista de plugins e a
configuração. Tudo que traduz "mundo Hono/HTTP" para "mundo kernel" mora no
bridge, para que os plugins nunca importem Hono e continuem testáveis sem
processo de pé (a lição do harness: consumer depende do seam).

---

## 2. Decisão: kernel via npm × clean-room → **clean-room**

Adotada a recomendação do mapa do harness, pelos quatro motivos dele, na ordem
de peso para a casa:

1. **Homologação por dependência.** O caminho npm mínimo puxa
   `@deepseek-ai/cordis` + `cosmokit` + `@standard-schema/spec`, e a composição
   declarativa puxaria `cordis-plugin-loader` com peer **nativo**
   (`node-addon-require-builtin`, binário por plataforma) + `js-yaml`. São 4–6
   submissões TI/SI para ganhar ~2.7k linhas de código.
2. **Developer preview de um fork.** O `@deepseek-ai/cordis` 4.0.1 não é o
   cordis upstream: é fork do 4.0.0-rc.7 com 18 modificações locais (hardening
   de fiber, reconciliação do loader). Depender dele é acompanhar o roadmap
   DELES, com breaking changes anunciadas no README; e o rc.8 nem é `latest`.
3. **Só precisamos do subconjunto.** Não precisamos de HMR, isolate/intercept,
   nem do loader YAML completo. O que precisamos cabe pequeno: Context como
   repositório de serviços tipados, plugin em 3 formas com `inject`, Service
   auto-registrável, `ctx.effect` com disposers em ordem reversa, eventos
   tipados com 5 modos de dispatch, e composição declarativa simples (lista de
   entries em TS, não YAML com `!!js`).
4. **Auditabilidade.** O próprio harness vendoriza o framework porque quer a
   camada "auditable, patchable, pinned". Clean-room é a versão honesta disso
   para nós: o código é nosso, a suíte é nossa, o commit 141eb6f fica pinado
   como referência de leitura — **forma, nunca linha** (payloads proprietários
   do Claude Code no repo deles reforçam: não copiar).

Cláusula de saída: se um dia o time preferir a dependência direta, a submissão
é exatamente `@deepseek-ai/cordis` + `@deepseek-ai/cosmokit` +
`@standard-schema/spec`, versão exata sem range. A interface do nosso kernel
deve permanecer próxima o bastante da forma do Cordis para que essa troca seja
mecânica — é um teste de design, não uma promessa.

### O que o harness-kernel implementa (escopo fechado)

- `Context`: repositório de serviços com chaves tipadas via declaration
  merging (`declare module '@ai-bot-2/harness-kernel' { interface Context {...} }`).
- Plugin nas 3 formas (função `(ctx, config)`, classe, objeto `{apply}`), com
  `name`/`inject`/`provide`; `ctx.plugin()` devolve handle await-ável.
- `Service`: `super(ctx, name)` registra `ctx.<name>`, unload desregistra.
- `ctx.effect(execute, label?)`: corpo roda já, disposers (função, promise ou
  generator que yield-a vários) desfeitos em ordem reversa no dispose;
  `ctx.on()` devolve disposer e morre com o plugin.
- Eventos tipados com os 5 modos: `emit` (fire-and-forget), `parallel`,
  `serial`, `bail` (primeiro retorno não-undefined vence), `waterfall`
  (around-middleware: não chamar `next()` veta) — o waterfall é o que viabiliza
  os ganchos `agent/pre-step`, `llm/stream` e `tools/pre-execute` que o resto
  do plano assume.
- Composição: `compose(entries: PluginEntry[])` em TS puro. Sem YAML, sem HMR,
  sem loader — se precisarmos de perfil por arquivo, é evolução do M2+.

Fora do escopo (deliberado): isolate/intercept, HMR, patches transacionais de
config, scheduler de reload. Cada um desses é complexidade do harness que só
paga em ecossistema de terceiros — que não é o nosso caso no M1.

---

## 3. Decisão: Bun × Node → **Node 24 + corepack pnpm**

Fatores, pelo mapa do openbot:

- **Bun não é homologado** e a política é aprovação por dependência — um
  runtime inteiro novo é a maior submissão possível, para ganho nulo: nenhuma
  lógica de negócio do openbot depende de API Bun.
- O acoplamento é **casca fina e enumerável** (9 pontos): `serve` em 6
  entrypoints, WS do Bun (upgrade+handlers) no server, `SQL`/bun-sql no db,
  `Bun.spawn` no supervisor, bun:test nos testes. O mapa estima dias, não
  semanas — e a metade db/teste nem se aplica a nós (trocamos o banco e a
  suíte de qualquer forma).
- A casa já opera Node+corepack pnpm (regra registrada: `corepack pnpm`,
  nunca puro; o repo host já é pnpm workspace).
- Node 24 traz de graça o que o Bun dava: `node --env-file`, `node:sqlite`,
  `import.meta.dirname`, fetch/WebSocket client nativos.

Consequências práticas assumidas: `@hono/node-server` + `@hono/node-ws` (ou
`ws`) entram na lista TI/SI; o ponto mais delicado do porte é o
`server/src/index.ts` do openbot que multiplexa fetch+upgrade — reescrito, não
adaptado; testes nascem em vitest.

---

## 4. Demais decisões estruturais fixadas (referência rápida)

Detalhadas no m0-inventario.md; o plano abaixo as assume:

- **D1** Storage: `node:sqlite` atrás de `StorageDriver` (Postgres não
  homologado); um escritor por store; workers reportam, não gravam.
- **D2** Identidade de execução: `{taskRunId, workerId, leaseEpoch, runtimeId}`
  desde o dia 1; TaskRunID lógico ≠ WorkerID físico.
- **D3** Motor de política único: permissions.Gate portado dentro do
  action-gateway, com o envelope govern() do openbot (audit-before-act, ref
  server-side). CEL não entra.
- **D4** Needle Pro via HTTP loopback (provider `needle`); indisponível =
  cascata degrada para o degrau LLM, nunca erro ao usuário.
- **D5** Executor de tools server-side (headless); o app é espectador com os
  mesmos cartões (Approval/Ask/Delegation/Notice) via eco durável.
- **D6** Tetos e budgets (3/4/24) residem em store durável por Goal, não em
  contexto de processo.
- **D7** Container é execução (efêmero por tarefa); resultado só existe se
  promovido (Promote com cerca worker+época).

---

## 5. Ordem de implementação e critérios de aceite

Cada etapa lista **entregável**, **aceite** (o teste que a define) e as
dependências. As etapas E1–E3 são estritamente sequenciais; a partir da E4 há
paralelismo possível (anotado). Os testes de compatibilidade usam o gateway Go
vivo como **oráculo**: fixtures gravadas dele (logs JSONL, transcrições WS,
saídas de tool) são reproduzidas contra o TS — o Go só é apagado quando a
suíte inteira passa sem ele.

### E1 — harness-kernel (clean-room)

- **Entrega:** `packages/harness-kernel` completo no escopo do §2, zero
  dependências externas de runtime.
- **Aceite:**
  - Suíte unitária cobrindo: os 5 modos de dispatch (incl. waterfall que veta
    ao não chamar `next()` e bail no primeiro não-undefined); disposers em
    ordem reversa; generator de disposers; `ctx.on` morrendo com o plugin;
    Service registrando/desregistrando `ctx.<name>`; unload de plugin desfaz
    TUDO que ele registrou (o teste-espelho do "efeito reversível" do harness);
    plugin nas 3 formas; `inject` faltante falha na montagem, não no uso.
  - Um plugin-exemplo no molde do `tool-todo` do harness (name/inject/apply
    registrando em um serviço fake) compila e roda — é o gabarito de DX que os
    plugins reais vão copiar.
  - `package.json` sem nenhuma dependência (só devDependencies do repo host).

### E2 — domain/events + StorageDriver sqlite

- **Entrega:** `packages/domain/events` (kinds, envelope, seq por sessão,
  durabilidade por kind) e o driver `node:sqlite` atrás de `StorageDriver`;
  mutex assíncrono por sessão; truncate durável; SessionMeta com
  BotID/ParentID/LastGoal.
- **Aceite (o mais importante do M1):**
  - **Teste de corrida:** 200 appends concorrentes (Promise.all com awaits no
    meio) numa sessão → seq 1..200 sem furo nem repetição. Este teste existe
    porque o event loop não protege nada entre awaits (RS5) — sem ele, o port
    reintroduz a corrida que o comentário do `Append` Go descreve.
  - **Compat de replay:** fixture de log real do gateway Go importada → `Since(n)`
    devolve exatamente os mesmos envelopes na mesma ordem.
  - **Truncate:** após corte, replay/Since/SyncedSeq clampado funcionam sem
    caso especial; corte além do fim é no-op; numeração 1..N permanece
    verdadeira; no Windows, o arquivo não fica com descritor aberto no rename
    (teste de integração real, não mock).
  - Durabilidade por kind: delta/thinking/progress/state não fsyncam; kinds
    duráveis sim (verificado por instrumentação do driver).

### E3 — server (Hono) + transporte WS + harness-openbot-bridge

- **Entrega:** `server/` montando o kernel via bridge; hello/ready/replay/
  re-hello; sessionSummaries no ready; close 1013 para cliente atrasado.
- **Aceite:**
  - As 3 invariantes de ordem do stream.go como testes: (1) evento nascido
    durante o replay não some (assinatura antes do lastSeq); (2) re-hello para
    o leitor até o ack e o frame seguinte já é da sessão nova; (3) liveOnly
    começa no lastSeq do ready.
  - **Compat de protocolo:** o desktop atual (app/ inalterado) conecta no
    server TS e renderiza uma sessão gravada no Go — mesma tela. Este é o
    teste que autoriza chamar o pacote de "compatível".
  - Contrapressão: cliente que para de ler leva 1013 e, ao reconectar, o
    replay reconstrói tudo (teste com socket artificialmente lento).

### E4 — action-gateway (pode andar em paralelo com E5)

- **Entrega:** Gate portado (ordem de avaliação fixa, digest com escopo,
  timeout 10min recusa, concessão por especialista), envelope govern()
  (audit-before-act, decisão humana durável ANTES do efeito), Tool Output
  Gateway + Artifact Store, whitelist UI de 9 ferramentas.
- **Aceite:**
  - Bateria do `permissions_test` Go traduzida caso a caso, incluindo os
    negativos: modo desconhecido = ask; digest de outro repo não vale; timeout
    recusa; concessão de sessão não atravessa especialista.
  - **Compat byte-a-byte da projeção:** fixtures de saídas grandes do Go →
    projeção 1500 head + 3000 tail idêntica (incl. inversão tailHeavy);
    integral content-addressed com o mesmo sha256[:8]; `context.fetch` com
    offset negativo lê do fim.
  - Regra de ouro testada: pedido da UI recebe o INTEGRAL do artifact;
    recusa de whitelist não deixa envelope; desfecho lido do log.
  - Reinício no meio de uma aprovação pendente: o pedido REAPARECE (aprovação
    durável — a dívida 8 do cluster fecha aqui, não fica para depois).

### E5 — specialist-registry + needle-orchestrator (paralelo com E4)

- **Entrega:** overlay como dado (validação tudo-ou-nada, conjuntos fechados,
  DefaultID, master reservado), OnChange reconstruindo caches; cascata
  completa com as constantes calibradas; provider `needle` HTTP com `Ready()`.
- **Aceite:**
  - **Golden tests do needle-router-pro:** o corpus de calibração roda contra
    o roteador TS → mesmas rotas e mesmas confianças (tolerância zero no
    léxico; no degrau Needle, tolerância definida pelo harness de calibração).
  - Sticky: 2ª mensagem não pontua nada (asserção de que nenhum scorer é
    chamado); `/mode` corta no primeiro whitespace; id inválido devolve texto
    intacto; modo barrado recusa com sinal sem esvaziar o prompt.
  - Needle indisponível (processo derrubado no teste) → cascata degrada para
    LLM sem erro ao usuário.
  - Overlay inválido: NENHUMA mudança aplicada e todos os erros reportados
    juntos.

### E6 — agent loop + context-runtime

- **Entrega:** o loop como plugin que implementa a fábrica de agentes do
  kernel (molde AgentFactory do harness: create/resume, inbox
  followup/steer/inject, anchors de sessão); pipeline de tools
  pre-execute→execute→post-execute→result sobre waterfall; history() e
  fitToContext portados; medidor de contexto com CHARS_PER_TOKEN=4 nos dois
  lados.
- **Aceite:**
  - ToolResult dobra como UMA mensagem user (teste que tenta parti-la via
    orçamento apertado e falha); Delegate dobra 2x por Done; system nunca cai;
    minKeptMessages=2/floorTokens=256; truncamento no meio com marca.
  - Cancelamento no meio do stream grava o prefixo visto (anchor
    interrupted) — replay mostra o que o usuário viu, não menos.
  - Tool exclusiva forma barreira; paralelas respeitam o teto; call não
    despachada após abort ganha resultado sintético.
  - Reasoning:true efêmero (não vai ao log) e o chip abre/fecha no app.

### E7 — cluster-scheduler + puter-workspace + worker-daemon + domain/{tasks,workers,workspace,runtime}

- **Entrega:** crew portado (ondas, recusa-como-falha, escalação, retry
  debitando só unfinished), tetos em store durável por Goal, plano congelado
  1x viajando no envelope com WorkspacePlanID/LeaseEpoch, fleet com lease de
  época persistida (TTL 3min) e as 3 saídas do Acquire, Promote com cerca,
  worker-daemon reportando (nunca gravando seq), Runtime por TAREFA.
- **Aceite:**
  - **Teste de preempção:** worker com época velha tenta promover →
    equivalente de ErrStaleWorkspace, resultado NÃO vira verdade.
  - Tetos: profundidade barrada ANTES do plano; 24 total atravessa sub-equipes
    (sub-equipe herda o MESMO budget — asserção de ponteiro lógico via store,
    não via contexto de processo); reinício do server no meio de uma onda não
    zera o débito.
  - Recusa: os casos positivos e negativos do refusal() Go traduzidos
    (preâmbulo descascado em laço; verbo técnico NÃO é recusa; >280 chars
    nunca é recusa); `ESCALAR:` conta no portão e não em failures.
  - fs/git e proc.run resolvem no MESMO lugar quando o Runtime da tarefa não é
    local (fecha a dívida 6: editar numa máquina e compilar noutra).
  - Container efêmero: fim da tarefa destrói o container; artefato só existe
    se promovido.
- **Nota de escopo:** o worker-daemon do M1 roda na MESMA máquina (loopback).
  Multi-PC é M2 — mas o protocolo já nasce com workerId/leaseEpoch para que o
  M2 seja deploy, não redesign.

### E8 — browser-runtime + agent-computer (cirurgia) + runtime-snapshots

- **Entrega:** agent-computer portado a Node (os pontos Bun do mapa), sessões
  e perfis por runtimeId; seam browser-runtime no kernel; supervisor dockerode
  com vocabulário por execução; runtime-snapshots alimentando a presença
  (estados active|owner|working|waiting|done vindos do estado da TAREFA — a
  evolução declarada no doc do cluster).
- **Aceite:**
  - Snapshot ARIA: teto 200 elementos, refs e{N} válidas só contra o snapshot
    mais recente (ref velha recusada com erro nomeado).
  - Take the Wheel: com humano no controle, ação do bot é RECUSADA (não
    enfileirada); segredo humano audita rótulo+contagem, nunca o valor.
  - Screencast proxied atrás do session guard; stream cai e reconecta sem
    matar a sessão do browser.
  - Supervisor: nome derivado, nunca aceito; só toca containers com o próprio
    label; taskRun encerrado = container destruído (asserção via docker
    inspect no teste de integração).

### E9 — app (bridge final) + paridade

- **Entrega:** app/ apontando para o server TS como backend único; superfícies,
  rails, avatares, medidor, cartões e busca funcionando; gateway Go desligado
  do caminho.
- **Aceite:**
  - Roteiro de paridade das 10 superfícies (o mapa literal do Stage.tsx) com
    replay de sessões reais gravadas no Go — mesma tela, mesmos cartões
    fechados ao reabrir (eco durável de gate/approval).
  - Conversas aninhadas: filha órfã sobe à raiz; subtítulo é LastGoal; sinal
    de conversa é lastSeq.
  - Avatares: mesma semente → mesmo retrato em 20px e 96px (snapshot test do
    SVG); valor de catálogo desconhecido → retrato vazio, nunca exceção.
  - Só então: remoção do `services/gateway` Go vira tarefa própria (com o
    commit de remoção referenciando a suíte que o substituiu).

### Trilho transversal (vale para todas as etapas)

- **Fixtures do oráculo:** um diretório `test-fixtures/` versionado com logs
  JSONL, transcrições WS e saídas de tool gravadas do gateway Go em `73f858d`.
  Gravar TODAS no início do M1, enquanto o Go está intacto — gravar depois de
  mexer é gravar o bug junto.
- **Windows primeiro:** CI local roda no Windows (a máquina da casa); os
  testes de rename/descritor/fsync são de integração real, nunca mockados.
- **Sem dependência nova sem linha no m0-inventario.md §3** — a lista TI/SI é
  viva e é a fonte; dependência que aparece no package.json sem estar lá é
  defeito de processo, não detalhe.
