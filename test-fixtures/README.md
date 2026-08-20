# test-fixtures — o comportamento REAL do gateway Go, congelado

> **NUNCA edite estes arquivos à mão.** Eles são a saída literal do gateway Go
> vivo — cada byte aqui é evidência. Uma vírgula "arrumada" num JSON destes faz
> a suíte de compatibilidade provar conformidade com um gateway que nunca
> existiu. Se uma fixture precisar mudar, regrave-a pelo processo abaixo e
> registre o commit novo nesta página.

## De onde vieram

- **Repositório oráculo:** `ai-bot/services/gateway` no commit
  `fd1ec32290b8cccaa760af662fe980a3682abc65`
  (`:bug: 0000 Gateway orfao de build velho derrubado no boot`).
- **Gravadas em:** 2026-08-20, no Windows (a mesma plataforma do CI local).
- **Sem chave de API e sem dado pessoal:** as duas conversas foram geradas por
  um provedor OpenAI-compatível ROTEIRIZADO (clone em Node do
  `cmd/fakeprovider` do gateway, com um roteiro a mais: saber emitir a cerca
  ` ```aibot:tool ` que dispara o pipeline de ferramenta). O texto das
  respostas é fixo e de mentira.
- O token que aparece nos frames de `hello` é `token-de-mentira-das-fixtures` —
  um valor descartável de um gateway temporário que já morreu. Não é segredo,
  e faz parte do frame de propósito: o handshake COM token é o que a fixture
  prova.

## Como foram geradas (reprodutível)

1. Compilar o gateway do commit acima, sem cgo (o degrau Needle fica de fora —
   é o caso normal da máquina de build):

   ```
   cd ai-bot/services/gateway
   CGO_ENABLED=0 go build -o <scratch>/aibotd-oraculo.exe ./cmd/aibotd
   ```

2. Subir o provedor roteirizado (script Node de scratch, porta 8791). Ele fala
   o SSE de verdade: chunks de tamanho irregular, `finish_reason` num chunk e o
   `usage` no chunk SEGUINTE, fechando com `[DONE]` — a mesma forma do
   `cmd/fakeprovider`.

3. Subir o gateway num diretório de dados NOVO (o `.lock` é por diretório;
   reusar um diretório vivo derrubaria o gateway de verdade da estação), com um
   `catalog.json` semeado apontando para o provedor:

   ```
   AIBOT_DATA_DIR=<scratch>/data-oraculo
   AIBOT_TOKEN=token-de-mentira-das-fixtures
   AIBOT_BIND=127.0.0.1:8797
   ```

   ```json
   {
     "providers": [{ "id": "fake", "name": "Provedor roteirizado das fixtures",
       "kind": "local", "baseUrl": "http://127.0.0.1:8791/v1", "enabled": true }],
     "models": [{ "id": "fake-1", "provider": "fake", "label": "Fake",
       "context": 32000,
       "skills": ["chat", "code", "reasoning", "tools", "long-context"],
       "providerId": "fake" }]
   }
   ```

4. Rodar um cliente WebSocket (nativo do Node 24) contra `ws://127.0.0.1:8797/v1/stream`,
   com envelopes na MESMA forma que o desktop monta (`v:1`, `seq:0` — quem
   numera é o servidor, `from:{kind:"user"}`):
   - conversa 1: `hello` → `ready` → `prompt` "Explique em uma frase o que é um
     WebSocket." → esperar `done`;
   - conversa 2: `hello` → `ready` → `prompt` "Guarde na memória que o backup
     roda toda sexta às 18h." → esperar `approval.request` → responder
     `approval.decision {allow:true, scope:"once"}` → esperar `done`;
   - transcrições: uma conexão nova com `sessionHint` da conversa 1 e
     `resumeFrom:0`, depois re-`hello` para a conversa 2 na MESMA conexão; e
     outra conexão com `liveOnly:true`.

5. Esperar >200 ms (o debounce do `meta.json` no store é 200 ms — copiar antes
   congela um cabeçalho atrasado), copiar `sessions/<id>/{log.jsonl,meta.json}`
   do data dir para cá, derrubar gateway e provedor (`taskkill`) e apagar o
   data dir temporário.

## O que cada fixture prova

### `sessions/chat-simples/` — log.jsonl + meta.json

Uma conversa de 1 turno, como o gateway a GRAVA. A sequência durável é
`message(user) → route → message(assistant) → done`, seq 1..4 sem furo — repare
que o prompt entra no log como `kind:"message"` com `role:"user"` (o verbo
`prompt` é o pedido no fio; o log guarda a mensagem), e que os `delta` do
streaming NÃO estão aqui: são efêmeros por decisão, quem abre a conversa amanhã
lê a mensagem inteira. A rota veio do fast router (`reason:"heuristic"`,
confiança 0.55, sinal "pergunta, não pedido") — léxico puro, sem rede.

É a fixture do aceite E2: importada no store TS, `Since(n)` tem de devolver
exatamente estes envelopes, nesta ordem, com estes seq.

### `sessions/ferramenta-aprovada/` — log.jsonl + meta.json

O caminho completo de ferramenta com humano no meio:
`message(user) → route → message → tool.call → approval.request →
approval.decision → tool.result → message → done` (seq 1..9). As invariantes
que este log carrega:

- a rota veio do degrau MODELO (`reason:"model"`, confiança 0.93): o léxico não
  soube, o Needle não estava no build, o master consultou o provedor;
- `tool.call` sai ANTES do portão decidir — o pedido do modelo é registrado
  mesmo que a execução venha a ser recusada;
- `approval.decision` é envelope DURÁVEL gravado ANTES do efeito
  (`from:{kind:"user"}`): lendo o log dá para distinguir "a pessoa autorizou"
  de "a política deixava passar";
- o `digest` do `tool.call` e do `approval.request` são o MESMO valor — é o
  escopo do "aprovar sempre";
- `tool.result` com `ok:true` e o output da ferramenta (`memory.write` de
  verdade, executada pelo Toolbox do gateway contra o memory.json do data dir).

### `ws/handshake.jsonl` — transcrição de uma conexão real

Um frame JSON por linha, com `_dir` anotando a direção (`"->"` cliente→servidor,
`"<-"` servidor→cliente). O roteiro: `hello` (sessionHint da conversa 1,
resumeFrom 0) → `ready` → replay dos 4 envelopes → re-`hello` (conversa 2, na
MESMA conexão, token REAPRESENTADO) → `ready` novo → replay dos 9 envelopes.

O que ela prova para o E3: o `ready` chega antes do replay e carrega
`session/seq/specialists/models/sessions` (a tela se monta sem segunda
chamada); o replay entrega exatamente o log durável, na ordem, até o `seq` do
`ready`; e a troca de sessão é um segundo `hello` completo — o frame seguinte
ao re-hello já é da sessão nova.

### `ws/live-only.jsonl` — o hello sem histórico

`hello` com `liveOnly:true` (o campo real do `protocol.Hello` Go) apontando
para a conversa 1, que TEM 4 envelopes de histórico → volta SÓ o `ready`
(com `seq:4`) e mais nada. É o contrato da ponte de ferramentas do app nativo:
o cursor nasce no `lastSeq` do ready, nada anterior trafega, e nada que nascer
na janela entre assinar e ler o lastSeq se perde (a assinatura vem antes).

## Miudezas que importam na comparação

- `seq` começa em 1 e é por sessão; `turn` agrupa o turno inteiro.
- Timestamps são UTC com precisão de nanossegundo truncada como o Go serializa
  (`2026-08-20T10:16:19.746287Z`) — o TS não precisa gerar igual, mas precisa
  ACEITAR igual.
- O `encoding/json` do Go escapa `<`, `>` e `&` dentro de strings como
  `\u003c`, `\u003e` e `\u0026` (escrita segura para HTML) — está assim no
  `log.jsonl` (o blockquote da resposta vira `\u003e`). Comparação de compat é
  por VALOR decodificado, não por byte da string crua — exceto onde o teste
  diga explicitamente byte-a-byte.
- `meta.json` reflete o fim das conversas: `lastSeq` 4 e 9, `turns:1`,
  `specialist:"chat"`, `model:"fake-1"`, `syncedSeq:0`.
- Os `log.jsonl` de `sessions/` são cópia BYTE A BYTE do que o gateway gravou.
  Já os `ws/*.jsonl` passaram por `JSON.parse` → `JSON.stringify` no cliente
  gravador (é o custo de anotar o `_dir` no frame), então são fiéis por VALOR
  e por ORDEM de chaves, mas não por byte — os escapes `\u003e` do Go, por
  exemplo, viram `>` literal aqui. Compat de transcrição compara valores.
