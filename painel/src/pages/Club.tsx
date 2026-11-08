import { useEffect, useState } from 'react';
import { api } from '../api';
import { money, phone as fmtPhone } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR');

/**
 * Licenciado: Clube do passageiro. Assinatura mensal paga pelo app (Mercado Pago da cidade), sem renovação automática.
 * Os benefícios saem da margem da central: o motorista recebe o valor cheio no acerto da semana.
 */
export default function Club() {
  const c = useLoad(() => api('/admin/club'));
  const [f, setF] = useState({ name: '', price: '', pct: '', max: '', mult: '2', noSurge: true, priority: true });
  const [g, setG] = useState({ phone: '', months: '1', paid: '', note: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const r = c.data?.rules;
    if (r) setF({ name: r.name, price: reais(r.priceCents), pct: String(r.discountPct).replace('.', ','), max: reais(r.discountMaxCents),
      mult: String(r.cashbackMultiplier), noSurge: r.noSurge, priority: r.priority });
  }, [c.data]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); c.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
    finally { setBusy(null); }
  }

  const body = (enabled?: boolean) => ({
    ...(enabled !== undefined ? { enabled } : {}),
    name: f.name.trim(), priceCents: toCents(f.price), discountPct: Number(f.pct.replace(',', '.')) || 0, discountMaxCents: toCents(f.max),
    cashbackMultiplier: Number(f.mult), noSurge: f.noSurge, priority: f.priority,
  });

  const d = c.data;
  const r = d?.rules;
  const s = d?.summary;
  const pct = Number(f.pct.replace(',', '.')) || 0;
  const breakEven = pct > 0 ? Math.ceil(toCents(f.price) / Math.max(1, Math.min(Math.floor(2000 * pct / 100), toCents(f.max) || 0))) : null;

  return (
    <>
      <div className="topo">
        <div>
          <h1>Clube do passageiro</h1>
          <p>
            Uma assinatura mensal que o passageiro paga pelo app, no Mercado Pago da cidade. Em troca, ele tem desconto em cada corrida,
            não paga tarifa dinâmica, ganha cashback multiplicado e tem prioridade para achar motorista. Não renova sozinho: o app avisa
            3 dias antes de vencer. O motorista recebe o valor cheio da corrida; a diferença entra no acerto da semana, junto com o cashback.
          </p>
        </div>
      </div>
      <Erro msg={c.error} />
      {s && (
        <section className="grade-kpi">
          <div className="cartao kpi"><span className="rotulo">Assinantes</span><span className="valor">{s.members}</span><span className="nota">{s.expiring} vencem em até 3 dias</span></div>
          <div className="cartao kpi"><span className="rotulo">Recebido no mês</span><span className="valor">{money(s.revenue_month)}</span><span className="nota">{s.payments_month} pagamentos</span></div>
          <div className="cartao kpi"><span className="rotulo">Descontos dados no mês</span><span className="valor">{money(s.discounts_month)}</span><span className="nota">{s.rides_month} corridas de assinantes</span></div>
          <div className="cartao kpi"><span className="rotulo">Resultado do mês</span>
            <span className="valor" style={{ color: s.revenue_month - s.discounts_month < 0 ? 'var(--vermelho)' : undefined }}>{money(s.revenue_month - s.discounts_month)}</span>
            <span className="nota">assinaturas − descontos</span></div>
        </section>
      )}
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}

      {r && (
        <section className="cartao">
          <h2>Regras do clube {r.enabled ? <Status tone="ok">Ligado</Status> : <Status tone="neutra">Desligado</Status>}</h2>
          {!d.mercadopago && <div className="aviso erro" role="status" style={{ margin: '8px 0' }}>Conecte o Mercado Pago da cidade em Recebimentos: sem ele, o passageiro não consegue assinar pelo app.</div>}
          <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
            Mudanças valem para as próximas corridas. Para mudar o preço de quem já assina, avise antes: o valor novo vale na próxima renovação.
          </p>
          <div className="formulario">
            <label>Nome do clube<input value={f.name} maxLength={30} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label>Preço por 30 dias (R$)<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
            <label>Desconto por corrida (%)<input inputMode="decimal" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} /></label>
            <label>Teto do desconto por corrida (R$)<input inputMode="decimal" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} /></label>
            <label>Cashback para assinantes
              <select value={f.mult} onChange={(e) => setF({ ...f, mult: e.target.value })}>
                <option value="1">Igual aos outros</option><option value="2">Em dobro</option><option value="3">Triplo</option>
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={f.noSurge} onChange={(e) => setF({ ...f, noSurge: e.target.checked })} /> Sem tarifa dinâmica</label>
            <label className="check"><input type="checkbox" checked={f.priority} onChange={(e) => setF({ ...f, priority: e.target.checked })} /> Prioridade no despacho</label>
            <button disabled={busy === 'regras'} onClick={() => run('regras', () => api('/admin/club', { method: 'PATCH', body: body() }), 'Regras salvas.')}>Salvar</button>
            {r.enabled
              ? <button className="secundario" disabled={busy === 'regras'} onClick={() => window.confirm('Desligar o clube? Quem já assina perde os benefícios até você ligar de novo.') && run('regras', () => api('/admin/club', { method: 'PATCH', body: { enabled: false } }), 'Clube desligado.')}>Desligar</button>
              : <button className="destaque" disabled={busy === 'regras'} onClick={() => run('regras', () => api('/admin/club', { method: 'PATCH', body: body(true) }), 'Clube ligado. Os passageiros já veem no app.')}>Salvar e ligar</button>}
          </div>
          <p style={{ color: 'var(--texto-2)', margin: '12px 0 0', fontSize: 14 }}>
            {breakEven ? `Numa corrida de R$ 20,00 o assinante economiza ${money(Math.min(Math.floor(2000 * pct / 100), toCents(f.max) || 0))}; a assinatura se paga para a central se ele fizer menos de ${breakEven} corridas assim no mês. ` : ''}
            {f.noSurge ? 'Sem dinâmica, a central também cobre a dinâmica que o assinante não paga: acompanhe o resultado do mês.' : ''}
            {f.priority ? ' Prioridade: a corrida do assinante é oferecida a mais motoristas de uma vez, e quem tem uma oferta dele aberta não recebe outra até responder.' : ''}
          </p>
        </section>
      )}

      <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2>Assinantes</h2>
        {d && d.members.length === 0 && <p className="vazio">Ninguém assinou ainda.</p>}
        {d?.members.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Passageiro</th><th>Situação</th><th className="num">Meses</th><th className="num">Pagou</th><th className="num">Economizou</th></tr></thead>
              <tbody>
                {d.members.map((m: any) => (
                  <tr key={m.id}>
                    <td><strong>{m.name}</strong><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{fmtPhone(m.phone)}</span></td>
                    <td>{m.active ? <Status tone="ok">Até {day(m.until)}</Status> : <Status tone="neutra">Venceu em {day(m.until)}</Status>}</td>
                    <td className="num">{m.months}</td>
                    <td className="num">{money(m.paid_cents)}</td>
                    <td className="num">{money(m.saved_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="cartao">
        <h2>Dar meses ou registrar pagamento por fora</h2>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
          Cortesia (lançamento, compensar uma reclamação) ou um pagamento recebido em dinheiro ou Pix direto na central. Soma ao que o passageiro já tem.
        </p>
        <div className="formulario">
          <label>Celular do passageiro<input value={g.phone} onChange={(e) => setG({ ...g, phone: e.target.value })} placeholder="(14) 99999-9999" /></label>
          <label>Meses
            <select value={g.months} onChange={(e) => setG({ ...g, months: e.target.value })}>{[1, 2, 3, 6, 12].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </label>
          <label>Valor recebido (R$)<input inputMode="decimal" value={g.paid} onChange={(e) => setG({ ...g, paid: e.target.value })} placeholder="vazio = cortesia" /></label>
          <label>Motivo<input value={g.note} maxLength={120} onChange={(e) => setG({ ...g, note: e.target.value })} placeholder="Cortesia de lançamento" /></label>
          <button disabled={busy === 'dar' || !g.phone || g.note.trim().length < 3}
            onClick={() => run('dar', async () => {
              const res = await api('/admin/club/grant', { method: 'POST', body: { phone: g.phone, months: Number(g.months), amountCents: g.paid.trim() ? toCents(g.paid) : 0, note: g.note.trim() } });
              setG({ phone: '', months: '1', paid: '', note: '' });
              return res;
            }, 'Lançado. O passageiro já tem os benefícios.')}>Lançar</button>
        </div>
      </section>
    </>
  );
}
