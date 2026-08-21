/**
 * @aibot2/provider-puter — o backend PUTER do WorkspaceManager (materializa
 * Puter→disco, promove disco→Puter em duas camadas com a exclusão do
 * descartável) e o cliente HTTP da conta real (pendência declarada; fetch
 * próprio, sem SDK). A cerca (worker+época) fica no gerente e não muda aqui.
 */

export {
  PUTER_PROVIDER,
  PuterWorkspaceBackend,
  type PuterWorkspaceBackendOptions,
} from './backend.js'

export { HttpPuterFs, type PuterHttpOptions } from './http.js'
