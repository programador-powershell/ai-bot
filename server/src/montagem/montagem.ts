/**
 * A MONTAGEM do servidor: sobe o kernel e lista os plugins com a configuração.
 *
 * Nada de lógica aqui, de propósito (m1-plano §1): o que traduz HTTP/WS para o
 * mundo do kernel mora no @aibot2/harness-openbot-bridge, e o domínio mora no
 * @aibot2/domain-events. Se este arquivo crescer além de "lista de plugins +
 * config", a lógica nova está na camada errada.
 *
 * [Onda 3] A montagem é COMPLETA: os 7 plugins que estavam prontos e soltos
 * (specialist-registry, action-gateway, needle-orchestrator, context-runtime,
 * cluster-scheduler, browser-runtime, runtime-snapshots) entram na lista ao
 * lado dos 3 de sempre (event-log, session-bus, transporte). O que ainda não
 * tem implementação real entra por SEAM PROVISÓRIO que falha alto e nomeia a
 * dívida (seams.ts) — nunca por ausência muda. "Montagem que cresce é o sinal
 * de que o desenho estava certo."
 *
 * A separação montarNucleo/montarServidor existe porque há DOIS transportes de
 * produção: o chassis (index.ts, Bun.serve) serve o stream ele mesmo e só
 * precisa do NÚCLEO; este módulo completa com o transporte Node (o processo
 * sidecar do oráculo). Os dois montam o MESMO núcleo — uma lista só.
 */

import { join } from 'node:path'

import { Context } from '@aibot2/harness-kernel'
import type { Model } from '@aibot2/domain-events'
import { Fleet, JsonFileFleetState } from '@aibot2/domain-workers'
import { WorkspaceManager } from '@aibot2/domain-workspace'
import {
  Transporte,
  eventLogPlugin,
  sessionBusPlugin,
  transportePlugin,
  type LogDoTransporte,
  type ProvedorDeAmbientes,
} from '@aibot2/harness-openbot-bridge'
import {
  ActionGatewayService,
  FsArtifactStore,
  type ToolExecutor,
} from '@aibot2/plugin-action-gateway'
import { SpecialistRegistry } from '@aibot2/specialist-registry'
import { RouterService } from '@aibot2/needle-orchestrator'
import * as contextRuntime from '@aibot2/plugin-context-runtime'
import { FsCheckpointStore, type ChatModel } from '@aibot2/plugin-context-runtime'
import {
  ClusterScheduler,
  DaemonTaskExecutor,
  type DaemonTaskExecutorOptions,
  type TaskExecutor,
} from '@aibot2/cluster-scheduler'
import { BrowserRuntimeService } from '@aibot2/plugin-browser-runtime'
import { RuntimeSnapshots } from '@aibot2/runtime-snapshots'

import type { ConfigDoServidor } from './config.js'
import {
  diretorioDoRegistry,
  executorDaOnda5,
  executorSemToolbox,
  modeloAusente,
} from './seams.js'

export interface OpcoesDeMontagem {
  /**
   * O executor de ferramentas entregue ao funil (E4). O chassis injeta o
   * executor REAL (mcp.call + componentes pelos grants); ausente, o seam
   * declarado recusa com o motivo.
   */
  tools?: ToolExecutor
  /** A política DECLARADA do Gate (dado cru). Ilegível envenena — nunca default mudo. */
  policy?: unknown
  /** O provedor de modelo do agent loop (M2). Ausente = seam declarado. */
  model?: ChatModel
  /**
   * O cliente real dos 9 verbos §36 (Onda 5), já montado. Precede `daemon`;
   * ausente ambos = seam declarado.
   */
  taskExecutor?: TaskExecutor
  /**
   * A configuração para MONTAR o DaemonTaskExecutor da Onda 5 aqui — o handoff
   * scheduler→worker-daemon ligado no server. Uma estação com daemon passa
   * `endpointFor`/`commandFor`; sem isso, o seam declarado segue valendo (o
   * despacho recusa em vez de fingir execução). O executor NÃO decide máquina —
   * o scheduler decide e o endpointFor só resolve o endpoint do escolhido.
   */
  daemon?: DaemonTaskExecutorOptions
  /** O agent-computer, quando esta estação tem um. Ausente, browser-runtime fica fora — declarado no log. */
  browser?: { baseUrl: string; token: string }
  /**
   * As ferramentas que o funil intermedeia para Bots do CHASSIS (ids fora do
   * registry) — ver diretorioDoRegistry. O grant fino é por chamada, no executor.
   */
  chassisBotTools?: readonly string[]
  /** O catálogo de MODELOS anunciado no ready (o de especialistas vem do registry). */
  models?: readonly Model[] | (() => readonly Model[])
  environments?: ProvedorDeAmbientes
  log?: LogDoTransporte
}

export interface NucleoMontado {
  ctx: Context
  /** Desmonta TUDO em ordem reversa — o unload do kernel. */
  dispose(): Promise<void>
}

/**
 * O log padrão da montagem. Sem biblioteca de log por decisão (stdlib até o
 * parecer TI/SI); campos sensíveis nunca chegam aqui — o transporte loga
 * TAMANHOS de token, nunca o valor.
 */
function logDaMontagem(opcoes?: OpcoesDeMontagem): LogDoTransporte {
  return (
    opcoes?.log ??
    ((mensagem, campos) => {
      console.warn(`[aibot2] ${mensagem}`, campos ?? '')
    })
  )
}

export interface ServidorMontado extends NucleoMontado {
  transporte: Transporte
}

/**
 * O núcleo: kernel + TODOS os plugins de produto, sem transporte. É o que o
 * chassis (index.ts) monta — o stream dele é servido pelo Bun.serve.
 */
export async function montarNucleo(
  config: Pick<ConfigDoServidor, 'dataDir'>,
  opcoes?: OpcoesDeMontagem,
): Promise<NucleoMontado> {
  const ctx = new Context()
  const log = logDaMontagem(opcoes)
  // Erros de listener do kernel não podem sumir em silêncio (contrato do
  // ctx.effect assíncrono): a raiz é quem registra o ouvinte.
  ctx.on('internal/error', (erro) => {
    log('erro interno do kernel', { erro: erro instanceof Error ? erro.message : String(erro) })
  })

  try {
    await ctx.plugin(eventLogPlugin, { caminho: join(config.dataDir, 'events.db') })
    await ctx.plugin(sessionBusPlugin, {})

    // O catálogo REAL (E5) — é dele que o ready do stream anuncia specialists.
    await ctx.plugin(SpecialistRegistry, {})

    // O funil ÚNICO de efeitos (E4). O diretório é o registry; o executor é o
    // do chamador ou o seam declarado; a política declarada é LIDA aqui.
    await ctx.plugin(ActionGatewayService, {
      store: ctx.eventos,
      tools: opcoes?.tools ?? executorSemToolbox(),
      directory: diretorioDoRegistry(ctx.specialists, opcoes?.chassisBotTools ?? []),
      artifacts: new FsArtifactStore(join(config.dataDir, 'artifacts')),
      ...(opcoes?.policy !== undefined ? { policy: opcoes.policy } : {}),
    })

    // A cascata de roteamento (Needle) — lê o registry via inject declarado.
    await ctx.plugin(RouterService, {})

    // Context runtime + agent loop (E6): checkpoints em disco no dataDir; o
    // modelo é seam até o roteador de modelos (M2) existir.
    await ctx.plugin(contextRuntime, {
      store: ctx.eventos,
      checkpoints: new FsCheckpointStore(join(config.dataDir, 'context')),
      model: opcoes?.model ?? modeloAusente(),
    })

    // O control plane (E7): frota durável em arquivo no dataDir, workspaces
    // locais (backend v1) e o executor da Onda 5. O executor real (cliente HTTP
    // dos 9 verbos §36) entra quando esta estação tem daemon configurado; sem
    // isso, o seam declarado recusa o despacho em vez de fingir execução.
    await ctx.plugin(ClusterScheduler, {
      store: ctx.eventos,
      fleet: new Fleet({ state: new JsonFileFleetState(join(config.dataDir, 'fleet')) }),
      workspaces: new WorkspaceManager(),
      executor:
        opcoes?.taskExecutor ??
        (opcoes?.daemon !== undefined
          ? new DaemonTaskExecutor(opcoes.daemon)
          : executorDaOnda5()),
    })

    // O navegador task-scoped (§32) — só quando esta estação TEM agent-computer
    // configurado; a ausência é dita no log, nunca um baseUrl inventado.
    if (opcoes?.browser !== undefined) {
      await ctx.plugin(BrowserRuntimeService, {
        baseUrl: opcoes.browser.baseUrl,
        token: opcoes.browser.token,
      })
    } else {
      log('browser-runtime fora da montagem: agent-computer não configurado (AGENT_COMPUTER_URL)')
    }

    // Inventário de snapshots de runtime (M10/M11) — cache descartável, nasce vazio.
    await ctx.plugin(RuntimeSnapshots, {})
  } catch (erro) {
    // Montagem é atômica para quem observa: se um plugin do meio falha, os já
    // montados são desfeitos — sem isto, o event-log ficaria aberto (e o
    // arquivo preso no Windows) por uma subida que nunca aconteceu.
    await ctx.scope.dispose()
    throw erro
  }

  return {
    ctx,
    dispose: async () => {
      await ctx.scope.dispose()
    },
  }
}

export async function montarServidor(
  config: ConfigDoServidor,
  opcoes?: OpcoesDeMontagem,
): Promise<ServidorMontado> {
  const nucleo = await montarNucleo(config, opcoes)
  const { ctx } = nucleo
  try {
    await ctx.plugin(transportePlugin, {
      token: config.token,
      host: config.host,
      port: config.port,
      allowOrigins: config.allowOrigins,
      // O ready anuncia o catálogo REAL, lido do registry A CADA hello — um
      // overlay publicado troca o catálogo sem derrubar o processo, e a
      // próxima conexão já vê o novo (a observação do conferente da Onda 2:
      // antes saía vazio).
      specialists: () => ctx.specialists.ids(),
      models: opcoes?.models ?? [],
      ...(opcoes?.environments !== undefined ? { environments: opcoes.environments } : {}),
      log: logDaMontagem(opcoes),
    })
  } catch (erro) {
    await ctx.scope.dispose()
    throw erro
  }

  return {
    ctx,
    transporte: ctx.transporte,
    dispose: nucleo.dispose,
  }
}
