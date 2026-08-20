/**
 * [Onda 1 — §4.6] O cartaz que ocupa o lugar das superfícies de chat enquanto
 * a flag está desligada (ver lib/flags.ts). Diz a verdade em vez de renderizar
 * um chat que falharia: o runtime do chat desta onda não sobe.
 */
export function ChatDesligado({ surface }: { surface: string }) {
  return (
    <div className="flex h-full min-h-[50vh] w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h2 className="text-lg font-semibold">O chat está desligado nesta onda</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {surface} depende do runtime de conversa, que só religa na onda 2 —
        servido pelo nosso event log, não por SaaS. O shell, a administração e
        os agentes continuam funcionando.
      </p>
    </div>
  );
}
