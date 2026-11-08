import { useEffect, useState } from 'react';
import { api } from '../api';
import { date, money } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

/** Faturas que o licenciado paga à OnDaqui (licença mensal + taxa por corrida) */
export default function Invoices({ onStatusChange }: { onStatusChange: () => void }) {
  const list = useLoad(() => api('/admin/invoices'));
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const d = list.data;
  const open = (d?.invoices ?? []).filter((i: any) => i.status === 'open');

  // ao voltar do Mercado Pago (ou abrir a página), confere os pagamentos das faturas em aberto
  useEffect(() => {
    if (!open.length) return;
    let alive = true;
    setChecking(true);
    Promise.all(open.map((i: any) => api(`/admin/invoices/${i.id}/sync`, { method: 'POST', body: {} }).catch(() => null)))
      .then((r) => {
        if (!alive) return;
        if (r.some((x: any) => x?.status === 'paid')) { list.reload(); onStatusChange(); }
      })
      .finally(() => alive && setChecking(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.invoices?.length]);

  const suspended = d && !d.tenant.active;

  return (
    <>
      <div className="topo">
        <div>
          <h1>Faturas</h1>
          <p>Licença mensal da OnDaqui e taxa por corrida finalizada. Vencimento todo dia 10.</p>
        </div>
      </div>
      <Erro msg={list.error ?? error} />

      {suspended && (
        <div className="aviso erro" role="alert">
          <strong>Cidade suspensa{d.tenant.suspendedReason === 'inadimplencia' ? ' por fatura em atraso' : ''}.</strong>{' '}
          Motoristas e passageiros não conseguem usar o app.
          {d.tenant.suspendedReason === 'inadimplencia'
            ? ' Assim que o pagamento for confirmado, tudo volta a funcionar sozinho.'
            : ' Fale com a OnDaqui para reativar.'}
        </div>
      )}

      {d && (
        <section className="cartao grade-kpi">
          <div className="kpi">
            <span className="rotulo">Este mês até agora ({d.current.label})</span>
            <span className="valor">{money(d.current.totalCents)}</span>
            <span className="nota">Fecha no dia 1º e vence no dia 10 do mês seguinte</span>
          </div>
          <div className="kpi">
            <span className="rotulo">Licença</span>
            <span className="valor">{money(d.current.licenseCents)}</span>
            <span className="nota">{money(d.tenant.licenseMonthlyCents)} por mês, proporcional no 1º mês</span>
          </div>
          <div className="kpi">
            <span className="rotulo">Taxa por corrida</span>
            <span className="valor">{money(d.current.rideFeeCents)}</span>
            <span className="nota">{d.current.ridesCount} corridas × {money(d.tenant.feePerRideCents)}</span>
          </div>
        </section>
      )}

      <section className="cartao">
        <h2>Histórico</h2>
        {checking && <p style={{ color: 'var(--texto-2)' }}>Conferindo pagamentos no Mercado Pago…</p>}
        {d && d.invoices.length === 0 && <p className="vazio">Nenhuma fatura fechada ainda.</p>}
        {d && d.invoices.length > 0 && (
          <div className="tabela">
            <table>
              <thead>
                <tr><th>Mês</th><th className="num">Licença</th><th className="num">Corridas</th><th className="num">Taxa</th><th className="num">Total</th><th>Vencimento</th><th>Situação</th><th></th></tr>
              </thead>
              <tbody>
                {d.invoices.map((i: any) => (
                  <tr key={i.id}>
                    <td>{i.label}</td>
                    <td className="num">{money(i.license_cents)}</td>
                    <td className="num">{i.rides_count}</td>
                    <td className="num">{money(i.ride_fee_cents)}</td>
                    <td className="num"><strong>{money(i.total_cents)}</strong></td>
                    <td>{date(i.due_date)}</td>
                    <td>
                      {i.status === 'paid' ? <Status tone="ok">Paga em {date(i.paid_at)}</Status>
                        : i.status === 'cancelled' ? <Status tone="neutra">Cancelada</Status>
                        : i.overdue ? <Status tone="ruim">Em atraso</Status>
                        : <Status tone="alerta">Em aberto</Status>}
                    </td>
                    <td>
                      {i.status === 'open' && d.onlinePayment && (
                        <PayButton invoiceId={i.id} onError={setError} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && open.length > 0 && !d.onlinePayment && (
          <p style={{ color: 'var(--texto-2)', marginTop: 12 }}>O pagamento online ainda não está ativo. Fale com a OnDaqui para receber o Pix da fatura.</p>
        )}
        {d && open.length > 0 && d.suspendAfterDays > 0 && (
          <p style={{ color: 'var(--texto-2)', marginTop: 12, fontSize: 14 }}>
            Pix é confirmado na hora. Faturas com mais de {d.suspendAfterDays} dias de atraso suspendem a cidade automaticamente.
          </p>
        )}
      </section>
    </>
  );
}

/** Botão do Checkout Pro: cria a preferência no servidor e leva para o init_point do Mercado Pago */
function PayButton({ invoiceId, onError }: { invoiceId: string; onError: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false);

  async function payInvoice() {
    onError(null);
    setBusy(true);
    try {
      const preference = await api<{ init_point: string }>(`/admin/invoices/${invoiceId}/checkout`, { method: 'POST', body: {} });
      window.location.href = preference.init_point; // Pix, cartão ou boleto no Mercado Pago
    } catch (e) {
      onError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <button type="button" className="destaque" style={{ whiteSpace: 'nowrap' }} data-mp-checkout-cta="checkout-pro" disabled={busy} aria-busy={busy} onClick={payInvoice}>
      Pagar com Mercado Pago
    </button>
  );
}
