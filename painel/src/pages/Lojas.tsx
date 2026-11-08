import { useState } from 'react';
import { api } from '../api';
import { date, dateTime, money, phone as fmtPhone } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';
import PlacePicker, { type PickedPlace } from '../PlacePicker';

/** Licenciado: lojas do Daqui Entrega (créditos, fatura, desconto, Pix) */
export default function Lojas() {
  const list = useLoad(() => api('/admin/accounts?kind=loja'));
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const stores = list.data?.accounts ?? [];

  if (open) return <StoreDetail id={open} onBack={() => { setOpen(null); list.reload(); }} />;

  return (
    <>
      <div className="topo">
        <div>
          <h1>Lojas (Daqui Entrega)</h1>
          <p>Lojas que pedem entregas pelo painel. O frete vem para a sua conta Mercado Pago (créditos ou fatura semanal) e o produto é pago direto para a loja.</p>
        </div>
      </div>
      <Erro msg={list.error} />
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}
      <section className="cartao">
        {list.data && stores.length === 0 && <p className="vazio">Nenhuma loja ainda.</p>}
        {stores.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Loja</th><th>Pagamento do frete</th><th className="num">Saldo / em aberto</th><th className="num">Entregas no mês</th><th>Pix da loja</th><th></th></tr></thead>
              <tbody>
                {stores.map((s: any) => (
                  <tr key={s.id} className="clicavel" onClick={() => setOpen(s.id)}>
                    <td><strong>{s.name}</strong>{!s.active && <> <Status tone="ruim">Desativada</Status></>}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{s.address ?? 'sem endereço'}</span></td>
                    <td>{s.billing_mode === 'prepago' ? 'Créditos pré-pagos' : `Fatura semanal · limite ${money(s.credit_limit_cents)}`}{Number(s.discount_pct) > 0 && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{Number(s.discount_pct)}% de desconto</span></>}</td>
                    <td className="num">{s.billing_mode === 'prepago' ? money(s.balance_cents) : money(Math.max(0, -s.balance_cents))}{s.open_invoices_cents > 0 && <><br /><span style={{ color: 'var(--vermelho)', fontSize: 13 }}>fatura {money(s.open_invoices_cents)}</span></>}</td>
                    <td className="num">{s.deliveries_month}</td>
                    <td>{s.mp_connected ? <Status tone="ok">Mercado Pago</Status> : s.pix_key ? (s.pix_validated ? <Status tone="ok">Chave conferida</Status> : <Status tone="alerta">Conferir chave</Status>) : '—'}</td>
                    <td><button className="secundario">Abrir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <NewStore onCreated={(name) => { list.reload(); setMsg({ ok: true, text: `${name} criada. A loja já pode entrar no painel com o endereço da cidade.` }); }} />
    </>
  );
}

function NewStore({ onCreated }: { onCreated: (name: string) => void }) {
  const empty = { name: '', document: '', mode: 'prepago', limit: '300,00', discount: '0', opName: '', opPhone: '', opPassword: '' };
  const [f, setF] = useState(empty);
  const [addr, setAddr] = useState<PickedPlace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/admin/accounts', {
        method: 'POST',
        body: {
          kind: 'loja', name: f.name, document: f.document || undefined, address: addr ?? undefined,
          billingMode: f.mode, creditLimitCents: Math.round(Number(f.limit.replace(/\./g, '').replace(',', '.')) * 100),
          discountPct: Number(f.discount.replace(',', '.')) || 0,
          operator: { name: f.opName, phone: f.opPhone, password: f.opPassword },
        },
      });
      onCreated(f.name);
      setF(empty);
      setAddr(null);
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <section className="cartao">
      <h2>Nova loja</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
        <div className="formulario">
          <label>Nome da loja<input value={f.name} onChange={set('name')} required minLength={3} /></label>
          <label>CNPJ<input value={f.document} onChange={set('document')} /></label>
          <label>Pagamento do frete
            <select value={f.mode} onChange={set('mode')}>
              <option value="prepago">Créditos pré-pagos (recomendado)</option>
              <option value="fatura">Fatura semanal (loja de confiança)</option>
            </select>
          </label>
          {f.mode === 'fatura' && <label>Limite em aberto (R$)<input value={f.limit} onChange={set('limit')} inputMode="decimal" /></label>}
          <label>Desconto no frete (%)<input value={f.discount} onChange={set('discount')} inputMode="decimal" /></label>
        </div>
        <PlacePicker value={addr} onChange={setAddr} label="Endereço de coleta" />
        <div className="formulario">
          <label>Nome de quem vai usar o painel<input value={f.opName} onChange={set('opName')} required minLength={3} /></label>
          <label>Celular (login)<input value={f.opPhone} onChange={set('opPhone')} inputMode="tel" required /></label>
          <label>Senha inicial (mín. 8)<input type="password" value={f.opPassword} onChange={set('opPassword')} minLength={8} required autoComplete="new-password" /></label>
          <button type="submit" className="destaque" disabled={busy}>{busy ? 'Criando…' : 'Criar loja'}</button>
        </div>
        {error && <div className="aviso erro" role="alert">{error}</div>}
      </form>
    </section>
  );
}

function StoreDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const det = useLoad(() => api(`/admin/accounts/${id}/ledger`), [id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [adj, setAdj] = useState({ value: '', note: '' });
  const [cfg, setCfg] = useState<any>(null);
  const s = det.data?.store;
  const form = cfg ?? (s ? { mode: s.billingMode, limit: (s.creditLimitCents / 100).toFixed(2).replace('.', ','), discount: String(s.discountPct) } : null);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); setCfg(null); det.reload(); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }
  const KIND: Record<string, string> = { recarga: 'Recarga', entrega: 'Entrega', estorno: 'Estorno', pagamento_fatura: 'Fatura paga', ajuste: 'Ajuste', cashback: 'Cashback', comissao: 'Comissão Daqui Food', turno: 'Turno de entregador fixo' };

  return (
    <>
      <button className="secundario" onClick={onBack} style={{ alignSelf: 'flex-start' }}>← Voltar às lojas</button>
      <Erro msg={det.error} />
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}
      {s && form && (
        <>
          <div className="topo"><div><h1>{s.name}</h1><p>{s.address?.address ?? 'Sem endereço de coleta'}</p></div></div>
          <section className="cartao grade-kpi">
            <div className="kpi"><span className="rotulo">{s.billingMode === 'prepago' ? 'Saldo' : 'Em aberto'}</span><span className="valor">{money(s.billingMode === 'prepago' ? s.balanceCents : Math.max(0, -s.balanceCents))}</span></div>
            <div className="kpi"><span className="rotulo">Pix da loja</span>
              <span style={{ fontWeight: 600 }}>{s.mercadopago.connected ? 'Mercado Pago conectado' : s.pix.key ? `${s.pix.key} · ${s.pix.holderName ?? ''}` : 'Não cadastrou'}</span>
              {s.pix.key && !s.mercadopago.connected && (
                s.pix.validated
                  ? <button className="perigo" onClick={() => act(() => api(`/admin/accounts/${id}`, { method: 'PATCH', body: { pixValidated: false } }), 'Validação removida')}>Remover validação</button>
                  : <button onClick={() => act(() => api(`/admin/accounts/${id}`, { method: 'PATCH', body: { pixValidated: true } }), 'Chave Pix conferida')}>Conferi: o titular é a loja</button>
              )}
            </div>
          </section>

          <section className="cartao">
            <h2>Condições</h2>
            <div className="formulario" style={{ marginTop: 12 }}>
              <label>Pagamento do frete
                <select value={form.mode} onChange={(e) => setCfg({ ...form, mode: e.target.value })}>
                  <option value="prepago">Créditos pré-pagos</option>
                  <option value="fatura">Fatura semanal</option>
                </select>
              </label>
              <label>Limite em aberto (R$)<input value={form.limit} onChange={(e) => setCfg({ ...form, limit: e.target.value })} inputMode="decimal" /></label>
              <label>Desconto no frete (%)<input value={form.discount} onChange={(e) => setCfg({ ...form, discount: e.target.value })} inputMode="decimal" /></label>
              <button onClick={() => act(() => api(`/admin/accounts/${id}`, {
                method: 'PATCH',
                body: { billingMode: form.mode, creditLimitCents: Math.round(Number(form.limit.replace(/\./g, '').replace(',', '.')) * 100), discountPct: Number(String(form.discount).replace(',', '.')) || 0 },
              }), 'Condições salvas')}>Salvar</button>
            </div>
            <div className="acoes" style={{ marginTop: 12 }}>
              <button className={s.active ? 'perigo' : 'secundario'} onClick={() => act(() => api(`/admin/accounts/${id}`, { method: 'PATCH', body: { active: !s.active } }), s.active ? 'Loja desativada' : 'Loja reativada')}>
                {s.active ? 'Desativar loja' : 'Reativar loja'}
              </button>
            </div>
          </section>

          <section className="cartao">
            <h2>Lançar crédito ou débito</h2>
            <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>Ex.: a loja pagou em dinheiro ou Pix direto para a central. Use valor negativo para debitar.</p>
            <div className="formulario">
              <label>Valor (R$)<input value={adj.value} onChange={(e) => setAdj({ ...adj, value: e.target.value })} inputMode="decimal" placeholder="100,00 ou -20,00" /></label>
              <label>Motivo<input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="Pix recebido em 05/11" /></label>
              <button disabled={!adj.value || adj.note.length < 3} onClick={() => act(async () => {
                const v = adj.value.trim();
                const cents = Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
                await api(`/admin/accounts/${id}/adjust`, { method: 'POST', body: { amountCents: cents, note: adj.note } });
                setAdj({ value: '', note: '' });
              }, 'Lançamento feito')}>Lançar</button>
            </div>
          </section>

          {det.data.invoices.length > 0 && (
            <section className="cartao">
              <h2>Faturas semanais</h2>
              <div className="tabela" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>Semana</th><th className="num">Entregas</th><th className="num">Total</th><th>Vencimento</th><th>Situação</th><th></th></tr></thead>
                  <tbody>
                    {det.data.invoices.map((i: any) => (
                      <tr key={i.id}>
                        <td>{date(i.period_start)} a {date(i.period_end)}</td><td className="num">{i.deliveries}</td><td className="num">{money(i.total_cents)}</td><td>{date(i.due_date)}</td>
                        <td>{i.status === 'paid' ? <Status tone="ok">Paga ({i.paid_by === 'manual' ? 'baixa manual' : 'Mercado Pago'})</Status> : i.overdue ? <Status tone="ruim">Vencida</Status> : <Status tone="alerta">Em aberto</Status>}</td>
                        <td>{i.status === 'open' && <button className="secundario" onClick={() => window.confirm('Dar baixa nesta fatura?') && act(() => api(`/admin/store-invoices/${i.id}/mark-paid`, { method: 'POST', body: {} }), 'Fatura baixada')}>Dar baixa</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="cartao">
            <h2>Extrato</h2>
            {det.data.ledger.length === 0 && <p className="vazio">Sem lançamentos.</p>}
            {det.data.ledger.length > 0 && (
              <div className="tabela" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>Quando</th><th>Lançamento</th><th className="num">Valor</th><th className="num">Saldo</th></tr></thead>
                  <tbody>
                    {det.data.ledger.map((l: any) => (
                      <tr key={l.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{dateTime(l.created_at)}</td>
                        <td>{KIND[l.kind] ?? l.kind}{l.recipient_name ? ` · ${l.recipient_name}` : ''}{l.note ? ` · ${l.note}` : ''}</td>
                        <td className="num" style={{ color: l.amount_cents < 0 ? 'var(--vermelho)' : 'var(--verde)' }}>{l.amount_cents < 0 ? '−' : '+'} {money(Math.abs(l.amount_cents))}</td>
                        <td className="num">{money(l.balance_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {false && fmtPhone('')}
    </>
  );
}
