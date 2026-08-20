import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentUserQueryOptions } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { chatEnabled } from "../lib/flags";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  //
  // [Onda 1 — §4.6] Com o chat desligado (lib/flags.ts) o provider do
  // CopilotKit NEM MONTA: o endpoint /api/copilotkit não existe neste boot e
  // um provider apontando para ele abriria uma conexão condenada em todo
  // render do shell. O shell autenticado renderiza sem ele.
  component: () =>
    chatEnabled ? (
      <CopilotProvider>
        <Outlet />
      </CopilotProvider>
    ) : (
      <Outlet />
    ),
});
