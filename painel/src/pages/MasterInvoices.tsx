import { useState } from 'react';
import { api } from '../api';
import { date, money } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

type Filter = 'open' | 'paid' | 'all';

/** Master: faturas de todos os licenciados */
export default function MasterInvoices() {
  const [filter, setFilter] = useState<Filter>('open');
  const list = useLoad(() => api(`/master/invoices${filter === 'all' ? '' : `?status=${filter}`}`), [filter]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = list.data;

  async function act(fn: () => Promise<any>, ok: (r: any) => string) {
    setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: ok(r) }); list.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }

  const markPaid = (i: any) => {
    if (!window.confirm(`Dar baixa manual na fatura de ${i.tenant_name} (${money(i.total_cents)})?`)) return;
    act(() => api(`/master/invoices/${i.id}/mark-paid`, { method: 'POST', body: {} }),
      (r) => `Fatura marcada como paga${r.reactivated ? ' e cidade reativada' : ''}.`);
  };
  const cancel = (i: any) => {
    if (!window.confirm(`Cancelar a fatura de ${i.tenant_name}? Ela deixa de ser cobrada.`)) return;
    act(() => api(`/master/invoices/${i.id}/cancel`, { method: 'POST', body: {} }), () => 'Fatura cancelada.');
  };
  const generate = () => act(() => api('/master/invoices/generate', { method: 'POST', body: {} }),
    (r) => (r.created ? `${r.created} fatura(s) do mês passado gerada(s).` : 'Nenhuma fatura nova: o mês passado já está fechado.'));

  return (
    <>
      <div className="topo">
        <div>
          <h1>Faturas</h1>
          <p>Geradas sozinhas no dia 1º de cada mês. Pix e cartão pelo Mercado Pago são confirmados automaticamente.</p>
        </div>
        <button className="secundario" onClick={generate}>Fechar mês passado agora</button>
      </div>
      <Erro msg={list.error} />
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}
      {d && !d.onlinePayment && (
        <div className="aviso erro" role="status">Pagamento online desligado: configure MP_ACCESS_TOKEN no servidor (veja DEPLOY.md).</div>
      )}

      {d && (
        <section className="cartao grade-kpi">
          <div className="kpi"><span className="rotulo">Em aberto</span><span className="valor">{money(d.totals.open_cents)}</span></div>
          <div className="kpi"><span className="rotulo">Em atraso</span><span className="valor">{money(d.totals.overdue_cents)}</span></div>
          <div className="kpi"><span className="rotulo">Recebido este mês</span><span className="valor">{money(d.totals.paid_month_cents)}</span></div>
        </section>
      )}

      <section className="cartao">
        <div className="filtros" role="group" aria-label="Filtrar faturas" style={{ marginBottom: 14 }}>
          {([['open', 'Em aberto'], ['paid', 'Pagas'], ['all', 'Todas']] as const).map(([k, l]) => (
            <button key={k} className={filter === k ? 'ativo' : ''} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {d && d.invoices.length === 0 && <p className="vazio">Nenhuma fatura aqui.</p>}
        {d && d.invoices.length > 0 && (
          <div className="tabela">
            <table>
              <thead>
                <tr><th>Licenciado</th><th>Mês</th><th className="num">Corridas</th><th className="num">Total</th><th>Vencimento</th><th>Situação</th><th></th></tr>
              </thead>
              <tbody>
                {d.invoices.map((i: any) => (
                  <tr key={i.id}>
                    <td><strong>{i.tenant_name}</strong>{!i.tenant_active && <><br /><Status tone="ruim">Cidade suspensa</Status></>}</td>
                    <td>{i.label}</td>
                    <td className="num">{i.rides_count}</td>
                    <td className="num"><strong>{money(i.total_cents)}</strong></td>
                    <td>{date(i.due_date)}</td>
                    <td>
                      {i.status === 'paid' ? <Status tone="ok">Paga ({i.paid_by === 'manual' ? 'baixa manual' : 'Mercado Pago'})</Status>
                        : i.status === 'cancelled' ? <Status tone="neutra">Cancelada</Status>
                        : i.overdue ? <Status tone="ruim">Em atraso</Status>
                        : <Status tone="alerta">Em aberto</Status>}
                    </td>
                    <td>
                      {i.status === 'open' && (
                        <span className="acoes">
                          <button className="secundario" onClick={() => markPaid(i)}>Dar baixa</button>
                          <button className="perigo" onClick={() => cancel(i)}>Cancelar</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
