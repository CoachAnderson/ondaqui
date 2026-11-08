import { useEffect, useState } from 'react';
import { api } from '../api';
import { money } from '../format';
import { Erro, errMsg, useLoad } from '../ui';

const toCents = (reais: string) => Math.round(Number(reais.replace(',', '.')) * 100);
const toReais = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

export default function Pricing() {
  const settings = useLoad(() => api('/admin/settings'));
  const cats = useLoad(() => api('/admin/categories'));
  const plans = useLoad(() => api('/admin/plans'));

  return (
    <>
      <div className="topo">
        <div>
          <h1>Tarifas e planos</h1>
          <p>Valores das corridas, tarifa dinâmica e planos dos motoristas da sua cidade.</p>
        </div>
      </div>
      <Erro msg={settings.error ?? cats.error ?? plans.error} />
      {settings.data && <Surge s={settings.data} onSaved={settings.reload} />}
      <section className="cartao">
        <h2>Serviços e tarifas</h2>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
          Valores em reais. O preço é fechado antes de confirmar. Desmarque "Ativo" para tirar um serviço do app da sua cidade.
        </p>
        {cats.data?.categories.map((c: any) => <Category key={c.code} c={c} onSaved={cats.reload} />)}
      </section>
      <section className="cartao">
        <h2>Planos dos motoristas</h2>
        <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>Plano com período em dias cobra mensalidade e não tem comissão. Período 0 cobra só comissão.</p>
        {plans.data?.plans.map((p: any) => <Plan key={p.code} p={p} onSaved={plans.reload} />)}
      </section>
    </>
  );
}

function Feedback({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status" style={{ marginTop: 10 }}>{msg.text}</div> : null;
}

function useSave() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(fn: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: 'Salvo' }); after(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
    finally { setBusy(false); }
  }
  return { msg, busy, save };
}

function Surge({ s, onSaved }: { s: any; onSaved: () => void }) {
  const [surge, setSurge] = useState(String(s.current_surge));
  const [cap, setCap] = useState(String(s.surge_cap));
  const [radius, setRadius] = useState(String(s.dispatch_radius_km));
  const { msg, busy, save } = useSave();
  useEffect(() => { setSurge(String(s.current_surge)); setCap(String(s.surge_cap)); setRadius(String(s.dispatch_radius_km)); }, [s]);
  return (
    <section className="cartao">
      <h2>Tarifa dinâmica e despacho</h2>
      <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
        O teto protege o passageiro: a tarifa dinâmica nunca passa dele. Hoje: {s.current_surge}x (teto {s.surge_cap}x).
      </p>
      <div className="formulario">
        <label>Tarifa dinâmica agora (x)<input type="number" step="0.1" min="1" value={surge} onChange={(e) => setSurge(e.target.value)} /></label>
        <label>Teto da dinâmica (x)<input type="number" step="0.1" min="1" max="3" value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <label>Raio para chamar motoristas (km)<input type="number" step="1" min="1" value={radius} onChange={(e) => setRadius(e.target.value)} /></label>
        <button disabled={busy} onClick={() => save(() => api('/admin/settings', {
          method: 'PATCH', body: { currentSurge: Number(surge), surgeCap: Number(cap), dispatchRadiusKm: Number(radius) },
        }), onSaved)}>Salvar</button>
      </div>
      <Feedback msg={msg} />
    </section>
  );
}

const KIND: Record<string, string> = {
  corrida: 'Corrida', entrega: 'Entrega com código', particular: 'Motorista por hora', frete: 'Frete e carreto', paciente: 'Convênio da Saúde (pacientes)',
};
const ICON: Record<string, string> = {
  carro: '🚗', moto: '🏍️', executivo: '💼', mulher: '👩', pet: '🐾', entrega: '📦', 'entrega-carro': '📦', particular: '🕐', frete: '🚚', paciente: '🏥',
};

function Category({ c, onSaved }: { c: any; onSaved: () => void }) {
  const [f, setF] = useState({
    name: c.name, base: toReais(c.base_fare_cents), km: toReais(c.per_km_cents),
    min: toReais(c.per_min_cents), minFare: toReais(c.min_fare_cents), active: c.active,
    hour: toReais(c.per_hour_cents ?? 0), extra: toReais(c.extra_fee_cents ?? 0), description: c.description ?? '',
  });
  const hourly = c.kind === 'particular';
  const extraLabel = c.kind === 'frete' ? 'Por ajudante (R$)' : c.code === 'pet' ? 'Taxa do pet (R$)' : null;
  const { msg, busy, save } = useSave();
  return (
    <div style={{ borderTop: '1px solid var(--linha)', padding: '16px 0' }}>
      <h3 style={{ marginBottom: 4 }}>{ICON[c.code] ?? '🚗'} {c.name} <span style={{ fontWeight: 500, fontSize: 14, color: 'var(--texto-2)' }}>· {KIND[c.kind] ?? c.kind}</span></h3>
      <div className="formulario">
        <label>Nome<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Descrição no app<input value={f.description} maxLength={120} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        {hourly ? (
          <label>Por hora (R$)<input inputMode="decimal" value={f.hour} onChange={(e) => setF({ ...f, hour: e.target.value })} /></label>
        ) : (
          <>
            <label>Bandeirada (R$)<input inputMode="decimal" value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })} /></label>
            <label>Por km (R$)<input inputMode="decimal" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} /></label>
            <label>Por minuto (R$)<input inputMode="decimal" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></label>
          </>
        )}
        {extraLabel && <label>{extraLabel}<input inputMode="decimal" value={f.extra} onChange={(e) => setF({ ...f, extra: e.target.value })} /></label>}
        <label>{hourly ? 'Valor mínimo (R$)' : 'Corrida mínima (R$)'}<input inputMode="decimal" value={f.minFare} onChange={(e) => setF({ ...f, minFare: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Ativa</label>
        <button disabled={busy} onClick={() => save(() => api(`/admin/categories/${c.code}`, {
          method: 'PUT', body: {
            name: f.name, baseFareCents: toCents(f.base), perKmCents: toCents(f.km),
            perMinCents: toCents(f.min), minFareCents: toCents(f.minFare), active: f.active,
            perHourCents: toCents(f.hour), extraFeeCents: toCents(f.extra), description: f.description,
          },
        }), onSaved)}>Salvar {c.name}</button>
      </div>
      <Feedback msg={msg} />
    </div>
  );
}

function Plan({ p, onSaved }: { p: any; onSaved: () => void }) {
  const [f, setF] = useState({ name: p.name, price: toReais(p.price_cents), days: String(p.period_days), pct: String(p.commission_pct), active: p.active });
  const { msg, busy, save } = useSave();
  return (
    <div style={{ borderTop: '1px solid var(--linha)', padding: '16px 0' }}>
      <div className="formulario">
        <label>Nome<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Mensalidade (R$)<input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
        <label>Período (dias)<input type="number" min="0" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></label>
        <label>Comissão (%)<input type="number" min="0" max="50" value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Ativo</label>
        <button disabled={busy} onClick={() => save(() => api(`/admin/plans/${p.code}`, {
          method: 'PUT', body: { name: f.name, priceCents: toCents(f.price), periodDays: Number(f.days), commissionPct: Number(f.pct), active: f.active },
        }), onSaved)}>Salvar {p.name}</button>
      </div>
      <p style={{ margin: '8px 0 0', color: 'var(--texto-2)', fontSize: 14 }}>
        {Number(f.days) > 0 ? `${money(toCents(f.price))} a cada ${f.days} dias` : `${f.pct}% de cada corrida, sem mensalidade`}
      </p>
      <Feedback msg={msg} />
    </div>
  );
}
