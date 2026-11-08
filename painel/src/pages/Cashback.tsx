import { useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime, money, phone as fmtPhone } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

const short = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');

/**
 * Licenciado: cashback da cidade. Ele define a % que devolve em cada corrida, os tetos e a validade;
 * vê quanto as lojas estão dando; e acerta com os motoristas o cashback usado nas corridas deles.
 */
export default function Cashback() {
  const c = useLoad(() => api('/admin/cashback'));
  const [f, setF] = useState({ pct: '', maxRide: '', maxMonth: '', days: '', usePct: '' });
  const [adj, setAdj] = useState({ phone: '', amount: '', note: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const r = c.data?.rules;
    if (r) setF({ pct: String(r.pct).replace('.', ','), maxRide: reais(r.maxRideCents), maxMonth: reais(r.maxMonthCents), days: String(r.days), usePct: String(r.usePct) });
  }, [c.data]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); c.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
    finally { setBusy(null); }
  }

  const save = () => run('regras', () => api('/admin/cashback', {
    method: 'PATCH',
    body: {
      pct: Number(f.pct.replace(',', '.')) || 0, maxRideCents: toCents(f.maxRide), maxMonthCents: toCents(f.maxMonth),
      days: Number(f.days), usePct: Number(f.usePct),
    },
  }), Number(f.pct.replace(',', '.')) > 0 ? 'Regras salvas. Valem para as próximas corridas.' : 'Cashback da central desligado. O saldo que os passageiros já têm continua valendo.');

  const s = c.data?.summary;
  const r = c.data?.rules;
  const pctNum = Number(f.pct.replace(',', '.')) || 0;
  const open = (c.data?.payouts ?? []).filter((p: any) => p.status === 'open');
  const closed = (c.data?.payouts ?? []).filter((p: any) => p.status !== 'open').slice(0, 20);

  return (
    <>
      <div className="topo">
        <div>
          <h1>Cashback</h1>
          <p>
            O passageiro ganha crédito para as próximas corridas: uma % de cada corrida, paga pela central, e um presente das lojas
            parceiras quando elas entregam um pedido. Ao pedir, ele usa o saldo e paga menos ao motorista. O motorista recebe o valor
            cheio: toda segunda-feira a diferença é abatida da comissão dele, e o que sobrar a central paga por Pix.
          </p>
        </div>
      </div>
      <Erro msg={c.error} />
      {s && (
        <section className="grade-kpi">
          <div className="cartao kpi"><span className="rotulo">Dado pela central no mês</span><span className="valor">{money(s.from_rides_month + s.courtesy_month)}</span></div>
          <div className="cartao kpi"><span className="rotulo">Dado pelas lojas no mês</span><span className="valor">{money(s.from_stores_month)}</span></div>
          <div className="cartao kpi"><span className="rotulo">Usado no mês</span><span className="valor">{money(s.used_month)}</span><span className="nota">{s.passengers_used_month} passageiros</span></div>
          <div className="cartao kpi"><span className="rotulo">Saldo dos passageiros</span><span className="valor">{money(s.balances)}</span>
            <span className="nota">{s.waiting_signup > 0 ? `+ ${money(s.waiting_signup)} esperando cadastro` : `${money(s.expired_month)} venceram no mês`}</span></div>
          <div className="cartao kpi"><span className="rotulo">A pagar aos motoristas</span><span className="valor" style={{ color: s.open_cents > 0 ? 'var(--vermelho)' : undefined }}>{money(s.open_cents)}</span>
            <span className="nota">{money(s.week_cents)} na semana atual</span></div>
        </section>
      )}
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}

      {r && (
        <section className="cartao">
          <h2>Cashback da central {r.enabled ? <Status tone="ok">Ligado</Status> : <Status tone="neutra">Desligado</Status>}</h2>
          <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
            Quanto a central devolve ao passageiro em cada corrida concluída. Sai da sua margem: comece baixo (3% a 5%) e use os
            tetos para controlar o custo. Corridas pagas por loja ou pela Prefeitura não geram cashback.
          </p>
          <div className="formulario">
            <label>Devolver por corrida (%)
              <input inputMode="decimal" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} placeholder="0 = desligado" />
            </label>
            <label>Teto por corrida (R$)
              <input inputMode="decimal" value={f.maxRide} onChange={(e) => setF({ ...f, maxRide: e.target.value })} />
            </label>
            <label>Teto por passageiro no mês (R$)
              <input inputMode="decimal" value={f.maxMonth} onChange={(e) => setF({ ...f, maxMonth: e.target.value })} />
            </label>
            <label>Validade de cada crédito (dias)
              <input inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
            </label>
            <label>Usar até (% de cada corrida)
              <input inputMode="numeric" value={f.usePct} onChange={(e) => setF({ ...f, usePct: e.target.value })} />
            </label>
            <button disabled={busy === 'regras'} onClick={save}>Salvar</button>
          </div>
          {pctNum > 0 && (
            <p style={{ color: 'var(--texto-2)', margin: '12px 0 0', fontSize: 14 }}>
              Exemplo: numa corrida de R$ 20,00 o passageiro ganha {money(Math.min(Math.floor(2000 * pctNum / 100), toCents(f.maxRide) || 0))}.
              A validade vale também para o cashback das lojas.
            </p>
          )}
        </section>
      )}

      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Acerto com os motoristas</h2>
        <p style={{ margin: 0, color: 'var(--texto-2)' }}>
          Toda segunda-feira o cashback usado e o desconto do Clube nas corridas da semana anterior são abatidos da comissão do motorista (plano Livre).
          O que sobrar, e todo o valor dos motoristas de plano mensal, a central paga no Pix do motorista e dá baixa aqui.
        </p>
        {open.length === 0 && <p className="vazio">Nada a pagar agora.</p>}
        {open.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Motorista</th><th>Semana</th><th className="num">Corridas</th><th className="num">Cashback e Clube</th><th className="num">Abatido</th><th className="num">Pagar</th><th>Pix</th><th></th></tr></thead>
              <tbody>
                {open.map((p: any) => (
                  <tr key={p.id}>
                    <td><strong>{p.driver_name}</strong><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{fmtPhone(p.driver_phone)}{p.vehicle_plate ? ` · ${p.vehicle_plate}` : ''}</span></td>
                    <td>{short(p.period_start)} a {short(p.period_end)}</td>
                    <td className="num">{p.rides}</td>
                    <td className="num">{money(p.cashback_cents)}</td>
                    <td className="num">{p.offset_cents > 0 ? money(p.offset_cents) : '—'}</td>
                    <td className="num"><strong>{money(p.amount_cents)}</strong></td>
                    <td>{p.pix_key ? <>{p.pix_key}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{p.pix_holder_name}{p.pix_validated ? '' : ' · não conferido'}</span></> : <Status tone="alerta">Sem Pix</Status>}</td>
                    <td><button className="secundario" disabled={busy === p.id}
                      onClick={() => run(p.id, () => api(`/admin/cashback/payouts/${p.id}/mark-paid`, { method: 'POST', body: {} }), `Pagamento de ${p.driver_name} registrado.`)}>Paguei</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {closed.length > 0 && (
          <details>
            <summary>Semanas fechadas</summary>
            <div className="tabela" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Motorista</th><th>Semana</th><th className="num">Cashback usado</th><th className="num">Abatido</th><th className="num">Pago</th><th>Situação</th></tr></thead>
                <tbody>
                  {closed.map((p: any) => (
                    <tr key={p.id}>
                      <td>{p.driver_name}</td>
                      <td>{short(p.period_start)} a {short(p.period_end)}</td>
                      <td className="num">{money(p.cashback_cents)}</td>
                      <td className="num">{money(p.offset_cents)}</td>
                      <td className="num">{money(p.amount_cents)}</td>
                      <td>{p.status === 'abatido' ? <Status tone="ok">Abatido da comissão</Status> : <Status tone="ok">Pago {p.paid_at ? dateTime(p.paid_at) : ''}</Status>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>

      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Lojas que dão cashback</h2>
        <p style={{ margin: 0, color: 'var(--texto-2)' }}>
          Cada loja escolhe no painel dela quanto dá ao cliente por pedido entregue. Sai do saldo da loja (ou entra na fatura da
          semana). Quem ainda não tem o app recebe um SMS e o crédito entra na conta quando ele se cadastra com o mesmo celular.
        </p>
        {c.data?.stores.length === 0 && <p className="vazio">Nenhuma loja oferecendo cashback ainda. Vale sugerir às lojas: traz o cliente de volta e custa menos que um desconto.</p>}
        {c.data?.stores.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Loja</th><th className="num">Por pedido</th><th className="num">Pedidos no mês</th><th className="num">Dado no mês</th></tr></thead>
              <tbody>
                {c.data.stores.map((x: any) => (
                  <tr key={x.id}><td>{x.name}</td><td className="num">{money(x.cashback_per_order_cents)}</td><td className="num">{x.orders_month}</td><td className="num">{money(x.given_month)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="cartao">
        <h2>Crédito de cortesia</h2>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
          Para compensar uma reclamação ou corrigir um erro. Valor negativo tira do saldo. Fica no extrato do passageiro com o motivo.
        </p>
        <div className="formulario">
          <label>Celular do passageiro<input value={adj.phone} onChange={(e) => setAdj({ ...adj, phone: e.target.value })} placeholder="(14) 99999-9999" /></label>
          <label>Valor (R$)<input inputMode="decimal" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} placeholder="5,00" /></label>
          <label>Motivo (o passageiro vê)<input value={adj.note} maxLength={120} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="Desculpe pela demora" /></label>
          <button disabled={busy === 'ajuste' || !adj.phone || !adj.amount || adj.note.trim().length < 3}
            onClick={() => run('ajuste', async () => {
              const res = await api('/admin/cashback/adjust', { method: 'POST', body: { phone: adj.phone, amountCents: toCents(adj.amount), note: adj.note.trim() } });
              setAdj({ phone: '', amount: '', note: '' });
              return res;
            }, 'Crédito lançado no saldo do passageiro.')}>Lançar</button>
        </div>
      </section>
    </>
  );
}
