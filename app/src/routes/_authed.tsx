import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQueryOptions } from "../lib/auth/queries";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
  },
  // [Onda 2] O CopilotProvider saiu do shell: a conversa fala o NOSSO
  // protocolo WS (lib/chat) e não há runtime /api/copilotkit para o provider
  // apontar — montá-lo abriria uma conexão condenada em todo render. As
  // superfícies de tools/gallery que dependiam dele estão atrás de stub com
  // prazo final na onda 3 (ver admin/playground.tsx).
  component: () => <Outlet />,
});
