import { useEffect, useState } from "react";
import {
  PRAZO_DA_APROVACAO_MS,
  type AprovacaoPendente,
} from "@/lib/chat/protocolo";

/**
 * [Onda 3] O cartão de aprovação — a decisão humana do funil, desenhada do
 * REPLAY do log: approval.request sem decisão e sem desfecho é um cartão, e
 * por ser projeção do log durável ele RENASCE depois de um reinício do server.
 *
 * O PRAZO conta do `ts` ORIGINAL do pedido (o servidor recusa por timeout no
 * mesmo relógio): um cartão que renasceu não ganha dez minutos novos — ele
 * mostra o que restava. Prazo esgotado desenha o cartão como vencido e
 * desabilita os botões: o tool.result de recusa do servidor o fecha em
 * seguida pelo próprio replay.
 *
 * As três respostas espelham os escopos do Gate: "Aprovar" vale para ESTA
 * chamada (once), "Sempre assim" prende ao par ferramenta+argumentos (digest
 * — nunca cheque em branco por nome), "Recusar" recusa.
 */
export function ApprovalCard({
  aprovacao,
  disabled = false,
  onDecide,
}: {
  aprovacao: AprovacaoPendente;
  /** Sem conexão não há para onde mandar a decisão — os botões dizem isso. */
  disabled?: boolean;
  onDecide: (allow: boolean, scope?: "once" | "digest") => void;
}) {
  const [restanteMs, setRestanteMs] = useState(() => restanteDe(aprovacao.ts));

  useEffect(() => {
    // Um relógio por cartão, morto no unmount — o vazamento clássico daqui.
    const relogio = setInterval(() => {
      setRestanteMs(restanteDe(aprovacao.ts));
    }, 1000);
    return () => clearInterval(relogio);
  }, [aprovacao.ts]);

  const vencido = restanteMs <= 0;
  const inativo = disabled || vencido;

  return (
    <div
      className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
      data-testid="approval-card"
      role="group"
      aria-label={`Aprovação pendente: ${aprovacao.tool}`}
    >
      <p className="font-medium">
        {aprovacao.summary?.trim() || `O bot quer usar ${aprovacao.tool}`}
        {aprovacao.risk ? (
          <span className="ml-2 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-xs">
            {aprovacao.risk}
          </span>
        ) : null}
      </p>
      {aprovacao.detail ? (
        // O detalhe é o argumento CRU (truncado pelo servidor): quem aprova
        // precisa ver o que está aprovando, não um rótulo que o modelo mandou.
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-foreground/5 px-2 py-1 font-mono text-xs text-muted-foreground">
          {aprovacao.detail}
        </pre>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <button
          className="rounded bg-foreground px-2 py-1 text-xs font-medium text-background disabled:opacity-50"
          disabled={inativo}
          onClick={() => onDecide(true, "once")}
          type="button"
        >
          Aprovar
        </button>
        <button
          className="rounded border border-foreground/30 px-2 py-1 text-xs disabled:opacity-50"
          disabled={inativo}
          onClick={() => onDecide(true, "digest")}
          type="button"
        >
          Sempre assim
        </button>
        <button
          className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive disabled:opacity-50"
          disabled={inativo}
          onClick={() => onDecide(false)}
          type="button"
        >
          Recusar
        </button>
        {/* role=status: é progresso do prazo, não um alerta que interrompe. */}
        <span className="ml-auto text-xs text-muted-foreground" role="status">
          {vencido
            ? "Prazo esgotado — recusado por segurança."
            : `Expira em ${formataRestante(restanteMs)}.`}
        </span>
      </div>
    </div>
  );
}

/** O que resta do prazo, SEMPRE a partir do ts original do pedido. */
function restanteDe(ts: string): number {
  const inicio = Date.parse(ts);
  if (Number.isNaN(inicio)) return 0;
  return inicio + PRAZO_DA_APROVACAO_MS - Date.now();
}

function formataRestante(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutos = Math.floor(total / 60);
  const segundos = total % 60;
  return minutos > 0 ? `${minutos}m ${segundos}s` : `${segundos}s`;
}
