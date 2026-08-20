/**
 * Computer control API helpers and screenshot-to-page coordinate conversion.
 *
 * [Onda 4 — cirurgia §3] O `computerId` que estes helpers usam É AGORA O
 * runtimeId da EXECUÇÃO (a sessão de browser task-scoped), nunca um botId de
 * computador permanente. O servidor expõe o volante em
 * `/api/computers/:runtimeId/control*` e a lista de execuções vivas em
 * `GET /api/computers` (a presença observável — o que substitui o screencast do
 * Chromium permanente). A entrada por PIXEL e por SEGREDO (supplySecret/
 * sendHumanInput/pageCoordinates) pertence ao console humano com screencast, que
 * é PENDÊNCIA declarada da onda 7 (o agent-computer não expõe frames nesta leva);
 * ficam aqui prontas para quando o console entrar, sem rota viva ainda.
 */

export type ControlState = {
  holder: "bot" | "human";
  since: string;
  reason?: string;
  requested: boolean;
  /** What the Bot is waiting for, by name only. Present means show the masked prompt. */
  secretWanted?: string;
};

async function callControl(
  computerId: string,
  path: string,
  init?: RequestInit,
): Promise<ControlState | null> {
  const response = await fetch(`/api/computers/${computerId}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!response.ok) return null;
  return (await response.json()) as ControlState;
}

export function readControl(computerId: string) {
  return callControl(computerId, "/control");
}

export function takeControl(computerId: string) {
  return callControl(computerId, "/control/take", { method: "POST" });
}

export function releaseControl(computerId: string) {
  return callControl(computerId, "/control/release", { method: "POST" });
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 */
export async function supplySecret(
  computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`/api/computers/${computerId}/human/secret`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: body?.error ?? "That could not be entered." };
  } catch {
    return {
      ok: false,
      error: "The assistant's computer could not be reached.",
    };
  }
}

/**
 * Serializes human input requests without blocking the caller; ordering matters for typed secrets.
 */
let inputQueue: Promise<unknown> = Promise.resolve();

/**
 * Send one human input event. Returns immediately; delivery is ordered.
 */
export function sendHumanInput(
  computerId: string,
  kind: "click" | "type" | "key" | "scroll",
  body: Record<string, unknown>,
): void {
  inputQueue = inputQueue
    .then(() =>
      fetch(`/api/computers/${computerId}/human/${kind}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    // Fire-and-forget: the user can see/retry input failures, while the input queue must keep moving.
    .catch(() => undefined);
}

/**
 * Convert display coordinates on a scaled screenshot into browser viewport coordinates.
 */
export function pageCoordinates(
  image: { naturalWidth: number; naturalHeight: number },
  rect: { left: number; top: number; width: number; height: number },
  event: { clientX: number; clientY: number },
): { x: number; y: number } | null {
  if (!rect.width || !rect.height) return null;
  if (!image.naturalWidth || !image.naturalHeight) return null;

  const withinX = event.clientX - rect.left;
  const withinY = event.clientY - rect.top;

  return {
    x: Math.round((withinX / rect.width) * image.naturalWidth),
    y: Math.round((withinY / rect.height) * image.naturalHeight),
  };
}
