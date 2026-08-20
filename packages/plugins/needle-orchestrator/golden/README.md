# golden/ — o léxico do oráculo Go, congelado

> **NUNCA edite `lexicon-golden.json` à mão.** Cada número aqui é a saída
> literal do roteador Go vivo — inclusive os dígitos "feios" de float64
> (`0.6000000000000001`). Uma vírgula "arrumada" faz a suíte provar
> conformidade com um roteador que nunca existiu. O `golden.test.ts` compara
> com `toBe` (igualdade exata de float64) de propósito: Go e V8 fazem as
> mesmas operações IEEE-754 na mesma ordem, então diferença de bit é desvio
> real de porte, não ruído.

## De onde veio

- **Oráculo:** `ai-bot/services/gateway/internal/supervisor` (Score, IntentOf,
  Normalize e `Router.Route` com a cascata encurtada para o léxico —
  `NewRouter(nil, nil)`), árvore limpa no branch
  `claude/ai-bot-unified-tauri-go-faa8a1` (base `73f858d`).
- **Corpus (77 casos):** os 54 prompts dos splits do
  `ai-bot/needle-router-pro/data/splits/` (train/test/hard_test, com os
  anexos do `context`) + 23 sondas fixadas nos testes e comentários do Go
  (bug de compilação, XSS, entregável único, pergunta com assunto de código,
  anexos decisivos/empatados/desconhecidos etc.).
- **Gravado em:** 2026-08-20, Windows (a plataforma do CI local), Go 1.26.5.

## Como regravar (reprodutível)

1. Recriar em `internal/supervisor/` um teste transitório `zz_golden_dump_test.go`
   que, para cada item do corpus, serializa `Normalize`, `IntentOf`,
   `Score(text, specialist.All())` e `NewRouter(nil, nil).Route(...)` com
   `encoding/json` (floats saem na precisão de round-trip do Go).
2. Rodar apontando a saída para cá:

   ```
   cd ai-bot/services/gateway
   GOLDEN_OUT=<este-dir>/lexicon-golden.json \
   GOLDEN_SPLITS=../../needle-router-pro/data/splits \
   go test ./internal/supervisor -run TestZZGoldenDump -count=1
   ```

3. **Apagar o teste transitório** e conferir `git status` limpo no oráculo —
   o gerador não é código do gateway, é instrumento de gravação.
4. Registrar nesta página o commit do oráculo usado na regravação.
