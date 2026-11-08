import { useState } from 'react';
import { api } from '../api';
import { dateTime, money, phone as fmtPhone } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

const day = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
const short = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

const FILTERS = [['open', 'Em aberto'], ['paid', 'Pagas'], ['cancelled', 'Canceladas'], ['all', 'Todas']] as const;

/** Licenciado: comissão do plano Livre nas corridas que os passageiros pagaram direto aos motoristas */
export default function Commissions() {
  const [status, setStatus] = useState<(typeof FILTERS)[number][0]>('open');
  const list = useLoad(() => api(`/admin/commissions?status=${status}`), [status]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const t = list.data?.totals;

  async function act(inv: any, kind: 'mark-paid' | 'cancel') {
    let note: string | null = null;
    if (kind === 'cancel') {
      note = window.prompt(`Motivo para cancelar a comissão de ${inv.driver_name} (${money(inv.amount_cents)}):`);
      if (!note) return;
    }
    setBusy(inv.id);
    setMsg(null);
    try {
      await api(`/admin/commissions/${inv.id}/${kind}`, { method: 'POST', body: note ? { note } : {} });
      setMsg({ ok: true, text: kind === 'cancel' ? 'Comissão cancelada.' : `Pagamento de ${inv.driver_name} registrado.` });
      list.reload();
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Comissões dos motoristas</h1>
          <p>
            No plano Livre, quando o passageiro paga em dinheiro, Pix ou maquininha, o motorista recebe tudo e a comissão fecha
            toda segunda-feira, com 3 dias para pagar pelo app. Vencida, ele não recebe corridas até pagar.
            Nas corridas da Prefeitura e das lojas, a comissão já sai do repasse.
          </p>
        </div>
      </div>
      <Erro msg={list.error} />
      {t && (
        <section className="grade-kpi">
          <div className="cartao kpi"><span className="rotulo">Em aberto</span><span className="valor">{money(t.open_cents)}</span></div>
          <div className="cartao kpi"><span className="rotulo">Vencidas</span><span className="valor" style={{ color: t.overdue_cents > 0 ? 'var(--vermelho)' : undefined }}>{money(t.overdue_cents)}</span></div>
          <div className="cartao kpi"><span className="rotulo">Recebidas no mês</span><span className="valor">{money(t.paid_month_cents)}</span></div>
          <div className="cartao kpi"><span className="rotulo">Semana atual</span><span className="valor">{money(t.week_cents)}</span><span className="nota">fecha na segunda-feira</span></div>
        </section>
      )}
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}
      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="filtros" role="group" aria-label="Situação">
          {FILTERS.map(([k, l]) => <button key={k} className={status === k ? 'ativo' : ''} onClick={() => setStatus(k)}>{l}</button>)}
        </div>
        {list.data && list.data.invoices.length === 0 && <p className="vazio">Nenhuma comissão {status === 'open' ? 'em aberto' : 'aqui'}.</p>}
        {list.data?.invoices.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Motorista</th><th>Semana</th><th className="num">Corridas</th><th className="num">Recebido pelo motorista</th><th className="num">Comissão</th><th>Situação</th><th></th></tr></thead>
              <tbody>
                {list.data.invoices.map((i: any) => (
                  <tr key={i.id}>
                    <td><strong>{i.driver_name}</strong><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{fmtPhone(i.driver_phone)}{i.vehicle_plate ? ` · ${i.vehicle_plate}` : ''}</span></td>
                    <td>{short(i.period_start)} a {short(i.period_end)}</td>
                    <td className="num">{i.rides}</td>
                    <td className="num">{money(i.gross_cents)}</td>
                    <td className="num"><strong>{money(i.amount_cents)}</strong>
                      {i.cashback_offset_cents > 0 && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>− {money(i.cashback_offset_cents)} de cashback</span></>}</td>
                    <td>
                      {i.status === 'open' && (i.overdue
                        ? <Status tone="ruim">Vencida em {day(i.due_date)}</Status>
                        : <Status tone="alerta">Vence em {day(i.due_date)}</Status>)}
                      {i.status === 'paid' && <Status tone="ok">{i.paid_by === 'central' ? 'Paga na central' : i.paid_by === 'cashback' ? 'Abatida com cashback' : 'Paga pelo app'}</Status>}
                      {i.status === 'cancelled' && <Status tone="neutra">Cancelada</Status>}
                      {(i.paid_at || i.note) && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{i.paid_at ? dateTime(i.paid_at) : ''}{i.note ? ` · ${i.note}` : ''}</span></>}
                    </td>
                    <td>
                      {i.status === 'open' && (
                        <div className="acoes">
                          <button className="secundario" disabled={busy === i.id} onClick={() => act(i, 'mark-paid')}>Recebi</button>
                          <button className="secundario" disabled={busy === i.id} onClick={() => act(i, 'cancel')}>Cancelar</button>
                        </div>
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
