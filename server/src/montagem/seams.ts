/**
 * Os SEAMS PROVISÓRIOS da montagem completa (Onda 3) — cada um é uma dívida
 * DECLARADA, com a onda que a paga escrita ao lado. A regra: seam provisório
 * FALHA ALTO e diz o que falta; nunca finge que funcionou (degraded-mode
 * fingido é o defeito que o corte do Intelligence existiu para não repetir).
 *
 * Por que num arquivo próprio: montagem.ts é LISTA de plugins + config, e um
 * stub com mensagem é uma decisão de produto ("o que acontece quando pedem o
 * que ainda não existe"), não wiring. Aqui ela tem nome, dono e prazo.
 */

import { allowsTool, type SpecialistRegistry } from "@aibot2/specialist-registry";
import type { SpecialistDirectory, ToolExecutor } from "@aibot2/plugin-action-gateway";
import type { ChatModel } from "@aibot2/plugin-context-runtime";
import type { TaskExecutor } from "@aibot2/cluster-scheduler";

/**
 * O Toolbox ainda não foi portado (fs/git/proc do oráculo Go). Uma chamada de
 * ferramenta NATIVA que chegue ao funil sem executor real recusa com o motivo
 * — o portão decidiu, o log registrou, e o efeito honestamente não existe.
 * O chassis (index.ts) injeta o executor REAL para o que já existe
 * (mcp.call e componentes); o restante cai aqui.
 */
export function executorSemToolbox(): ToolExecutor {
  return {
    async call(_sessionId: string, tool: string): Promise<string> {
      throw new Error(
        `a ferramenta ${tool} ainda não tem executor nesta montagem — ` +
          "o Toolbox nativo (fs/git/proc) é dívida declarada; o funil decidiu e registrou, o efeito não roda",
      );
    },
  };
}

/**
 * O provedor de modelo do agent loop (M2) ainda não existe nesta estação.
 * Um turno que chegue ao loop falha declarando isso — nunca uma resposta
 * inventada, nunca um spinner sem ninguém do outro lado.
 */
export function modeloAusente(): ChatModel {
  return {
    async complete(): Promise<string> {
      throw new Error(
        "nenhum provedor de modelo está configurado nesta montagem — " +
          "o agent loop está de pé, mas o degrau do modelo (roteador M2) é dívida declarada",
      );
    },
  };
}

/**
 * O TaskExecutor REAL (cliente HTTP dos 9 verbos §36 do worker-daemon) FOI
 * entregue na Onda 5 — é o DaemonTaskExecutor do cluster-scheduler, montado pela
 * montagem quando `opcoes.daemon` chega (endpointFor/commandFor de uma estação
 * com daemon). Este seam é o que sobra para a estação SEM daemon configurado:
 * despachar uma tarefa ao cluster falha com o motivo — o scheduler, os tetos e
 * a cerca já valem; o elo com o daemon só liga quando há daemon para ligar.
 */
export function executorDaOnda5(): TaskExecutor {
  return {
    async run(): Promise<string> {
      throw new Error(
        "nenhum worker-daemon está configurado nesta estação (sem AIBOT daemon) — " +
          "o DaemonTaskExecutor da Onda 5 existe, mas sem endpoint para despachar " +
          "a tarefa foi recusada em vez de fingir execução",
      );
    },
  };
}

/**
 * O diretório de especialistas que o Gate consulta, servido pelo REGISTRY
 * (o catálogo real, com overlay a quente) — e com uma extensão deliberada:
 *
 * Um id que NÃO está no registry é um Bot do CHASSIS (agente criado na UI
 * forkada, id sorteado). O catálogo dele não é o do especialista padrão — é o
 * conjunto de ferramentas que o chassis intermedeia pelo funil (`botTools`),
 * porque o que ele PODE de verdade (qual servidor MCP, qual componente) é
 * decidido POR CHAMADA pelos grants do chassis.db dentro do executor. Cair no
 * default do registry aqui recusaria `mcp.call` de todo Bot do chassis (o
 * especialista padrão não a tem) e o funil nunca chegaria ao grant.
 */
export function diretorioDoRegistry(
  registry: SpecialistRegistry,
  botTools: readonly string[] = [],
): SpecialistDirectory {
  return {
    getOrDefault(id: string) {
      const definition = registry.get(id);
      if (definition !== undefined) {
        return {
          id: definition.id,
          name: definition.name,
          allowsTool: (tool: string) => allowsTool(definition, tool),
        };
      }
      return {
        id,
        name: id || "bot",
        allowsTool: (tool: string) => botTools.includes(tool),
      };
    },
  };
}
