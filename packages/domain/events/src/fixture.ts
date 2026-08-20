/**
 * Importador de fixture: lê um log.jsonl gravado pelo gateway Go e devolve os
 * envelopes tipados.
 *
 * É a ponte da suíte de compatibilidade (test-fixtures/): o log do oráculo
 * entra por aqui, é reproduzido no StorageDriver TS e o replay tem de devolver
 * os MESMOS envelopes na MESMA ordem. Comparação por VALOR, nunca por byte —
 * o encoding/json do Go grava `<`, `>` e `&` como sequências unicode (u003c,
 * u003e, u0026 — estão assim nos log.jsonl), e o JSON.parse resolve isso do
 * jeito certo: mesmo valor, grafia diferente.
 *
 * Tolerância a linha partida: só a ÚLTIMA linha de um log append-only pode
 * estar quebrada (queda de energia no meio da escrita), e ela é descartada —
 * o Go faz o mesmo ao ler. Linha ilegível no MEIO não existe num log
 * legítimo; aqui isso é erro alto, porque uma fixture encolhida em silêncio
 * "prova" compatibilidade com um histórico que ninguém gravou.
 */

import { validateEnvelope, type Envelope } from './protocol.js'

/** Importação recusada: a fixture não é um log legítimo do oráculo. */
export class FixtureImportError extends Error {
  override name = 'FixtureImportError'
}

/**
 * Converte o conteúdo de um log.jsonl em envelopes tipados, na ordem gravada.
 * Aceita CRLF (um checkout Windows sem .gitattributes não pode quebrar a
 * suíte) e ignora linhas em branco no fim.
 */
export function importLogJsonl(text: string): Envelope[] {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop()
  }

  const envelopes: Envelope[] = []
  for (const [index, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (index === lines.length - 1) {
        // Última linha partida: escrita interrompida, nunca foi legível.
        break
      }
      throw new FixtureImportError(
        `linha ${index + 1} ilegível no meio do log — fixture corrompida, regrave-a do oráculo`,
      )
    }
    try {
      envelopes.push(validateEnvelope(parsed))
    } catch (error) {
      throw new FixtureImportError(
        `linha ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return envelopes
}
