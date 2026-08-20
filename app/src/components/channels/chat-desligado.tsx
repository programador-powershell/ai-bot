/**
 * [Onda 2] O cartaz das superfícies que continuam desligadas. O CHAT em si
 * religou nesta onda — servido pelo nosso event log, não por SaaS —, então
 * quem ainda renderiza isto é (a) a flag VITE_CHAT_ENABLED=false explícita ou
 * (b) a superfície presa ao renderer do CopilotKit (o playground), cujo prazo
 * final é a onda 3. Diz a verdade em vez de renderizar algo que falharia.
 */
export function ChatDesligado({ surface }: { surface: string }) {
  return (
    <div className="flex h-full min-h-[50vh] w-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h2 className="text-lg font-semibold">Esta superfície está desligada</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {surface} ainda depende do renderer do CopilotKit, que ficou sem
        runtime quando a conversa passou a ser o nosso event log (onda 2). O
        prazo final desta pendência é a onda 3. O chat, os canais, a
        administração e os agentes continuam funcionando.
      </p>
    </div>
  );
}
