# Estudo do soup — o que dá para aproveitar no ai-bot-2

> Frente B da ordem do dono: "veja o que podemos aproveitar da tecnologia do soup".
> Fonte estudada: `C:/Users/daniel.paim/Documents/Code/ai-orchestrator-main/apps/desktop/src-tauri/target/release/third_party/soup/` (v0.73.0, ~157 mil linhas de Python, ~100 comandos).

## 1. O que o soup É (e o que ele NÃO é)

O soup é um **harness de fine-tuning e pós-treino de LLMs em um comando** — a
autodescrição do próprio CLI: *"Fine-tune and post-train LLMs in one command.
No SSH, no config hell"* (`src/soup_cli/cli.py:88`). Autor: Makazhan Alpamys,
GitHub `github.com/MakazhanAlpamys/Soup`.

O que ele **não** é:

- **Não é um CLI agêntico.** Não há laço agêntico (LLM decide → ferramenta →
  observa → repete) em lugar nenhum. O comando `soup agent` é o "Agent Forge"
  (`commands/agent.py`): gera *dataset de SFT de tool-calling* a partir de uma
  spec de agente — ferramenta para TREINAR agentes, não para SER um.
- **Não é gerenciador de ambientes/sandbox.** O módulo `envs/` são três
  ambientes-brinquedo de rollout para RL (ver §3.3).

O que ele é, por camada: pipeline de dados (12+ formatos), treinadores
(SFT/DPO/GRPO/PPO/KTO/ORPO/distill/pretrain… em `trainer/`), avaliação
(benchmarks, LLM-juiz, Elo, gate declarativo), rastreio de experimentos
(SQLite local), registry de modelos, artefato compartilhável `.can`, deploy
(Ollama/serve), nuvem (Modal) e um servidor MCP.

### Como o ai-orchestrator-main usa

- O soup viaja **vendorizado** como recurso do Tauri em `third_party/soup`
  (fonte completa + `run_soup.py`), citado no `README.md:72` do orchestrator
  como "Apache-2.0, executável".
- A aba **Fine-Tuning** (`apps/desktop/src/modes/TuneView.tsx`) usa uma
  **escada de execução**: binário `soup` no PATH → cópia embutida via Python do
  usuário (`python "<recursos>/third_party/soup/run_soup.py" <args>`, resolvida
  por `apps/desktop/src/lib/vendored.ts`) → treino interno na nuvem. A sonda é
  real: só reporta "embutido pronto" se `--version` executa de verdade.
- Nada é instalado via pip: `run_soup.py` injeta `src/` no `sys.path` e chama
  `soup_cli.cli.run()`. O runtime Python + dependências são responsabilidade do
  ambiente do usuário.

### Como ele é invocado

CLI Typer clássico: `soup init | train | eval | data | autopilot | merge |
quantize | serve | deploy | runs | registry | can | mcp serve | tui …`, com
config declarativa em `soup.yaml` (schema pydantic único em
`config/schema.py`). Alternativas: `python run_soup.py <args>` (o caminho do
orchestrator) e `python -m soup_cli`.

## 2. Licença — o que podemos legalmente portar/embutir

- **`LICENSE`: Apache-2.0** (Copyright 2025 Makazhan Alpamys) +
  **`NOTICE`** ("Soup, Copyright 2026 Makazhan Alpamys"). Os arquivos-fonte
  não carregam cabeçalho de copyright por arquivo (só `utils/bom.py` menciona
  a palavra, em outro contexto).
- **Veredito: liberado.** Diferente do precedente da casa que travou a
  vendorização do sbx (*All rights reserved*), Apache-2.0 permite copiar,
  modificar, portar para TS, embutir e redistribuir — inclusive em produto
  fechado — com grant de patente. O próprio orchestrator já o trata assim
  ("Apache-2.0, executável", em contraste com o drawdb AGPL "só referência").
- **Obrigações se portarmos código** (não valem para portar só o *conceito*):
  1. entrada no `ai-bot-2/THIRD_PARTY_NOTICES.md` com a licença e a atribuição
     do `NOTICE` (mesmo padrão já usado para o openbot/MIT);
  2. marcar como modificados os arquivos alterados;
  3. não usar o nome "Soup" como marca do nosso produto (cláusula 6).

## 3. Módulo a módulo — o que faz e o que fazemos com ele

Legenda das recomendações: **PORTAR CONCEITO** (reescrever a ideia em TS no
ai-bot-2), **SIDECAR** (rodar o Python como serviço residente, padrão do
Needle Pro em `packages/providers/needle/src/http.ts`), **REUSO DIRETO**
(importar o Python onde já somos Python), **IGNORAR**.

### 3.1 `autopilot/` — motor de decisão zero-config (NÃO é laço agêntico)

**O que faz:** três perfis determinísticos — dataset (amostras, formato,
tokens médios/p95, qualidade), modelo (parâmetros, contexto, arquitetura) e
hardware (VRAM) em `analyzer.py` — alimentam uma tabela de decisões puras em
`decisions.py` (`decide_task`, `decide_quantization`, `decide_peft`,
`decide_lr`, `decide_epochs`, `decide_batch_size`…) que gera um `soup.yaml`
completo (`generate_config.py`). `GOAL_TO_TASK` mapeia objetivo → técnica
("reasoning" → GRPO, "alignment" → DPO…).

**O que ele tem que nosso agent loop não tem:** nada agêntico — não compete
com o laço do ai-bot-2. O valor é outro: é o padrão **perfil → decisão pura →
config declarativa**, com cada `decide_*` sendo função pura testável. É
exatamente a filosofia do nosso `needle-orchestrator` (decisão determinística
+ golden tests) aplicada a *provisionamento*.

**Recomendação: PORTAR CONCEITO.** Candidato natural: o
`packages/plugins/cluster-scheduler` (escolha de worker/runtime por perfil da
tarefa) pode evoluir para essa forma — perfis explícitos como dataclasses,
decisões como funções puras, saída como config validada. O código em si é
específico de treino (VRAM, LoRA, quantização): não portar.

### 3.2 `eval/` + `experiment/` — o harness de avaliação

**O que faz:**

- `custom.py`: runner de evals em JSONL com modos de score `exact | contains |
  regex | semantic | tool_call_match | tool_call_name_match |
  tool_call_args_subset` (com limites anti-DoS de regex).
- `judge.py`: LLM-como-juiz com rubrica; `calibrate.py` adiciona calibração de
  juiz com **viés de posição** (julga A/B nas duas ordens) e **abstenção
  conformal** — além de calibração KL para quantização (kernel numpy puro).
- `gate.py`: **treino com portão de avaliação** — `evals/gate.yaml` declara
  suítes com thresholds por tarefa; o gate roda em fronteiras de época (ou
  pós-hoc) e emite veredito passa/falha/regressão.
- `arena.py`: torneio A/B com Elo — kernel de matemática pura (K=32, base
  1500), geração e julgamento são responsabilidade do chamador.
- `leaderboard.py`, `forgetting.py` (detecção de esquecimento catastrófico),
  `checkpoint_intelligence.py` (melhor checkpoint por qualidade, não por loss),
  `human.py`, `quant_check.py`.
- `experiment/tracker.py`: rastreio de runs em **SQLite local**
  (`start_run` → `log_metrics` → `finish_run`), consumido por `runs` e pelo
  leaderboard.

**Nosso needle-router-pro usa harness parecido?** Parecido em espírito, mais
enxuto: `ai-bot/needle-router-pro/evaluation/simulate.py` faz busca cega de
configuração sobre `train`, seleciona por score composto e só então mede
`test`/`hard_test` — e reporta `not_run` honesto quando o baseline real não
está disponível. A disciplina de holdout e honestidade já é a mesma; o que o
soup tem a mais é o **portão declarativo com veredito de regressão** e os
modos de score de tool-calling.

**Recomendação: PORTAR CONCEITO (prioridade alta da frente).**

1. Um `gate.yaml` em TS para o `needle-orchestrator`: hoje a suíte golden
   (`packages/plugins/needle-orchestrator/golden/`) prova *conformidade
   bit-a-bit* com o oráculo Go; um portão declarativo somaria *qualidade*
   (acurácia mínima por split, veredito de regressão contra a última medição)
   como critério de promoção de léxico/perfil.
2. Os modos `tool_call_match`/`tool_call_args_subset` são o score certo para
   avaliar o laço agêntico do ai-bot-2 (o agente chamou a ferramenta certa com
   os args certos?) — é pouca lógica, TS puro.
3. O kernel Elo de `arena.py` é ~100 linhas de matemática pura, trivial de
   portar se quisermos ranquear especialistas/prompts entre si.
4. `experiment/tracker.py`: **IGNORAR** — o ai-bot-2 já tem run durável
   local-first em SQLite; duplicaria a fonte de verdade.

### 3.3 `envs/` — ambientes-brinquedo de rollout (não é sandbox)

**O que faz:** `calculator`, `guess_number`, `retrieval_qa` — geradores
determinísticos e semeados de pares `{prompt, answer}` (64 linhas por env,
`_common.py`) para o caminho de rollout GRPO. O docstring é honesto: são
*seeders* de currículo, não episódios interativos com o modelo no laço.

**Recomendação: IGNORAR.** Específico de RL de pesos. A ideia boa embutida —
corpus determinístico semeado como fixture de teste — a casa já pratica
(léxico golden gravado do oráculo Go).

### 3.4 `cans/` — artefato compartilhável `.can`

**O que faz:** um `.can` é um tar.gz com `manifest.yaml` (versão do formato,
nome, autor), `config.yaml` (SoupConfig completo), `data_ref.yaml` (**hash +
URL/HF id** — referência aos dados, nunca os dados) e `recipe.md`; formato v3
embute **atestados in-toto** (máx. 64 declarações de 1 MiB, validadas em
`schema.py`). Verbos: `pack / unpack / verify / publish / run / fork`.

**Recomendação: PORTAR CONCEITO.** É o desenho pronto para um **"pacote de
especialista"** do ai-bot-2: manifesto + perfil de roteamento + corpus golden
referenciado por hash + atestado de quem gravou — instalável/verificável pelo
`specialist-registry`. Portar o *formato* (schemas em zod/TS), não o código
pydantic. Se um dia formos ler `.can` de verdade (interoperar com o soup), aí
sim reusar o Python via sidecar.

### 3.5 `cloud/` — backend Modal.com

**O que faz:** `soup train --cloud modal` renderiza um app Modal
autocontido a partir do `soup.yaml`. Padrão **plan-only por default**: escreve
o stub e *imprime* o comando `modal run` planejado; submit de verdade só com
`--cloud-submit` + token. Segurança exemplar: config embutida como **dados**
em base64 (nunca eval de string do usuário), `gpu`/`output_dir` validados
contra allowlists fechadas, chaves de API nunca embutidas, `--config` contido
no cwd com rejeição de symlink, costura mockável para testar o submit sem
conta.

**Recomendação: IGNORAR a integração; PORTAR o padrão.** Não treinamos na
Modal. Mas o par **"plan-only por default + submit explícito"** e o embed de
config-como-dados são o padrão certo para o `packages/plugins/action-gateway`
em ações de efeito colateral (imprimir o plano da ação antes do disparo) — e
já conversa com a regra da casa de transparência antes de executar.

### 3.6 `data/` — pipeline de datasets

**O que faz:** detecção/conversão de 12+ formatos por assinatura
(`formats.py`: alpaca, sharegpt, chatml, dpo, kto, tool-calling, embedding,
audio…), validação+estatísticas (`validator.py`), **máscara de loss
assistant-only** (`loss_mask.py`, espelhando LlamaFactory/Axolotl), registry
de chat-templates com **erro duro em vez de fallback silencioso**
(`chat_templates.py` — "silent garbage labels are no longer possible"),
collators, augment, providers.

**Recomendação: REUSO DIRETO onde já somos Python; IGNORAR no core TS.**
O `ai-bot/needle-router-pro` (artefato de pesquisa em Python) pode importar
`soup_cli.data.formats`/`validator` para validar e converter splits — a
Apache-2.0 permite, com a atribuição no THIRD_PARTY_NOTICES. Para o ai-bot-2
em TS, o que se leva é a *política*: formato detectado por assinatura e erro
duro no lugar de fallback calado (a mesma lição da memória "política declarada
e não lida").

### 3.7 `config/` — schema único do `soup.yaml`

**O que faz:** `schema.py` é a fonte única de verdade (pydantic, com bounds
que moram junto do runtime que os usa, para schema e validador nunca
divergirem); `loader.py` carrega, valida e falha com mensagem legível.

**Recomendação: IGNORAR o código; a disciplina já é nossa.** O ai-bot-2 já
valida contratos; o detalhe que vale copiar é *bounds definidos uma vez, no
módulo dono, importados pelo schema* — impede o par schema/validador de mentir
um para o outro.

### 3.8 Bônus fora da lista pedida (dois achados que valem registro)

- **`mcp_server/`** — `soup mcp serve` expõe os comandos read-only (+ dois
  mutantes plan-only) por MCP stdio. O desenho é notável: a *tabela de tools*
  (`registry.py`) é Python puro sem depender do SDK — unit-testável no core
  leve; só `server.py` importa o SDK, tardiamente. Dois usos para nós:
  (a) **é a costura mais limpa se o ai-bot-2 quiser capacidades de
  fine-tuning**: rodar o soup como SIDECAR via MCP, zero porte das 157 mil
  linhas; (b) o padrão "tabela pura + fiação fina" vale como referência para os
  nossos plugins de ferramenta.
- **`commands/agent.py` (Agent Forge)** — spec de agente → dataset SFT de
  tool-calling → train → eval. Se um dia formos treinar um Needle especialista
  em roteamento/tool-calling (o needle-router-pro hoje deliberadamente não
  treina pesos), este é o caminho de menor atrito — de novo, como sidecar.
- **`migrate/`** — conversores de config axolotl/llamafactory/unsloth →
  soup.yaml. Irrelevante para o ai-bot-2; relevante para a frente harness
  estilo Unsloth Studio, se ela voltar.

## 4. Resumo executivo

| Módulo | O que é | Recomendação |
| --- | --- | --- |
| `autopilot` | perfil → decisão pura → config (zero-config de treino) | **Portar conceito** (forma do cluster-scheduler); código não |
| `eval` | gate declarativo, LLM-juiz calibrado, Elo, scores de tool-call | **Portar conceito**: gate.yaml p/ needle-orchestrator + `tool_call_match` p/ o laço agêntico |
| `experiment` | tracker de runs em SQLite | **Ignorar** — run durável já existe; evitaria segunda fonte de verdade |
| `envs` | seeders determinísticos p/ rollout GRPO | **Ignorar** — específico de RL; a ideia (corpus semeado) já praticamos |
| `cans` | artefato `.can` verificável (manifesto+config+hash de dados+atestado) | **Portar conceito** → "pacote de especialista" do specialist-registry |
| `cloud` | Modal serverless, plan-only por default | **Ignorar** integração; **portar padrão** plan-only→submit p/ action-gateway |
| `data` | 12+ formatos, loss mask, erro duro sem fallback | **Reuso direto** no needle-router-pro (Python); política no core TS |
| `config` | schema pydantic único + loader | **Ignorar** código; copiar o truque de bounds no módulo dono |
| `mcp_server` | tools do soup via MCP stdio, registry puro sem SDK | **SIDECAR** se quisermos fine-tuning no ai-bot-2; padrão de referência |
| `trainer`/`monitoring`/`migrate` | treino de pesos e afins | **Ignorar** — fora do escopo do ai-bot-2 |

**Licença:** Apache-2.0 — tudo acima é legalmente possível (portar, embutir,
sidecar), com atribuição no `THIRD_PARTY_NOTICES.md`, marcação de arquivos
modificados e sem usar o nome "Soup" como marca. Nenhum bloqueio tipo
*All rights reserved* aqui.

**Uma frase:** o soup não nos dá um laço agêntico melhor — nos dá a
*engenharia ao redor* de sistemas de ML bem feita (portões de avaliação
declarativos, decisões puras a partir de perfis, artefatos verificáveis,
plan-only antes de efeito colateral), e é exatamente isso que vale trazer
para o ai-bot-2.
