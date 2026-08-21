/**
 * O RuntimeResolver: resolve ONDE fs/git/proc de uma TaskRun operam — e garante
 * que os TRÊS caem no MESMO runtime. É o fechamento da dívida 6 do M0 ("editar
 * numa máquina e compilar noutra"): antes, nada modelava o runtime da TAREFA
 * quando ele não era local; fs resolvia o workspace de um jeito e proc.run de
 * outro, e o bug nascia calado — arquivo escrito no host, compilado no
 * container, e o compilador nunca via a edição.
 *
 * Duas responsabilidades, cada uma com o porquê:
 *
 * - **Admissão do runtime** (a extensão §28). O scheduler (choose.ts, §28) já
 *   admite por runtimes/arch/cpu/ram/gpu/docker/browser/devices; o que ele NÃO
 *   cobre é o TIPO de runtime da tarefa quando é wsl/vps. Este módulo fecha
 *   essa ponta: a máquina escolhida sabe hospedar `host`/`docker`/`wsl`/`vps`?
 *   host sempre; docker exige a capacidade docker; wsl/vps exigem a capacidade
 *   nomeada correspondente. Falha aqui é erro NOMEADO, nunca despacho cego.
 * - **Resolução do amarrado** (o coração da dívida 6). Devolve UM RuntimeBinding
 *   por TaskRun, e fs/git/proc DERIVAM dele — não há como divergirem porque a
 *   fonte é uma só. `runtimeWorkdir` serve fs e git; `runtimeExec` embute o
 *   MESMO workdir no descritor de proc. Trocar o runtime (host→docker→wsl→vps)
 *   troca só o vetor de entrada; o workdir compartilhado é invariante.
 *
 * PURO e sem dependências (a fronteira do domain/runtime): a admissão recebe uma
 * forma ESTRUTURAL das capacidades (não o WorkerRecord de domain-workers) para
 * não puxar dependência nem inverter a direção do grafo — o scheduler é quem
 * conhece os dois lados.
 */

import type { RuntimeRequirements } from './requirements.js'

/**
 * O runtime da TAREFA — o desenho fixa `host|docker|wsl|vps` (spec §21, o campo
 * já viaja no plano como `Runtime`). `local` (o vocabulário da UI de ambientes)
 * é sinônimo de `host` e é normalizado na leitura; `cloud` não é runtime de
 * execução de tarefa aqui e morre nomeado, nunca vira host mudo.
 */
export type RuntimeKind = 'host' | 'docker' | 'wsl' | 'vps'

export const RUNTIME_KINDS: readonly RuntimeKind[] = Object.freeze([
  'host',
  'docker',
  'wsl',
  'vps',
])

const runtimeKindSet: ReadonlySet<string> = new Set(RUNTIME_KINDS)

export function isRuntimeKind(value: string): value is RuntimeKind {
  return runtimeKindSet.has(value)
}

/**
 * O runtime resolvido da tarefa. `ref` é o ENDEREÇO PRÓPRIO do runtime — imagem
 * do docker, distro do wsl, alvo ssh do vps — NUNCA um caminho de arquivo (esse
 * é o workdir, e ele nasce dentro do worker, não aqui).
 */
export interface RuntimeTarget {
  kind: RuntimeKind
  ref?: string
}

/**
 * A forma ESTRUTURAL das capacidades que a admissão do runtime consulta — o
 * subconjunto de WorkerCapabilities que importa para o TIPO de runtime. Fica
 * local de propósito: domain-runtime não depende de domain-workers, e o
 * WorkerRecord.capabilities encaixa por estrutura.
 */
export interface RuntimeHostCapabilities {
  docker?: boolean
  /** Capacidades nomeadas — é aqui que `wsl`/`vps` aparecem quando a máquina os oferece. */
  capabilities?: string[]
}

/** O veredito da admissão do runtime — ok, ou o motivo (para o log e a fila). */
export type RuntimeAdmission = { ok: true } | { ok: false; reason: string }

/**
 * O amarrado que fs, git E proc de uma TaskRun compartilham. É UM objeto: as
 * três operações DERIVAM dele, então não há janela para fs escrever num lugar e
 * proc rodar noutro (a dívida 6). `workdir` é a raiz materializada DENTRO do
 * runtime — existe só no worker (nunca viajou no plano persistente).
 */
export interface RuntimeBinding {
  kind: RuntimeKind
  workdir: string
  /** true quando fs/git/proc tocam o disco do próprio worker (host). */
  local: boolean
  ref?: string
}

/** O descritor de uma execução de proc no runtime: o MESMO workdir do binding + o vetor pronto. */
export interface RuntimeExec {
  /** O mesmo `workdir` do binding — proc roda onde fs/git leem/escrevem, por construção. */
  workdir: string
  /**
   * O vetor de comando JÁ pronto para o runtime, SEMPRE vetor (nunca string de
   * shell — injeção mora na concatenação, e proc é onde o daemon é mais sensível).
   */
  argv: string[]
  kind: RuntimeKind
  ref?: string
}

/**
 * Lê o runtime da tarefa a partir dos requisitos (§28) e do ambiente escolhido
 * na sessão. Precedência, cada degrau com o porquê:
 *
 *   1. `requirements.docker === true` FORÇA docker — o requisito de admissão
 *      manda; um ambiente "host" com docker exigido seria despacho para um lugar
 *      que não atende.
 *   2. um `environment` explícito e VÁLIDO vence (a escolha da pessoa na UI de
 *      ambientes — `local` normaliza para `host`).
 *   3. default: `host`.
 *
 * Um `environment` presente mas fora do vocabulário morre NOMEADO — a régua da
 * casa (isValidEnvironment do payloads): ambiente desconhecido não vira host
 * calado. `workerId`/`machine` que o modelo tente embutir já morreram no
 * parseRequirements; o resolver nem os enxerga.
 */
export function resolveRuntimeTarget(
  requirements: RuntimeRequirements,
  environment?: string,
  ref?: string,
): RuntimeTarget {
  const target = (kind: RuntimeKind): RuntimeTarget =>
    ref !== undefined && ref.trim() !== '' ? { kind, ref: ref.trim() } : { kind }

  if (requirements.docker === true) {
    return target('docker')
  }

  if (environment !== undefined) {
    const normalized = environment.trim().toLowerCase()
    if (normalized === 'local' || normalized === 'host') return target('host')
    if (isRuntimeKind(normalized)) return target(normalized)
    // Não normaliza `cloud` nem lixo para host: ambiente desconhecido é erro,
    // não default mudo (a lição do payloads: morre na rota que o recebe).
    throw new Error(
      `ambiente "${environment}" não é um runtime de tarefa (host|docker|wsl|vps)`,
    )
  }

  return target('host')
}

/**
 * Admite (ou recusa) o runtime da tarefa numa máquina — a extensão §28 para o
 * TIPO de runtime. host sempre cabe; docker exige a capacidade docker; wsl/vps
 * exigem a capacidade nomeada. Recusar aqui, ANTES de materializar, é o mesmo
 * princípio do choose.ts: mandar tarefa para runtime que a máquina não hospeda
 * falharia depois de baixar snapshot e montar workspace — o custo alto na hora
 * errada.
 */
export function admitRuntime(
  target: RuntimeTarget,
  caps: RuntimeHostCapabilities,
): RuntimeAdmission {
  switch (target.kind) {
    case 'host':
      return { ok: true }
    case 'docker':
      return caps.docker === true
        ? { ok: true }
        : { ok: false, reason: 'a máquina não tem docker' }
    case 'wsl':
    case 'vps':
      return (caps.capabilities ?? []).includes(target.kind)
        ? { ok: true }
        : { ok: false, reason: `a máquina não oferece runtime ${target.kind}` }
    default: {
      // Exaustividade: um RuntimeKind novo sem cláusula quebra o build aqui, não
      // vira admissão silenciosa em produção.
      const never: never = target.kind
      return { ok: false, reason: `runtime desconhecido: ${String(never)}` }
    }
  }
}

/**
 * Amarra fs/git/proc ao runtime resolvido. `localRoot` é a raiz materializada
 * NESTA máquina/runtime — ela nasce dentro do worker (o daemon a cria em
 * /workspace/materialize e NÃO a devolve ao control plane); por isso ela entra
 * aqui, no lado do runtime, e não no plano persistente.
 */
export function resolveRuntimeBinding(target: RuntimeTarget, localRoot: string): RuntimeBinding {
  const binding: RuntimeBinding = {
    kind: target.kind,
    workdir: localRoot,
    local: target.kind === 'host',
  }
  if (target.ref !== undefined) binding.ref = target.ref
  return binding
}

/**
 * A raiz que fs E git usam — deriva do MESMO binding. fs.read/write e o git
 * sombra apontam para ISTO; como a fonte é uma só, não há como um resolver o
 * workspace numa época e o outro noutra (a janela que a dívida 6 descreve).
 */
export function runtimeWorkdir(binding: RuntimeBinding): string {
  return binding.workdir
}

/**
 * Monta a execução de proc DENTRO do runtime, carregando o MESMO workdir do
 * binding — proc roda onde fs/git operam, por construção. O vetor de entrada
 * por runtime:
 *
 *   - host  → o próprio comando (o daemon roda com cwd = workdir);
 *   - docker→ `docker exec -w <workdir> <ref> …` (o container já montou o workdir);
 *   - wsl   → `wsl -d <ref> --cd <workdir> -- …`;
 *   - vps   → `ssh <ref> …` — o workdir remoto é aplicado pelo agente do outro
 *     lado (pendência declarada: sem VPS nesta estação), mas o binding CARREGA o
 *     workdir para que proc e fs/git não se separem quando o transporte existir.
 *
 * docker/wsl/vps sem `ref` é erro nomeado: resolver proc sem o alvo do runtime
 * seria justamente cair no host por engano — a dívida 6 de novo.
 */
export function runtimeExec(binding: RuntimeBinding, command: readonly string[]): RuntimeExec {
  const argv = [...command]
  const base: RuntimeExec = { workdir: binding.workdir, argv, kind: binding.kind }
  if (binding.ref !== undefined) base.ref = binding.ref

  switch (binding.kind) {
    case 'host':
      return base
    case 'docker': {
      if (binding.ref === undefined) {
        throw new Error('runtime docker sem referência de container — proc não pode resolver o alvo')
      }
      return { ...base, argv: ['docker', 'exec', '-w', binding.workdir, binding.ref, ...argv] }
    }
    case 'wsl': {
      if (binding.ref === undefined) {
        throw new Error('runtime wsl sem distro — proc não pode resolver o alvo')
      }
      return { ...base, argv: ['wsl', '-d', binding.ref, '--cd', binding.workdir, '--', ...argv] }
    }
    case 'vps': {
      if (binding.ref === undefined) {
        throw new Error('runtime vps sem alvo ssh — proc não pode resolver o alvo')
      }
      return { ...base, argv: ['ssh', binding.ref, ...argv] }
    }
    default: {
      const never: never = binding.kind
      throw new Error(`runtime desconhecido: ${String(never)}`)
    }
  }
}

/**
 * O RuntimeResolver como fachada — compõe as três operações puras. Existe
 * porque o executor da Onda 5 pede "um resolver", e um objeto nomeado lê melhor
 * na injeção do que três funções soltas; o estado é zero (as funções são a
 * verdade), então a classe é só ergonomia.
 */
export class RuntimeResolver {
  /** O runtime da tarefa a partir dos requisitos + ambiente. */
  resolveTarget(
    requirements: RuntimeRequirements,
    environment?: string,
    ref?: string,
  ): RuntimeTarget {
    return resolveRuntimeTarget(requirements, environment, ref)
  }

  /** A máquina escolhida hospeda esse runtime? (extensão §28) */
  admit(target: RuntimeTarget, caps: RuntimeHostCapabilities): RuntimeAdmission {
    return admitRuntime(target, caps)
  }

  /** O amarrado único de fs/git/proc para a TaskRun. */
  bind(target: RuntimeTarget, localRoot: string): RuntimeBinding {
    return resolveRuntimeBinding(target, localRoot)
  }
}
