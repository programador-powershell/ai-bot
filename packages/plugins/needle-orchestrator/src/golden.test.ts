/**
 * ACEITE E5 (golden): o corpus de calibração roda contra o roteador TS →
 * MESMAS rotas e MESMAS confianças, tolerância ZERO no léxico.
 *
 * O arquivo golden/lexicon-golden.json foi gerado pelo PRÓPRIO oráculo Go
 * (internal/supervisor, Score/IntentOf/Route com a cascata encurtada para o
 * léxico) sobre 77 casos: os splits do needle-router-pro (train/test/hard) e
 * as sondas fixadas nos testes e comentários do Go. NUNCA edite o JSON à mão
 * — regenere pelo oráculo; uma vírgula "arrumada" faz esta suíte provar
 * conformidade com um roteador que nunca existiu.
 *
 * A comparação de confiança é `toBe` (igualdade de float64 exata): o Go e o
 * V8 fazem as MESMAS operações IEEE-754 na MESMA ordem, então qualquer
 * diferença de bit é um desvio real de porte, não "ruído de float".
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@aibot2/harness-kernel'
import { SpecialistRegistry } from '@aibot2/specialist-registry'
import { intentOf } from './intent.js'
import { RouterService } from './router.js'
import { score } from './score.js'
import { normalize } from './text.js'

interface GoldenCase {
  text: string
  attachments: string[]
  normalized: string
  intent: string
  scores: { id: string; confidence: number; signals: string[]; deliverable: boolean }[]
  route: {
    specialist: string
    reason: string
    confidence: number
    surface: string
    signals: string[]
    standby: { specialist: string; when: string; why: string }[]
  }
}

const cases: GoldenCase[] = JSON.parse(
  readFileSync(new URL('../golden/lexicon-golden.json', import.meta.url), 'utf8'),
)

function mount(): { registry: SpecialistRegistry; router: RouterService } {
  const ctx = new Context()
  ctx.plugin(SpecialistRegistry, {})
  ctx.plugin(RouterService, {})
  return { registry: ctx.specialists, router: ctx.router }
}

describe('golden do oráculo (77 casos, tolerância zero)', () => {
  const { registry, router } = mount()

  it('o corpus existe e tem o tamanho gravado', () => {
    expect(cases.length).toBe(77)
  })

  for (const golden of cases) {
    const label = golden.attachments.length > 0
      ? `${golden.text} [${golden.attachments.join(', ')}]`
      : golden.text

    it(`normaliza, pontua e roteia igual ao Go: ${label}`, async () => {
      // Normalize byte a byte.
      expect(normalize(golden.text)).toBe(golden.normalized)
      // Intenção léxica.
      expect(intentOf(golden.normalized)).toBe(golden.intent)
      // Ranking do fast router: mesmos ids, mesmas confianças (float64
      // idêntico), mesmos sinais e a mesma marca de entregável.
      const ranking = score(golden.text, registry.all())
      expect(ranking.map((s) => s.id)).toEqual(golden.scores.map((s) => s.id))
      for (const [index, scored] of ranking.entries()) {
        const want = golden.scores[index] as GoldenCase['scores'][number]
        expect(scored.confidence, `confiança de ${scored.id}`).toBe(want.confidence)
        expect(scored.signals, `sinais de ${scored.id}`).toEqual(want.signals)
        expect(scored.deliverable, `entregável de ${scored.id}`).toBe(want.deliverable)
      }
      // A rota inteira — decisão, motivo, confiança, superfície, sinais e o
      // ELENCO (standby com as mesmas frases).
      const route = await router.route({ text: golden.text, attachments: golden.attachments })
      expect(route.specialist).toBe(golden.route.specialist)
      expect(route.reason).toBe(golden.route.reason)
      expect(route.confidence).toBe(golden.route.confidence)
      expect(route.surface).toBe(golden.route.surface)
      expect(route.signals).toEqual(golden.route.signals)
      expect(route.standby).toEqual(golden.route.standby)
    })
  }
})
