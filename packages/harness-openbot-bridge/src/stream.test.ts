/**
 * Aceite do protocolo de stream (E3, m1-plano §5): as TRÊS invariantes de
 * ordem do stream.go como testes nomeados, mais a autenticação no primeiro
 * frame. Tudo contra o servidor MONTADO pelos plugins, em socket real.
 *
 *  (a) evento nascido durante o replay não some — a assinatura vem antes do lastSeq
 *  (b) re-hello para o leitor até o ack — o frame seguinte já é da sessão nova
 *  (c) liveOnly começa no lastSeq do ready — nada anterior trafega, nada da janela se perde
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_EVENT_BATCH,
  SqliteEventStore,
  type Envelope,
  type EnvelopeInput,
} from '@aibot2/domain-events'

import { ClienteWsDeTeste } from './teste-cliente-ws.js'
import {
  StoreComGancho,
  TOKEN_DE_TESTE,
  montarTransporte,
  semearSessaoDeFixture,
  type TransporteDeTeste,
} from './teste-apoio.js'

/* ------------------------------ infra de teste ---------------------------- */

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

async function montar(
  ...args: Parameters<typeof montarTransporte>
): Promise<TransporteDeTeste> {
  const transporte = await montarTransporte(...args)
  cleanups.push(() => transporte.dispose())
  return transporte
}

async function conectar(porta: number): Promise<ClienteWsDeTeste> {
  const cliente = await ClienteWsDeTeste.conectar(porta)
  cleanups.push(() => cliente.destruir())
  return cliente
}

function hello(campos: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: 'h1',
    ts: new Date().toISOString(),
    seq: 0,
    session: '',
    kind: 'hello',
    from: { kind: 'user' },
    payload: { client: 'teste', version: '0.0.1', token: TOKEN_DE_TESTE, ...campos },
  }
}

function comoEnvelope(valor: unknown): Envelope {
  return valor as Envelope
}

// [Onda 2] O StoreComGancho mudou para teste-fixtures.ts: os MESMOS testes
// nomeados agora rodam também contra o transporte do chassis (suíte Bun) e os
// ganchos das invariantes têm de ser UMA definição.

function eventoNovo(id: string, texto: string): EnvelopeInput {
  return {
    id,
    kind: 'message',
    from: { kind: 'specialist', id: 'chat', specialist: 'chat' },
    payload: { role: 'assistant', text: texto },
  }
}

/* ------------------------- as 3 invariantes de ordem ----------------------- */

describe('invariantes de ordem do stream (os testes que definem o E3)', () => {
  it('(a) evento nascido durante o replay não some — a assinatura vem antes do lastSeq', async () => {
    const store = new StoreComGancho(SqliteEventStore.open(':memory:'))
    const transporte = await montar({ store })
    const meta = await semearSessaoDeFixture(store, 'chat-simples')

    // O gancho segura o RETORNO do lote do replay e faz nascer o seq 5 nessa
    // janela: quem assinou antes do lastSeq o recebe ao vivo; quem assinasse
    // depois do replay o perderia para sempre.
    let disparado = false
    store.ganchoDepoisDoSince = async (_fromSeq, limit) => {
      // O publish do barramento também chama since (limit 1) — o gancho só
      // interessa na chamada do REPLAY, que pede o lote inteiro.
      if (disparado || limit !== MAX_EVENT_BATCH) return
      disparado = true
      await transporte.bus.publish(meta.id, eventoNovo('e-nascido-no-replay', 'nasci no meio'))
    }

    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ sessionHint: meta.id, resumeFrom: 0 }))

    const ready = comoEnvelope(await cliente.proximoJson())
    expect(ready.kind).toBe('ready')

    const vistos: number[] = []
    while (vistos.length < 5) {
      const envelope = comoEnvelope(await cliente.proximoJson())
      vistos.push(envelope.seq)
    }
    // 1..4 do replay e o 5 nascido no meio — sem furo e SEM duplicata.
    expect(vistos).toEqual([1, 2, 3, 4, 5])
    expect(disparado).toBe(true)
  })

  it('(b) re-hello para o leitor até o ack — o frame seguinte já é da sessão nova', async () => {
    const transporte = await montar()
    const sessao1 = await semearSessaoDeFixture(transporte.store, 'chat-simples')
    const sessao2 = await semearSessaoDeFixture(transporte.store, 'ferramenta-aprovada')

    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ sessionHint: sessao1.id, resumeFrom: 0 }))
    // ready + 4 envelopes do replay da sessão 1.
    for (let i = 0; i < 5; i++) {
      await cliente.proximoJson()
    }

    // O re-hello e o prompt saem COLADOS, sem esperar o servidor: se o leitor
    // não parar até o ack, o prompt é processado contra a sessão VELHA — que
    // foi exatamente o defeito que o oráculo consertou.
    cliente.enviarTexto(hello({ sessionHint: sessao2.id, resumeFrom: 0 }))
    cliente.enviarTexto({
      v: 1,
      id: 'p1',
      ts: new Date().toISOString(),
      seq: 0,
      session: '',
      kind: 'prompt',
      from: { kind: 'user' },
      payload: { text: 'para a sessão nova' },
    })

    // O frame seguinte ao re-hello no fio é o ready da sessão NOVA…
    const ready2 = comoEnvelope(await cliente.proximoJson())
    expect(ready2.kind).toBe('ready')
    expect(ready2.session).toBe(sessao2.id)
    // …seguido do replay INTEIRO dela (9 envelopes), todos da sessão nova.
    for (let seq = 1; seq <= 9; seq++) {
      const envelope = comoEnvelope(await cliente.proximoJson())
      expect(envelope.session).toBe(sessao2.id)
      expect(envelope.seq).toBe(seq)
    }

    // E o prompt que veio colado foi entregue à sessão NOVA, uma única vez.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(transporte.inbound).toHaveLength(1)
    expect(transporte.inbound[0]!.sessionId).toBe(sessao2.id)
    expect(transporte.inbound[0]!.envelope.kind).toBe('prompt')

    // A assinatura antiga morreu na troca: evento novo na sessão 1 NÃO chega;
    // o próximo frame do fio é o da sessão 2.
    await transporte.bus.publish(sessao1.id, eventoNovo('e-s1', 'ninguém deve ver'))
    await transporte.bus.publish(sessao2.id, eventoNovo('e-s2', 'este sim'))
    const aoVivo = comoEnvelope(await cliente.proximoJson())
    expect(aoVivo.session).toBe(sessao2.id)
    expect(aoVivo.seq).toBe(10)
  })

  it('(c) liveOnly começa no lastSeq do ready — nada anterior trafega, nada da janela se perde', async () => {
    const transporte = await montar()
    const meta = await semearSessaoDeFixture(transporte.store, 'chat-simples')

    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ sessionHint: meta.id, liveOnly: true }))

    const ready = comoEnvelope(await cliente.proximoJson())
    expect(ready.kind).toBe('ready')
    expect((ready.payload as { seq: number }).seq).toBe(4)

    // Nada de histórico: o silêncio depois do ready É o contrato.
    expect((await cliente.proxima(200)).tipo).toBe('prazo')

    // Mas o cursor está VIVO no lastSeq: o próximo evento chega.
    await transporte.bus.publish(meta.id, eventoNovo('e5', 'só o novo'))
    const aoVivo = comoEnvelope(await cliente.proximoJson())
    expect(aoVivo.seq).toBe(5)
  })

  it('(c) a janela entre assinar e ler o lastSeq não vaza nem duplica em liveOnly', async () => {
    const store = new StoreComGancho(SqliteEventStore.open(':memory:'))
    const transporte = await montar({ store })
    const meta = await semearSessaoDeFixture(store, 'chat-simples')

    // O seq 5 nasce DEPOIS da assinatura e ANTES da leitura do lastSeq: o
    // ready então reporta 5, e o envelope enfileirado ao vivo é descartado
    // pelo cursor — entregue seria duplicata do que o ready já contou.
    let disparado = false
    store.ganchoAntesDoLastSeq = async () => {
      if (disparado) return
      disparado = true
      await transporte.bus.publish(meta.id, eventoNovo('e5', 'nasci na janela'))
    }

    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ sessionHint: meta.id, liveOnly: true }))

    const ready = comoEnvelope(await cliente.proximoJson())
    expect((ready.payload as { seq: number }).seq).toBe(5)

    // O 5 não trafega (já contado no ready); o 6 sim.
    await transporte.bus.publish(meta.id, eventoNovo('e6', 'depois do ready'))
    const aoVivo = comoEnvelope(await cliente.proximoJson())
    expect(aoVivo.seq).toBe(6)
  })
})

/* ------------------------------- o handshake ------------------------------ */

describe('hello (autenticação no primeiro frame, nunca na URL)', () => {
  it('token errado fecha com 1008 sem dizer qual parte falhou', async () => {
    const transporte = await montar()
    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ token: 'token-errado-do-mesmo-tam' }))
    const fim = await cliente.fim()
    expect(fim.codigo).toBe(1008)
    expect(fim.motivo).toBe('não autorizado')
  })

  it('token de comprimento diferente é recusado SEM exceção (a guarda do timingSafeEqual)', async () => {
    const transporte = await montar()
    const curto = await conectar(transporte.porta)
    curto.enviarTexto(hello({ token: 'x' }))
    expect((await curto.fim()).codigo).toBe(1008)

    const semToken = await conectar(transporte.porta)
    semToken.enviarTexto(hello({ token: undefined }))
    expect((await semToken.fim()).codigo).toBe(1008)
  })

  it('conexão que abre e fica calada é fechada no prazo do hello (1002)', async () => {
    const transporte = await montar({ transporte: { helloTimeoutMs: 100 } })
    const cliente = await conectar(transporte.porta)
    const fim = await cliente.fim(2_000)
    expect(fim.codigo).toBe(1002)
    expect(fim.motivo).toBe('esperava hello')
  })

  it('primeiro frame que não é hello fecha com 1002', async () => {
    const transporte = await montar()
    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto({ kind: 'prompt', payload: { text: 'sem hello' } })
    const fim = await cliente.fim()
    expect(fim.codigo).toBe(1002)
    expect(fim.motivo).toBe('primeiro frame precisa ser hello')
  })

  it('hello com payload de tipo errado é 1002 "hello inválido"', async () => {
    const transporte = await montar()
    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto({ kind: 'hello', payload: { token: 123 } })
    const fim = await cliente.fim()
    expect(fim.motivo).toBe('hello inválido')
  })

  it('re-hello REAPRESENTA o token: troca com token errado fecha 1008', async () => {
    const transporte = await montar()
    const meta = await semearSessaoDeFixture(transporte.store, 'chat-simples')
    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ sessionHint: meta.id }))
    for (let i = 0; i < 5; i++) {
      await cliente.proximoJson()
    }
    cliente.enviarTexto(hello({ token: 'forjado-dentro-da-conexao' }))
    const fim = await cliente.fim()
    expect(fim.codigo).toBe(1008)
  })

  it('origem de navegador fora da lista é 403 no upgrade — antes de qualquer frame', async () => {
    const transporte = await montar({ transporte: { allowOrigins: ['http://localhost:1421'] } })
    await expect(
      ClienteWsDeTeste.conectar(transporte.porta, { origem: 'https://mal.example' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('upgrade fora de /v1/stream é 404', async () => {
    const transporte = await montar()
    await expect(
      ClienteWsDeTeste.conectar(transporte.porta, { caminho: '/v1/outro' }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

/* ------------------------------ sessões no hello --------------------------- */

describe('resolução de sessão', () => {
  it('hello sem sessionHint cria conversa nova: ready.seq 0 e a sessão aparece na lista', async () => {
    const transporte = await montar({ transporte: { specialists: ['chat', 'code'] } })
    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello())
    const ready = comoEnvelope(await cliente.proximoJson())
    const payload = ready.payload as { session: string; seq: number; sessions: Array<{ id: string }> }
    expect(payload.seq).toBe(0)
    expect(payload.session.startsWith('s')).toBe(true)
    expect(payload.sessions.some((resumo) => resumo.id === payload.session)).toBe(true)
  })

  it('o dono (specialist) só vale na criação e só se existir; sessão existente ignora o pedido', async () => {
    const transporte = await montar({ transporte: { specialists: ['chat', 'data'] } })

    // Criação com dono válido → activeSpecialist já vem no ready.
    const clienteA = await conectar(transporte.porta)
    clienteA.enviarTexto(hello({ specialist: 'data' }))
    const prontoA = comoEnvelope(await clienteA.proximoJson())
    expect((prontoA.payload as { activeSpecialist?: string }).activeSpecialist).toBe('data')
    const sessaoDeDados = (prontoA.payload as { session: string }).session

    // Dono inexistente é ignorado — a conversa nasce sem modo.
    const clienteB = await conectar(transporte.porta)
    clienteB.enviarTexto(hello({ specialist: 'nao-existe' }))
    const prontoB = comoEnvelope(await clienteB.proximoJson())
    expect((prontoB.payload as { activeSpecialist?: string }).activeSpecialist).toBeUndefined()

    // Sessão EXISTENTE ignora o dono pedido: o modo gravado é dela.
    const clienteC = await conectar(transporte.porta)
    clienteC.enviarTexto(hello({ sessionHint: sessaoDeDados, specialist: 'chat' }))
    const prontoC = comoEnvelope(await clienteC.proximoJson())
    expect((prontoC.payload as { activeSpecialist?: string }).activeSpecialist).toBe('data')
  })

  it('sessionHint de sessão que não existe cria uma nova em vez de derrubar', async () => {
    const transporte = await montar()
    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ sessionHint: 's-fantasma' }))
    const ready = comoEnvelope(await cliente.proximoJson())
    const payload = ready.payload as { session: string; seq: number }
    expect(payload.session).not.toBe('s-fantasma')
    expect(payload.seq).toBe(0)
  })

  it('resumeFrom no meio replay-a só o resto (cursor exclusivo)', async () => {
    const transporte = await montar()
    const meta = await semearSessaoDeFixture(transporte.store, 'chat-simples')
    const cliente = await conectar(transporte.porta)
    cliente.enviarTexto(hello({ sessionHint: meta.id, resumeFrom: 2 }))
    await cliente.proximoJson() // ready
    expect(comoEnvelope(await cliente.proximoJson()).seq).toBe(3)
    expect(comoEnvelope(await cliente.proximoJson()).seq).toBe(4)
    expect((await cliente.proxima(150)).tipo).toBe('prazo')
  })
})
