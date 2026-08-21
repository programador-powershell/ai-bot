/**
 * O contrato de filesystem do Puter que ESTE repositório usa — o MENOR
 * subconjunto que a árvore §23 e o backend do workspace precisam. Não é o SDK
 * do Puter: é a nossa superfície, para escolher a implementação (fetch próprio
 * ou, um dia, o SDK) sem espalhar a dependência pelo código — o mesmo caminho
 * que tomamos com o gateway (cliente HTTP stdlib, superfície mínima de
 * homologação).
 *
 * Só operações de PASTA e ARQUIVO: mkdir, escrever, ler, listar, existir. Nada
 * de rename/lock/permissão — o que a Onda 6 não exerce não entra no contrato.
 */

/** Uma entrada de diretório: nome (sem caminho) e se é pasta. */
export interface PuterEntry {
  name: string
  isDirectory: boolean
}

/**
 * O filesystem do Puter visto por este código. Caminhos são ABSOLUTOS a partir
 * da raiz da conta (`/Bots`, `/Goals`, `/Shared`) — a conta É o namespace (1
 * conta = 1 pessoa), então não há usuário no caminho.
 */
export interface PuterFs {
  /** Cria a pasta e os pais que faltarem. Idempotente: pasta que já existe é ok. */
  mkdir(path: string): Promise<void>
  /** Escreve o arquivo, criando as pastas-pai. Sobrescreve se já existir. */
  writeFile(path: string, data: Uint8Array): Promise<void>
  /** Lê o arquivo. Lança se não existir (não devolve vazio silencioso). */
  readFile(path: string): Promise<Uint8Array>
  /** Lista os filhos imediatos da pasta. Lança se a pasta não existir. */
  readdir(path: string): Promise<PuterEntry[]>
  /** Existe algo (arquivo OU pasta) nesse caminho? */
  exists(path: string): Promise<boolean>
}
