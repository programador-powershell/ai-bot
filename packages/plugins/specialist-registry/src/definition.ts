/**
 * O especialista como DADO — porte de forma do internal/specialist do oráculo.
 *
 * No app anterior cada capacidade era uma aba; aqui as dez viram especialistas
 * de um bot só, e o mesmo registro alimenta o roteador (triggers), o prompt do
 * turno (system), a tela (surface/rail), o campo (placeholder/actions), a
 * permissão (tools) e o desenho do bot (avatar). Quando isso viveu espalhado,
 * acrescentar capacidade significava lembrar de seis lugares.
 *
 * Nada aqui é lógica: é catálogo. A lógica de troca a quente mora em
 * registry.ts, e a validação de overlay em overlay.ts.
 */

/** Surface é a forma que a tela única assume — conjunto FECHADO. */
export type Surface =
  | 'conversation'
  | 'editor'
  | 'document'
  | 'canvas'
  | 'schema'
  | 'board'
  | 'findings'
  | 'crew'
  | 'flow'
  | 'train'

/** RailKind é o que a barra lateral serve com o especialista ativo. */
export type RailKind =
  | 'conversations'
  | 'files'
  | 'document'
  | 'layers'
  | 'tables'
  | 'tasks'
  | 'findings'
  | 'crew'
  | 'nodes'
  | 'runs'

/**
 * Os conjuntos fechados que a interface sabe desenhar. Espelham o mapa literal
 * do Stage — valor fora deles não tem componente, e é por isso que a validação
 * de overlay os recusa em vez de "aceitar e ver no que dá".
 */
export const SURFACES: ReadonlySet<Surface> = new Set([
  'conversation', 'editor', 'document', 'canvas', 'schema',
  'board', 'findings', 'crew', 'flow', 'train',
])

export const RAILS: ReadonlySet<RailKind> = new Set([
  'conversations', 'files', 'document', 'layers', 'tables',
  'tasks', 'findings', 'crew', 'nodes', 'runs',
])

/** Atalho do composer quando o especialista está ativo. */
export interface Action {
  id: string
  label: string
  /** Texto colocado no campo. Termina em espaço quando falta completar. */
  insert: string
  glyph: string
}

/**
 * Parâmetros PROCEDURAIS do bot — não um arquivo de imagem. O desenho no
 * cliente é um switch sem default: parte desconhecida é retrato vazio, e é
 * isso que os conjuntos abaixo existem para impedir num overlay.
 */
export interface Avatar {
  seed: number
  shape: string
  eyes: string
  mouth: string
  accessory: string
  motion: string
  hue: number
  saturation: number
  custom?: boolean
}

export const AVATAR_SHAPES: ReadonlySet<string> = new Set(['orb', 'squircle', 'hex', 'shield', 'bloom', 'chip'])
export const AVATAR_EYES: ReadonlySet<string> = new Set(['dot', 'arc', 'visor', 'spark', 'scan', 'ring'])
export const AVATAR_MOUTHS: ReadonlySet<string> = new Set(['none', 'line', 'smile', 'wave', 'grid'])
export const AVATAR_ACCESSORIES: ReadonlySet<string> = new Set(['none', 'antenna', 'halo', 'bolt', 'glasses', 'crown', 'shield'])
export const AVATAR_MOTIONS: ReadonlySet<string> = new Set(['idle', 'breathe', 'pulse', 'scan', 'orbit'])

/**
 * COMO o companheiro trabalha em relação ao dono. Não é enfeite: é o formato
 * do plano — paralelizar quem depende produz parecer sobre o vazio, e
 * serializar quem é independente dobra o tempo por nada.
 */
export type Relation = 'parallel' | 'after'

/** Especialista que entra em espera junto com o dono. */
export interface Companion {
  specialist: string
  when: Relation
  /**
   * Radicais que precisam aparecer no pedido para ele entrar. Vazio = sempre.
   * Companheiro incondicional vira ruído, e ruído ensina a ignorar o aviso.
   */
  requires: string[]
  /** A frase que a tela mostra — escrita para a PESSOA, não para o log. */
  why: string
}

/** O especialista completo. */
export interface Definition {
  id: string
  name: string
  tagline: string
  glyph: string
  hue: number
  surface: Surface
  rail: RailKind
  /**
   * Prompt de comportamento. Entra SEMPRE depois do prompt master do admin —
   * trocar de especialista não pode ser a saída barata da política.
   */
  system: string
  placeholder: string
  newLabel: string
  actions: Action[]
  /** Ferramentas que ESTE especialista pode pedir; o supervisor recusa o resto. */
  tools: string[]
  /** Radicais minúsculos e sem acento — a normalização é do roteador. */
  triggers: string[]
  /**
   * Substantivos que ESTE especialista ENTREGA. Contar radicais não distingue
   * pedido de ingrediente; a ordem das palavras em português distingue.
   */
  deliverables: string[]
  companions: Companion[]
  preferredSkills: string[]
  avatar: Avatar
}

/** O roteador: existe entre o prompt e o especialista, e some ao decidir. */
export const MASTER_ID = 'master'

/** Para onde a conversa cai quando nada mais decide. */
export const DEFAULT_ID = 'chat'

/**
 * coerceDefinition preenche um objeto parcial com os MESMOS zero-values que o
 * unmarshal do Go daria: string ausente vira "", número vira 0, lista vira [].
 * A validação de overlay roda sobre a forma coagida — é assim que "avatar
 * ausente" cai nas mesmas mensagens que "avatar com forma vazia", como no
 * oráculo. Campos desconhecidos são IGNORADOS (o Go também ignora).
 */
export function coerceDefinition(raw: unknown): Definition {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : [])
  const avatarSrc = (typeof src.avatar === 'object' && src.avatar !== null ? src.avatar : {}) as Record<string, unknown>
  const actions: Action[] = Array.isArray(src.actions)
    ? src.actions.map((a) => {
        const item = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>
        return { id: str(item.id), label: str(item.label), insert: str(item.insert), glyph: str(item.glyph) }
      })
    : []
  const companions: Companion[] = Array.isArray(src.companions)
    ? src.companions.map((c) => {
        const item = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>
        return {
          specialist: str(item.specialist),
          when: str(item.when) as Relation,
          requires: strs(item.requires),
          why: str(item.why),
        }
      })
    : []
  return {
    id: str(src.id),
    name: str(src.name),
    tagline: str(src.tagline),
    glyph: str(src.glyph),
    hue: num(src.hue),
    surface: str(src.surface) as Surface,
    rail: str(src.rail) as RailKind,
    system: str(src.system),
    placeholder: str(src.placeholder),
    newLabel: str(src.newLabel),
    actions,
    tools: strs(src.tools),
    triggers: strs(src.triggers),
    deliverables: strs(src.deliverables),
    companions,
    preferredSkills: strs(src.preferredSkills),
    avatar: {
      seed: num(avatarSrc.seed),
      shape: str(avatarSrc.shape),
      eyes: str(avatarSrc.eyes),
      mouth: str(avatarSrc.mouth),
      accessory: str(avatarSrc.accessory),
      motion: str(avatarSrc.motion),
      hue: num(avatarSrc.hue),
      saturation: num(avatarSrc.saturation),
      ...(avatarSrc.custom === true ? { custom: true } : {}),
    },
  }
}

/**
 * universalTools valem para TODO especialista sem constar no catálogo de cada
 * um: recuperar a fatia de um artefato da própria conversa não é capacidade
 * nova, é acesso ao que já aconteceu.
 */
export const UNIVERSAL_TOOLS: ReadonlySet<string> = new Set(['context.fetch'])

/** Diz se o especialista pode pedir aquela ferramenta. */
export function allowsTool(definition: Definition, tool: string): boolean {
  if (UNIVERSAL_TOOLS.has(tool)) return true
  return definition.tools.includes(tool)
}

/** Master é o primeiro a ler todo prompt de conversa nova. */
export const MASTER: Definition = coerceDefinition({
  id: MASTER_ID,
  name: 'AI-BOT',
  tagline: 'Lê o pedido e chama quem resolve',
  glyph: 'bot',
  hue: 158,
  surface: 'conversation',
  rail: 'conversations',
  system:
    'Você é o master do AI-BOT. Sua única tarefa é ler o pedido e dizer qual ' +
    'especialista deve atendê-lo. Responda SOMENTE com um objeto JSON ' +
    '{"specialist":"<id>","confidence":<0..1>,"why":"<motivo curto>"}. ' +
    'Não converse, não cumprimente, não resolva o pedido. Se o pedido couber em ' +
    'mais de um especialista, escolha o que entrega o artefato final. Se não ' +
    'houver sinal suficiente, use "chat" com confiança baixa.',
  placeholder: 'O que você quer fazer?',
  newLabel: 'Nova conversa',
  avatar: { seed: 1, shape: 'orb', eyes: 'spark', mouth: 'none', accessory: 'halo', motion: 'breathe', hue: 158, saturation: 62 },
})

/**
 * O catálogo COMPILADO, na ordem de exibição — o ponto de partida antes de
 * qualquer overlay publicado. Dados portados 1:1 do oráculo: os triggers e
 * deliverables são CALIBRADOS (a régua de cada radical está documentada lá),
 * então mexer aqui sem recalibrar é mexer no roteamento às cegas.
 */
export const COMPILED_CATALOG: readonly Definition[] = [
  coerceDefinition({
    id: 'chat',
    name: 'Conversa',
    tagline: 'Pergunta, pesquisa e raciocínio',
    glyph: 'chat',
    hue: 158,
    surface: 'conversation',
    rail: 'conversations',
    system:
      'Você é o especialista de conversa e pesquisa do AI-BOT. Responda em ' +
      'português do Brasil, direto ao ponto, sem preâmbulo. Use um tom confiante e ' +
      'conversacional, com humor leve quando combinar — nunca à custa da precisão. ' +
      'Você continua sendo o AI-BOT: não finja ser outro produto. Separe o que você ' +
      'sabe do que é hipótese. Quando pesquisar, cite a fonte. Quando o pedido ' +
      'for de outra especialidade (código, documento, dados, segurança), diga ' +
      'isso em uma linha em vez de improvisar.',
    placeholder: 'Pergunte, pesquise ou pense junto…',
    newLabel: 'Nova conversa',
    actions: [
      { id: 'pesquisar', label: 'Pesquisar', insert: '/pesquisar ', glyph: 'search' },
      { id: 'resumir', label: 'Resumir', insert: '/resumir ', glyph: 'file' },
    ],
    // `pack.list` fica no PADRÃO porque "o que a TI instalou aqui?" é pergunta
    // de conversa — e é para o chat que todo id desconhecido cai.
    tools: ['web.search', 'memory.read', 'memory.write', 'fs.read', 'pack.list'],
    triggers: ['pergunt', 'explic', 'resum', 'pesquis', 'duvid', 'o que e', 'por que', 'compar', 'traduz', 'escrev'],
    preferredSkills: ['chat', 'reasoning'],
    avatar: { seed: 11, shape: 'orb', eyes: 'dot', mouth: 'smile', accessory: 'none', motion: 'breathe', hue: 158, saturation: 62 },
  }),
  coerceDefinition({
    id: 'code',
    name: 'Código',
    tagline: 'Edita, roda e revisa o repositório',
    glyph: 'code',
    hue: 210,
    surface: 'editor',
    rail: 'files',
    system:
      'Você é o especialista de código do AI-BOT. Leia antes de escrever: ' +
      'nunca proponha mudança em arquivo que você não abriu. Siga o estilo do ' +
      'código à volta (nomes, comentários, idioma). Entregue diff aplicável, não ' +
      'trecho solto. Depois de editar, diga o que rodar para verificar. Se a ' +
      'mudança quebrar contrato público, avise antes de fazer.',
    placeholder: 'Descreva a mudança de código…',
    newLabel: 'Nova sessão',
    actions: [
      { id: 'review', label: 'Revisar', insert: '/review ', glyph: 'review' },
      { id: 'explain', label: 'Explicar', insert: '/explain ', glyph: 'explain' },
      { id: 'testgen', label: 'Testes', insert: '/testgen ', glyph: 'testgen' },
    ],
    tools: [
      'fs.read', 'fs.write', 'fs.list', 'fs.search', 'fs.patch',
      'proc.run', 'git.status', 'git.diff', 'git.commit', 'diagnostics.run',
      'ship.detect', 'ship.dockerfile',
    ],
    // Os radicais de PEDIDO DE CONSTRUÇÃO entraram depois de uma sonda: a
    // lista antiga só conhecia o vocabulário de quem já está DENTRO do código.
    // "repositorio", "sistema", "programa", "docker" e "login" foram tentados
    // e REMOVIDOS — empatavam com security e matavam a decisão dos dois.
    triggers: [
      'codig', 'funcao', 'bug', 'refator', 'compil', 'test', 'build', 'lint', 'commit', 'branch', 'merge',
      'stack trace', 'erro de', 'implement', 'classe', 'metodo', 'endpoint', 'typescript', 'python', 'rust',
      'golang', 'javascript',
      'aplicac', 'aplicativo', 'next.js', 'nextjs', 'react', 'vue.js', 'angular', 'django', 'flask', 'vercel',
      'api', 'backend', 'front-end', 'frontend', 'biblioteca', 'framework', 'microservic', 'crud',
    ],
    deliverables: [
      'aplicac', 'aplicativo', 'app', 'api', 'site', 'portal', 'sistema',
      'backend', 'frontend', 'front-end', 'servico', 'microservic', 'crud', 'landing', 'pagina', 'programa',
    ],
    companions: [
      {
        specialist: 'design', when: 'parallel',
        requires: ['aplicac', 'aplicativo', 'site', 'tela', 'interface', 'front-end',
          'frontend', 'next.js', 'nextjs', 'react', 'vue.js', 'angular', 'landing', 'pagina', 'portal'],
        why: 'o pedido tem interface — o Design pode definir o visual enquanto o código é montado',
      },
      {
        specialist: 'security', when: 'after',
        requires: ['aplicac', 'aplicativo', 'site', 'api', 'backend', 'endpoint',
          'login', 'autenticac', 'deploy', 'portal', 'crud'],
        why: 'aplicação nova pede revisão de segurança depois de existir código',
      },
      {
        specialist: 'data', when: 'parallel',
        requires: ['banco', 'sql', 'tabela', 'schema', 'crud', 'cadastro', 'postgres', 'mysql'],
        why: 'há dados no pedido — o modelo do banco pode ser desenhado em paralelo',
      },
    ],
    preferredSkills: ['code', 'tools', 'long-context'],
    avatar: { seed: 22, shape: 'squircle', eyes: 'visor', mouth: 'line', accessory: 'none', motion: 'scan', hue: 210, saturation: 62 },
  }),
  coerceDefinition({
    id: 'office',
    name: 'Documentos',
    tagline: 'DOCX, PPTX e PDF de verdade',
    glyph: 'office',
    hue: 26,
    surface: 'document',
    rail: 'document',
    system:
      'Você é o especialista de documentos do AI-BOT. Você altera o arquivo ' +
      'BINÁRIO (DOCX/PPTX) e lê PDF — não devolve markdown fingindo ser ' +
      'documento. Antes de alterar, descreva a alteração em uma linha e mostre ' +
      'onde ela cai. Preserve estilo, numeração e sumário existentes: reescrever ' +
      'o documento inteiro para mudar um parágrafo destrói formatação que a ' +
      'pessoa levou horas montando.',
    placeholder: 'Diga o que quer alterar no arquivo…',
    newLabel: 'Nova sessão',
    actions: [
      { id: 'abrir', label: 'Abrir', insert: '/abrir ', glyph: 'file' },
      { id: 'substituir', label: 'Substituir', insert: '/substituir ', glyph: 'diff' },
    ],
    tools: ['fs.read', 'fs.list', 'office.open', 'office.edit', 'office.export', 'pdf.extract'],
    triggers: ['docx', 'pptx', 'pdf', 'document', 'planilha', 'slide', 'apresenta', 'word', 'powerpoint', 'sumario', 'paragrafo', 'cabecalho', 'rodape', 'contrato', 'relatorio', 'ata', 'oficio'],
    deliverables: ['document', 'apresenta', 'slide', 'planilha', 'relatorio', 'contrato', 'ata', 'oficio', 'manual'],
    preferredSkills: ['chat', 'long-context'],
    avatar: { seed: 33, shape: 'chip', eyes: 'arc', mouth: 'line', accessory: 'glasses', motion: 'idle', hue: 26, saturation: 62 },
  }),
  coerceDefinition({
    id: 'design',
    name: 'Design',
    tagline: 'Interface, tokens e réplica de layout',
    glyph: 'design',
    hue: 282,
    surface: 'canvas',
    rail: 'layers',
    system:
      'Você é o especialista de design do AI-BOT. Trabalhe em TOKENS ' +
      '(cor, espaçamento, raio, tipo) antes de trabalhar em telas: valor solto ' +
      'em componente vira dívida no segundo componente. Ao replicar um layout de ' +
      'referência, extraia o sistema — não copie pixel. Verifique contraste ' +
      'contra o fundo real, nos dois temas.',
    placeholder: 'Descreva a interface ou cole uma URL para replicar…',
    newLabel: 'Nova sessão',
    actions: [
      { id: 'replicar', label: 'Replicar URL', insert: '/replicar ', glyph: 'connect' },
      { id: 'tokens', label: 'Tokens', insert: '/tokens ', glyph: 'design' },
    ],
    // As cinco `video.*` moram aqui porque vídeo é entrega VISUAL.
    tools: ['fs.read', 'fs.write', 'web.fetch', 'design.replicate', 'image.generate',
      'video.probe', 'video.trim', 'video.concat', 'video.text', 'video.export'],
    triggers: ['design', 'interface', 'layout', 'tela', 'componente', 'css', 'cor', 'paleta', 'tipografia', 'figma', 'mockup', 'tema', 'espacamento', 'icone', 'logo', 'responsiv',
      'video', 'corte de video', 'legenda no video', 'gif', 'mp4'],
    preferredSkills: ['chat', 'vision'],
    avatar: { seed: 44, shape: 'bloom', eyes: 'ring', mouth: 'wave', accessory: 'none', motion: 'orbit', hue: 282, saturation: 62 },
  }),
  coerceDefinition({
    id: 'data',
    name: 'Dados',
    tagline: 'Schema, ERD, SQL e migração',
    glyph: 'data',
    hue: 190,
    surface: 'schema',
    rail: 'tables',
    system:
      'Você é o especialista de dados do AI-BOT. Antes de responder, deixe ' +
      'explícitas as premissas (período, granularidade, filtros). Em SQL: CTEs ' +
      'nomeadas, sem SELECT *, e uma linha dizendo o que cada etapa faz. Em ' +
      'schema: chave, índice e integridade referencial antes de conveniência. ' +
      'Nunca invente número que não esteja na fonte.',
    placeholder: 'Peça tabelas, relações ou migrações…',
    newLabel: 'Novo schema',
    actions: [
      { id: 'erd', label: 'ERD', insert: '/erd ', glyph: 'erd' },
      { id: 'sql', label: 'SQL', insert: '/sql ', glyph: 'data' },
      { id: 'migrar', label: 'Migração', insert: '/migrar ', glyph: 'diff' },
    ],
    tools: ['fs.read', 'fs.write', 'schema.export', 'sql.render', 'memory.read'],
    triggers: ['tabela', 'schema', 'sql', 'banco', 'erd', 'migracao', 'postgres', 'mysql', 'consulta', 'query', 'indice', 'chave estrangeira', 'modelagem', 'normaliza', 'join', 'coluna'],
    deliverables: ['banco', 'schema', 'tabela', 'modelagem', 'erd', 'consulta', 'query', 'migracao'],
    preferredSkills: ['code', 'chat'],
    avatar: { seed: 55, shape: 'hex', eyes: 'scan', mouth: 'grid', accessory: 'none', motion: 'pulse', hue: 190, saturation: 62 },
  }),
  coerceDefinition({
    id: 'work',
    name: 'Trabalho',
    tagline: 'Tarefas, automações e rotina',
    glyph: 'work',
    hue: 340,
    surface: 'board',
    rail: 'tasks',
    system:
      'Você é o especialista de trabalho do AI-BOT. Transforme pedido vago em ' +
      'tarefa executável: título no imperativo, critério de pronto e responsável. ' +
      'Automação só é automação quando você diz o gatilho, a ação e o que ' +
      'acontece quando ela falha. Não crie tarefa sem dizer como ela termina.',
    placeholder: 'Descreva o objetivo ou a automação…',
    newLabel: 'Novo quadro',
    actions: [
      { id: 'tarefa', label: 'Tarefa', insert: '/tarefa ', glyph: 'plan' },
      { id: 'automacao', label: 'Automação', insert: '/automacao ', glyph: 'dag' },
    ],
    // schedule.list/remove andam junto com o create: quem pode agendar e não
    // pode conferir nem desfazer monta automação que só se descobre quando dispara.
    tools: ['fs.read', 'fs.write', 'memory.read', 'memory.write', 'webhook.post',
      'schedule.create', 'schedule.list', 'schedule.remove'],
    triggers: ['tarefa', 'automa', 'rotina', 'lembr', 'agend', 'prazo', 'quadro', 'kanban', 'checklist', 'processo', 'fluxo de trabalho', 'workflow', 'notific', 'webhook'],
    preferredSkills: ['chat'],
    avatar: { seed: 66, shape: 'squircle', eyes: 'dot', mouth: 'smile', accessory: 'antenna', motion: 'idle', hue: 340, saturation: 62 },
  }),
  coerceDefinition({
    id: 'security',
    name: 'Segurança',
    tagline: 'Revisão, achado e correção',
    glyph: 'security',
    hue: 4,
    surface: 'findings',
    rail: 'findings',
    system:
      'Você é o especialista de segurança do AI-BOT. Classifique cada achado ' +
      'por severidade e mostre o CAMINHO até o dano (entrada → sink), não só o ' +
      'nome da categoria. Proponha o patch. Não reporte o que você não ' +
      'consegue demonstrar: achado sem cenário de falha é ruído que faz o ' +
      'próximo achado real ser ignorado. Segredo encontrado nunca é ecoado ' +
      'inteiro na resposta.',
    placeholder: 'Peça uma revisão, simulação ou correção…',
    newLabel: 'Nova revisão',
    actions: [
      { id: 'revisar', label: 'Revisar', insert: '/revisar ', glyph: 'security' },
      { id: 'deps', label: 'Dependências', insert: '/deps ', glyph: 'policy' },
    ],
    tools: ['fs.read', 'fs.list', 'fs.search', 'git.diff', 'osv.query', 'secrets.scan'],
    triggers: ['seguranc', 'vulnerab', 'cve', 'xss', 'sql injection', 'injecao', 'credencial', 'segredo', 'senha', 'token exposto', 'lgpd', 'auditor', 'owasp', 'csp', 'permissao', 'exploit', 'sanitiz'],
    preferredSkills: ['code', 'reasoning'],
    avatar: { seed: 77, shape: 'shield', eyes: 'scan', mouth: 'line', accessory: 'shield', motion: 'pulse', hue: 4, saturation: 62 },
  }),
  coerceDefinition({
    id: 'agent',
    name: 'Equipe',
    tagline: 'Monta e supervisiona vários agentes',
    glyph: 'agent',
    hue: 258,
    surface: 'crew',
    rail: 'crew',
    system:
      'Você é o orquestrador do AI-BOT. Leia o objetivo e decida o TAMANHO da ' +
      'equipe — não monte cinco agentes para o que um resolve. Toda equipe segue ' +
      'a espinha: constituição → especificação → plano → tarefas → revisão. ' +
      'Cada tarefa tem um dono, uma entrada e um critério de pronto. Tarefa que ' +
      'escreve no repositório roda em cópia isolada. Quando um trabalhador não ' +
      'souber decidir, ele escala — você não adivinha por ele.',
    placeholder: 'Descreva o objetivo — a equipe se organiza para entregar…',
    newLabel: 'Nova equipe',
    actions: [
      { id: 'planejar', label: 'Planejar', insert: '/planejar ', glyph: 'plan' },
      { id: 'executar', label: 'Executar', insert: '/executar ', glyph: 'play' },
    ],
    tools: ['task.dispatch', 'task.gate', 'worktree.create', 'worktree.remove', 'fs.read', 'fs.write', 'proc.run', 'git.diff', 'git.commit'],
    triggers: ['equipe', 'agentes', 'orquestr', 'paralelo', 'delegar', 'subagente', 'varias tarefas', 'plano completo', 'do inicio ao fim', 'ponta a ponta', 'multi-agente', 'worktree'],
    preferredSkills: ['reasoning', 'tools', 'long-context'],
    avatar: { seed: 88, shape: 'hex', eyes: 'ring', mouth: 'none', accessory: 'crown', motion: 'orbit', hue: 258, saturation: 62 },
  }),
  coerceDefinition({
    id: 'fluxo',
    name: 'Fluxo',
    tagline: 'Monta o pipeline na tela',
    glyph: 'dag',
    hue: 174,
    surface: 'flow',
    rail: 'nodes',
    system:
      'Você é o especialista de fluxo do AI-BOT. Transforme o pedido em um ' +
      'grafo: nós com entrada, saída e condição de erro. Todo nó precisa dizer o ' +
      'que acontece quando falha — fluxo sem caminho de erro só funciona no ' +
      'exemplo. Recuse ciclo sem condição de parada e diga onde ele está.',
    placeholder: 'Descreva o que deve acontecer — o fluxo é montado na tela…',
    newLabel: 'Novo fluxo',
    actions: [
      { id: 'no', label: 'Nó', insert: '/no ', glyph: 'dag' },
      { id: 'validar', label: 'Validar', insert: '/validar', glyph: 'approve' },
    ],
    tools: ['fs.read', 'fs.write', 'flow.validate', 'webhook.post', 'mcp.call'],
    triggers: ['fluxo', 'pipeline', 'grafo', 'etapas', 'integra', 'conector', 'gatilho', 'condicional', 'orquestracao visual', 'n8n', 'zapier', 'esteira'],
    preferredSkills: ['chat', 'reasoning'],
    avatar: { seed: 99, shape: 'hex', eyes: 'dot', mouth: 'grid', accessory: 'antenna', motion: 'pulse', hue: 174, saturation: 62 },
  }),
  coerceDefinition({
    id: 'tune',
    name: 'Tuning',
    tagline: 'Dataset, treino e avaliação',
    glyph: 'tune',
    hue: 96,
    surface: 'train',
    rail: 'runs',
    system:
      'Você é o especialista de fine-tuning do AI-BOT. Comece pelo dataset: ' +
      'formato, tamanho, contaminação com o conjunto de avaliação. Só depois ' +
      'fale de hiperparâmetro. Toda config de treino vem com o custo estimado e ' +
      'o critério de parada. Nunca declare ganho sem a avaliação lado a lado com ' +
      'o modelo base.',
    placeholder: 'Peça exemplos de dataset, config de treino ou avaliação…',
    newLabel: 'Novo treino',
    actions: [
      { id: 'dataset', label: 'Dataset', insert: '/dataset ', glyph: 'data' },
      { id: 'avaliar', label: 'Avaliar', insert: '/avaliar ', glyph: 'diagnostics' },
    ],
    tools: ['fs.read', 'fs.write', 'finetune.submit', 'finetune.status', 'runtime.status'],
    triggers: ['fine-tun', 'finetun', 'treino', 'treinar', 'dataset', 'lora', 'epoch', 'hiperparam', 'avaliacao do modelo', 'checkpoint', 'quantiz', 'adapter'],
    preferredSkills: ['chat', 'reasoning'],
    avatar: { seed: 111, shape: 'bloom', eyes: 'spark', mouth: 'wave', accessory: 'bolt', motion: 'pulse', hue: 96, saturation: 62 },
  }),
]
