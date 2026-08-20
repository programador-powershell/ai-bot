/**
 * [Onda 3] O cartão de aprovação da UI forkada — o pedaço visível do aceite
 * "aprovação pendente sobrevive a reinício e REAPARECE": o cartão é desenhado
 * de um AprovacaoPendente projetado do replay, e o prazo é calculado do ts
 * ORIGINAL do pedido (um cartão renascido mostra o que restava, e um pedido
 * vencido durante a queda nasce desabilitado).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "@/components/channels/approval-card";
import type { AprovacaoPendente } from "@/lib/chat/protocolo";

afterEach(cleanup);

function aprovacao(ts: string): AprovacaoPendente {
  return {
    callId: "c-1",
    tool: "fs.write",
    ts,
    risk: "write",
    summary: "fs.write: deploy/ci.yml",
    detail: '{"path":"deploy/ci.yml"}',
  };
}

describe("ApprovalCard", () => {
  it("desenha o resumo resolvido pelo servidor e os três destinos de decisão", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard aprovacao={aprovacao(new Date().toISOString())} onDecide={onDecide} />,
    );

    expect(screen.getByText("fs.write: deploy/ci.yml")).toBeTruthy();
    // O detalhe CRU está visível: quem aprova vê o que está aprovando.
    expect(screen.getByText('{"path":"deploy/ci.yml"}')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Aprovar" }));
    expect(onDecide).toHaveBeenCalledWith(true, "once");

    fireEvent.click(screen.getByRole("button", { name: "Sempre assim" }));
    // "Sempre" é o escopo DIGEST (ferramenta+argumentos), nunca cheque em branco.
    expect(onDecide).toHaveBeenCalledWith(true, "digest");

    fireEvent.click(screen.getByRole("button", { name: "Recusar" }));
    expect(onDecide).toHaveBeenCalledWith(false);
  });

  it("um pedido cujo prazo venceu durante a queda nasce vencido — botões desabilitados", () => {
    const onDecide = vi.fn();
    // Um ts de 11 minutos atrás: além do prazo de 10 min do servidor.
    const vencido = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    render(<ApprovalCard aprovacao={aprovacao(vencido)} onDecide={onDecide} />);

    expect(screen.getByText(/Prazo esgotado/)).toBeTruthy();
    const botao = screen.getByRole("button", { name: "Aprovar" }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    fireEvent.click(botao);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("sem conexão os botões dizem que não há para onde mandar a decisão", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        aprovacao={aprovacao(new Date().toISOString())}
        disabled
        onDecide={onDecide}
      />,
    );
    const botao = screen.getByRole("button", { name: "Recusar" }) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
  });
});
