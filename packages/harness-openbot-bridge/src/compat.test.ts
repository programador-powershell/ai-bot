/**
 * COMPATIBILIDADE COM O ORÁCULO: as transcrições WS reais do gateway Go
 * (test-fixtures/ws/*.jsonl) reproduzidas contra o servidor TS.
 *
 * A comparação é por VALOR, nunca por byte — o README das fixtures explica: os
 * ws/*.jsonl passaram por JSON.parse→stringify no cliente gravador, então os
 * escapes `>` do Go viraram `>` literal; e id/ts dos frames gerados pelo
 * servidor (ready) são de cada execução. O que TEM de bater:
 *
 *  - a SEQUÊNCIA de frames (kinds, seqs, sessões) na mesma ordem do fio;
 *  - o ready com session/seq/specialists/models/activeSpecialist/activeModel/
 *    environment/environments e a lista de sessões (campos essenciais);
 *  - cada envelope de replay INTEIRO por valor (id, ts, turn, from, payload) —
 *    esses vieram do log durável e o log nós importamos byte a byte.
 *
 * O catálogo (specialists/models/environments) entra por CONFIG copiado do
 * próprio ready da fixture: catálogo é dado das etapas E5/E7 — o que se prova
 * aqui é que o TRANSPORTE o carrega intacto e na hora certa.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { Envelope, Model } from '@aibot2/domain-events'

import { ClienteWsDeTeste } from './teste-cliente-ws.js'
import type { EstadoDeAmbientes } from './stream.js'
import {
  lerTranscricao,
  montarTransporte,
  semearSessaoDeFixture,
  type LinhaDeTranscricao,
  type TransporteDeTeste,
} from './teste-apoio.js'

const TOKEN_DAS_FIXTURES = 'token-de-mentira-das-fixtures'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

interface ReadyDaFixtura {
  specialists: string[]
  models: Model[]
  environment?: EstadoDeAmbientes['environment']
  environments?: EstadoDeAmbientes['environments']
}

/** Sobe o transporte com o catálogo do ready da fixture e as duas sessões semeadas. */
async function montarComOraculo(transcricao: LinhaDeTranscricao[]): Promise<TransporteDeTeste> {
  const ready = transcricao.find((linha) => linha._dir === '<-' && linha.kind === 'ready')
  expect(ready).toBeDefined()
  const catalogo = ready!.payload as ReadyDaFixtura

  const transporte = await montarTransporte({
    transporte: {
      token: TOKEN_DAS_FIXTURES,
      specialists: catalogo.specialists,
      models: catalogo.models,
      environments: () => ({
        ...(catalogo.environment !== undefined ? { environment: catalogo.environment } : {}),
        ...(catalogo.environments !== undefined ? { environments: catalogo.environments } : {}),
      }),
    },
  })
  cleanups.push(() => transporte.dispose())

  // A ordem de semeadura reproduz a recência do oráculo: a lista do ready vem
  // por updatedAt decrescente, e o nosso updatedAt é o relógio do import — a
  // pausa garante que a segunda sessão fique mais recente mesmo em disco
  // rápido (empate de milissegundo inverteria a lista).
  await semearSessaoDeFixture(transporte.store, 'chat-simples')
  await new Promise((resolve) => setTimeout(resolve, 15))
  await semearSessaoDeFixture(transporte.store, 'ferramenta-aprovada')
  return transporte
}

/** Campos essenciais de um resumo de sessão — updatedAt é do relógio de cada lado. */
function resumoEssencial(lista: unknown): Array<Record<string, unknown>> {
  return (lista as Array<Record<string, unknown>>).map((resumo) => ({
    id: resumo['id'],
    title: resumo['title'],
    specialist: resumo['specialist'],
    model: resumo['model'],
    turns: resumo['turns'],
  }))
}

function compararFrame(esperado: LinhaDeTranscricao, recebido: Envelope): void {
  // A espinha do envelope bate sempre: verbo, número e sessão.
  expect(recebido.kind).toBe(esperado.kind)
  expect(recebido.seq).toBe(esperado.seq)
  expect(recebido.session).toBe(esperado.session)
  expect(recebido.v).toBe(esperado['v'])

  if (esperado.kind === 'ready') {
    // O ready é GERADO por cada servidor: id vazio e ts próprio (como no Go);
    // o payload é comparado campo essencial a campo essencial.
    expect(recebido.id).toBe('')
    const payloadEsperado = esperado.payload as Record<string, unknown>
    const payloadRecebido = recebido.payload as Record<string, unknown>
    for (const campo of [
      'session',
      'seq',
      'specialists',
      'models',
      'activeSpecialist',
      'activeModel',
      'environment',
      'environments',
    ]) {
      expect(payloadRecebido[campo], `ready.${campo}`).toEqual(payloadEsperado[campo])
    }
    expect(resumoEssencial(payloadRecebido['sessions'])).toEqual(
      resumoEssencial(payloadEsperado['sessions']),
    )
    // updatedAt existe e é timestamp — o VALOR é do relógio de cada lado.
    for (const resumo of payloadRecebido['sessions'] as Array<Record<string, unknown>>) {
      expect(typeof resumo['updatedAt']).toBe('string')
      expect(Number.isNaN(Date.parse(resumo['updatedAt'] as string))).toBe(false)
    }
    return
  }

  // Envelope de replay: veio do log durável importado da fixture — o valor
  // INTEIRO tem de bater, campo a campo (id, ts, turn, from, payload).
  const { _dir, ...limpo } = esperado
  expect(recebido).toEqual(limpo)
}

describe('compat: transcrição ws/handshake.jsonl (hello → ready → replay → re-hello)', () => {
  it('o servidor TS reproduz a MESMA sequência de frames que o gateway Go gravou', async () => {
    const transcricao = lerTranscricao('ws/handshake.jsonl')
    const transporte = await montarComOraculo(transcricao)

    const cliente = await ClienteWsDeTeste.conectar(transporte.porta)
    cleanups.push(() => cliente.destruir())

    for (const linha of transcricao) {
      if (linha._dir === '->') {
        const { _dir, ...frame } = linha
        cliente.enviarTexto(frame)
        continue
      }
      const recebido = (await cliente.proximoJson()) as Envelope
      compararFrame(linha, recebido)
    }

    // Fim da transcrição = fim do que o oráculo mandou: nada além disso.
    expect((await cliente.proxima(200)).tipo).toBe('prazo')
  }, 20_000)
})

describe('compat: transcrição ws/live-only.jsonl (o hello sem histórico)', () => {
  it('liveOnly devolve SÓ o ready (seq do fim do log) e mais nada', async () => {
    const transcricao = lerTranscricao('ws/live-only.jsonl')
    const transporte = await montarComOraculo(transcricao)

    const cliente = await ClienteWsDeTeste.conectar(transporte.porta)
    cleanups.push(() => cliente.destruir())

    for (const linha of transcricao) {
      if (linha._dir === '->') {
        const { _dir, ...frame } = linha
        cliente.enviarTexto(frame)
        continue
      }
      const recebido = (await cliente.proximoJson()) as Envelope
      compararFrame(linha, recebido)
      // A fixture prova o seq do fim do log (4) — a asserção fica explícita
      // porque é o contrato da ponte de ferramentas.
      expect((recebido.payload as { seq: number }).seq).toBe(4)
    }

    // "e mais nada": os 4 envelopes de histórico NÃO trafegam.
    expect((await cliente.proxima(250)).tipo).toBe('prazo')
  }, 20_000)
})
