import { useEffect, useState } from "react";
import { readControl } from "./take-the-wheel";

/**
 * Poll closed screens for control/secret prompts so blocked Bots can surface outside the screen.
 *
 * [Onda 4 — cirurgia §3] Este poll é a PRESENÇA do estado observável da execução
 * (o Take the Wheel pedindo ajuda), lida do runtime — não de um Chromium
 * permanente por bot. O `runtimeId` aqui é a sessão da execução; alimentá-lo a
 * partir do runtime-snapshots (em vez do agentId do bot) é a costura de presença
 * que a onda 7 fecha junto com a paridade da UI. Enquanto isso, um id que não
 * casa com nenhuma execução viva simplesmente devolve "não precisa" — o poll
 * degrada em silêncio, nunca inventa um cartão.
 */

const INTERVAL_MS = 3_000;

export function useNeedsYou(runtimeId: string | undefined, when: boolean): boolean {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (!runtimeId || !when) {
      setNeeded(false);
      return;
    }

    let live = true;
    const check = async () => {
      const state = await readControl(runtimeId).catch(() => null);
      if (!live) return;
      setNeeded(
        Boolean(state && (state.requested || state.secretWanted !== undefined)),
      );
    };

    void check();
    const timer = setInterval(() => void check(), INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [runtimeId, when]);

  return needed;
}
