/**
 * Os payloads de cada verbo — a outra metade da forma do protocol.go.
 *
 * São TIPOS, sem uma linha de runtime: o store transporta o payload como valor
 * JSON opaco e quem consome (supervisor, transporte, UI) decodifica com estes
 * contratos. Os nomes JSON são idênticos aos tags do Go pelo mesmo motivo do
 * envelope: o oráculo já gravou logs com estes nomes, e compatibilidade se
 * prova contra o que existe, não contra o que seria mais bonito.
 *
 * Campos opcionais espelham os `omitempty` do Go: ausente e vazio são a MESMA
 * coisa no fio, e o TS precisa aceitar as duas grafias ao decodificar.
 */

import type { Envelope } from './protocol.js'

/* ---------------------------- ciclo de vida ---------------------------- */

/** Abre a sessão e declara quem está do outro lado. */
export interface Hello {
  client: string
  version: string
  /**
   * Autentica a conexão NO PRIMEIRO FRAME, nunca na query string: query entra
   * em log de proxy e em mensagem de erro, e o navegador não aplica CORS a
   * WebSocket — sem token no frame, qualquer página aberta na estação
   * conversaria com o servidor.
   */
  token?: string
  sessionHint?: string
  /**
   * O DONO de uma conversa nova ("novo schema" na tela de Dados nasce do bot
   * de Dados). Ignorado quando a sessão já existe: o modo gravado é dela.
   */
  specialist?: string
  /** Replay a partir deste seq (exclusivo). Zero = do começo. */
  resumeFrom?: number
  /**
   * SÓ os eventos novos: o servidor pula o replay e o cursor nasce no seq do
   * `ready`. Existe por quem não tem tela (a ponte de ferramentas do app
   * nativo) — reenviar megabytes de histórico para serem descartados do outro
   * lado é o custo que este campo elimina. Quem tem tela NÃO usa.
   */
  liveOnly?: boolean
}

/** Resposta ao hello: o que a tela precisa para se montar sem segunda chamada. */
export interface Ready {
  session: string
  seq: number
  specialists: string[]
  models: Model[]
  /** Vazio numa sessão nova: o master só decide depois do primeiro prompt. */
  activeSpecialist?: string
  activeModel?: string
  environment?: Environment
  /** Catálogo com disponibilidade JÁ medida — oferecer opção quebrada é pior que não oferecer. */
  environments?: EnvironmentInfo[]
  /** As conversas recentes, mais nova primeiro — a barra lateral nasce daqui. */
  sessions: SessionSummary[]
}

/**
 * O cabeçalho de uma conversa: o mínimo para desenhar a linha da barra lateral
 * sem abrir o log de nenhuma delas.
 */
export interface SessionSummary {
  id: string
  title: string
  specialist?: string
  model?: string
  updatedAt: string
  turns: number
  /**
   * O bot dono e a conversa de origem. Vêm no resumo porque o aninhamento é
   * desenhado no PRIMEIRO quadro — buscar o vínculo depois faria as filhas
   * piscarem soltas na raiz antes de pular para baixo do dono.
   */
  botId?: string
  parentId?: string
  /** O último pedido feito ao bot — o subtítulo: o título diz de QUEM é, este diz O QUE ele faz. */
  lastGoal?: string
}

/** Um modelo oferecido ao usuário. O usuário escolhe; a política decide a lista. */
export interface Model {
  id: string
  provider: string
  label: string
  context: number
  skills?: string[]
  local?: boolean
}

/* ------------------------------- ambiente ------------------------------ */

/**
 * ONDE o próximo comando roda — destino real de execução, não preferência de
 * exibição. Viaja no protocolo porque rotear só o terminal (a cicatriz do
 * produto anterior) fazia o agente compilar numa máquina e ler noutra sem
 * ninguém perceber.
 */
export type Environment = 'local' | 'docker' | 'wsl' | 'vps' | 'cloud'

const environmentSet: ReadonlySet<string> = new Set<Environment>([
  'local', 'docker', 'wsl', 'vps', 'cloud',
])

/** Ambiente desconhecido morre na rota que o recebe, não num default mudo. */
export function isValidEnvironment(value: string): value is Environment {
  return environmentSet.has(value)
}

/**
 * Um ambiente como a tela o vê. `available` e `detail` existem juntos de
 * propósito: a opção que não funciona aparece cinza COM o motivo — sumir com
 * ela faz a pessoa procurá-la.
 */
export interface EnvironmentInfo {
  id: Environment
  label: string
  hint: string
  available: boolean
  detail?: string
}

/* ------------------------------- conversa ------------------------------ */

/** O texto enviado pela pessoa. */
export interface Prompt {
  text: string
  /** Vazio = o master decide (o caminho normal). Preenchido só na escolha manual. */
  specialist?: string
  model?: string
  attachments?: Attachment[]
  /** Caminhos citados com @ no composer. */
  mentions?: string[]
}

/** Anexo já materializado — o transporte não carrega arquivo solto. */
export interface Attachment {
  name: string
  mime: string
  bytes: number
  /** Identificador no store local: conteúdo não trafega no envelope. */
  ref: string
}

/**
 * COMO a rota foi decidida — a UI mostra ao passar o mouse, porque troca de
 * especialista que a pessoa não entende parece defeito.
 */
export type RouteReason =
  | 'explicit'   // a pessoa escolheu
  | 'heuristic'  // o classificador léxico decidiu sozinho, com folga
  | 'needle'     // o modelo local minúsculo classificou, sem rede
  | 'model'      // o modelo master classificou
  | 'sticky'     // a conversa JÁ TEM modo; ninguém classificou nada
  | 'fallback'   // nada decidiu; caiu no padrão

/** A decisão do supervisor para uma linha da conversa. */
export interface Route {
  specialist: string
  previous?: string
  reason: RouteReason
  /** Em [0,1]. Abaixo do limiar, o supervisor desce um degrau da cascata. */
  confidence: number
  /**
   * A superfície que a tela deve assumir. Viaja junto porque trocar de
   * especialista e trocar de tela são o MESMO evento — separá-los deixa a
   * tela um quadro atrás do ícone.
   */
  surface: string
  model: string
  /** Os termos que pesaram (vazio quando a decisão veio do modelo). */
  signals?: string[]
  /**
   * O elenco de apoio: quem entra em espera junto com o dono. Sem isto a
   * pessoa precisaria lembrar de pedir cada especialista — devolvendo a ela o
   * roteamento que o master existe para fazer.
   */
  standby?: Standby[]
}

/** Um especialista de apoio, e QUANDO ele entra. */
export interface Standby {
  specialist: string
  /**
   * "parallel" (junto do dono) ou "after" (sobre o que o dono produziu). É o
   * formato do plano: paralelizar quem depende gera parecer sobre trabalho
   * que não existe; serializar quem é independente dobra o tempo por nada.
   */
  when: string
  /** A frase que a tela mostra, escrita para a pessoa ler. */
  why: string
}

/** Um pedaço de resposta em streaming. */
export interface Delta {
  text: string
}

/** Uma mensagem inteira (replay e transportes sem stream). */
export interface Message {
  role: string // user | assistant | system
  text: string
  /** Redundante com from.specialist de propósito: o replay lê a mensagem sem o envelope. */
  specialist?: string
  model?: string
}

/** Sinal de raciocínio — a UI mostra o orbe. */
export interface Thinking {
  label: string
  done?: boolean
  /**
   * Marca `label` como TEXTO DE RACIOCÍNIO do modelo, não rótulo de etapa.
   * Opcional dos dois lados de propósito: payload antigo decodifica como
   * rótulo (false) e cliente antigo ignora o campo extra.
   */
  reasoning?: boolean
}

/* ------------------------------ ferramentas ----------------------------- */

/** O modelo pedindo para executar uma ferramenta. */
export interface ToolCall {
  callId: string
  tool: string
  args?: unknown
  /**
   * Identifica argumentos iguais entre chamadas — é o que permite "aprovar
   * sempre" sem virar cheque em branco para qualquer argumento.
   */
  digest?: string
}

/** O retorno da ferramenta (ou o erro dela). */
export interface ToolResult {
  callId: string
  tool: string
  ok: boolean
  output?: string
  error?: string
  elapsedMs?: number
  /**
   * A saída passou do teto inline: `output` é uma PROJEÇÃO (início + fim) e o
   * integral vive no Artifact Store. Nenhuma ferramenta despeja saída
   * ilimitada na janela do modelo.
   */
  truncated?: boolean
  artifactRef?: string
  rawBytes?: number
}

/* ------------------------------- permissão ------------------------------ */

/** O estrago possível de uma ferramenta. */
export type Risk = 'read' | 'write' | 'execute' | 'network' | 'secret'

/** Suspende a execução até uma pessoa decidir. */
export interface ApprovalRequest {
  callId: string
  tool: string
  risk: Risk
  /** A frase que a pessoa lê ANTES de decidir — sem ela o botão vira automático. */
  summary: string
  detail?: string
  digest?: string
}

/** A decisão humana que libera ou recusa. */
export interface ApprovalDecision {
  callId: string
  allow: boolean
  scope?: string // once | digest | session
  comment?: string
}

/* ------------------------------ orquestração ---------------------------- */

/** Um nó do DAG de orquestração. */
export interface Task {
  id: string
  title: string
  specialist: string
  goal: string
  dependsOn?: string[]
  /** Cópia própria do repositório: duas tarefas no mesmo arquivo sem isto se sobrescrevem caladas. */
  worktree?: boolean
  model?: string
}

/** Entrega a tarefa ao trabalhador. */
export interface TaskDispatch {
  task: Task
  /** O PC registrado; o processo lógico vive no taskRunId (D2: nunca misturar os dois). */
  workerId: string
  /** ESTA execução da tarefa, tentativa incluída. */
  taskRunId?: string
  /** O plano congelado em que a execução trabalha, e a época do lease no congelamento. */
  workspacePlanId?: string
  leaseEpoch?: number
  /** A onda topológica do DAG — tudo na mesma onda pode rodar junto. */
  wave: number
}

/** Andamento sem encerrar a tarefa. */
export interface TaskProgress {
  taskId: string
  workerId: string
  note: string
  fraction?: number
}

/** Encerra a tarefa de um trabalhador. */
export interface WorkerDone {
  taskId: string
  workerId: string
  ok: boolean
  result?: string
  error?: string
  worktree?: string
  branch?: string
  /**
   * O trabalhador PAROU PARA PERGUNTAR em vez de errar. Vem com ok=false e
   * mesmo assim NÃO é falha — o campo viaja aqui porque cruzar o escalate com
   * o done pelo taskId quebra quando dois planos reusam o mesmo id de tarefa.
   */
  escalated?: boolean
}

/** Devolve a decisão para cima quando o trabalhador não consegue decidir. */
export interface Escalate {
  taskId: string
  workerId: string
  question: string
  options?: string[]
}

/** Pergunta bloqueante de um agente para outro (ou para a pessoa). */
export interface Ask {
  askId: string
  question: string
  options?: string[]
  /** O corpo da decisão, separado da pergunta: afogar a frase num texto longo vira botão automático. */
  detail?: string
  /** false permite seguir sem resposta (aviso, não pergunta). */
  blocking: boolean
}

/** Destrava um Ask. */
export interface Reply {
  askId: string
  answer: string
}

/** O veredito de um portão do DAG. */
export type GateDecision = 'proceed' | 'retry' | 'abort'

/** O portão entre ondas do DAG: segue, refaz ou aborta. */
export interface Gate {
  gateId: string
  taskId?: string
  decision: GateDecision
  reason?: string
}

/* ------------------------------- delegação ------------------------------ */

/**
 * Um especialista chamando OUTRO por conta própria, no meio do próprio turno.
 *
 * NÃO é TaskDispatch: aquele monta uma equipe (DAG, ondas, worktrees) por
 * decisão deliberada do especialista `agent`; este é um pedido pontual, sem
 * plano e sem segundo turno — o dono da conversa continua sendo quem delegou.
 * Sai DUAS vezes: done=false antes de o delegado começar (é o que faz o popup
 * aparecer na hora certa) e done=true com o resultado.
 */
export interface Delegate {
  from: string
  to: string
  goal: string
  reason?: string
  /** 1 = primeira delegação. */
  depth: number
  done?: boolean
  result?: string
  /** A conversa do delegado, pendurada nesta. Vazio quando não deu para abrir — o espelho é acessório. */
  session?: string
}

/* -------------------------------- estado -------------------------------- */

/** Uma mudança de estado observável (sessão, especialista, modelo, ambiente). */
export interface State {
  specialist?: string
  model?: string
  surface?: string
  environment?: Environment
  busy: boolean
  promptTokens?: number
  outputTokens?: number
  /**
   * Publicação nova PENDENTE (baixada, verificada, esperando reinício).
   * Pendente, e não "existe versão nova": avisar sobre o que já está valendo
   * faria o aviso que realmente pede algo da pessoa virar ruído.
   */
  updateAvailable?: boolean
  updateVersion?: string
  updateTracks?: string[]
}

/**
 * O aviso animado de execução — o supervisor contando, ANTES de fazer, onde um
 * passo vai rodar. Viaja EFÊMERO, nunca no log durável: um replay que
 * reencenasse o popup de ontem seria defeito.
 */
export interface Notice {
  icon: string
  title: string
  detail?: string
  /** O especialista ativo: é o avatar DELE que desliza no popup. */
  specialist?: string
}

/** Encerra o turno com motivo legível. (Payload do verbo `error`.) */
export interface ErrorPayload {
  code: string
  message: string
  /** Diz se refazer o mesmo pedido tem chance de dar certo. */
  retryable?: boolean
}

/** Fecha o turno com sucesso. */
export interface Done {
  turn: string
  specialist?: string
  outputTokens?: number
  interrupted?: boolean
}

/**
 * Decodifica o payload de um envelope com o tipo do chamador. Payload ausente
 * é erro de protocolo aqui — um zero-value silencioso adiante é exatamente o
 * defeito que a borda existe para impedir.
 */
export function decodePayload<T>(envelope: Envelope): T {
  if (envelope.payload === undefined || envelope.payload === null) {
    throw new Error(`payload ausente para ${envelope.kind}`)
  }
  return envelope.payload as T
}
