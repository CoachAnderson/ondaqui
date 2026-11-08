import { useState } from 'react';
import { api, apiDownload } from '../api';
import { date, money } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

export default function Master() {
  const list = useLoad(() => api('/master/tenants'));
  const [error, setError] = useState<string | null>(null);
  const tenants = list.data?.tenants ?? [];
  const totalFee = tenants.reduce((s: number, t: any) => s + t.license_fee_month_cents, 0);

  async function toggle(t: any) {
    setError(null);
    try {
      await api(`/master/tenants/${t.id}`, { method: 'PATCH', body: { active: !t.active } });
      list.reload();
    } catch (e) { setError(errMsg(e)); }
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Licenciados</h1>
          <p>Cidades usando o OnDaqui. Taxa por corrida deste mês: <strong>{money(totalFee)}</strong>.</p>
        </div>
      </div>
      <Erro msg={list.error ?? error} />
      <section className="cartao">
        {list.data && tenants.length === 0 && <p className="vazio">Nenhum licenciado ainda.</p>}
        {tenants.length > 0 && (
          <div className="tabela">
            <table>
              <thead>
                <tr><th>Licenciado</th><th>Situação</th><th className="num">Usuários</th><th className="num">Corridas/mês</th><th className="num">Taxa no mês</th><th className="num">Licença/mês</th><th className="num">Em aberto</th><th></th></tr>
              </thead>
              <tbody>
                {tenants.map((t: any) => (
                  <tr key={t.id}>
                    <td><strong>{t.name}</strong><br /><span style={{ color: 'var(--texto-2)' }}>endereço: {t.slug} · desde {date(t.created_at)}</span></td>
                    <td>
                      {t.active ? <Status tone="ok">Ativo</Status>
                        : <Status tone="ruim">{t.suspended_reason === 'inadimplencia' ? 'Suspenso (atraso)' : 'Suspenso'}</Status>}
                      <br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{t.mp_connected ? 'Mercado Pago conectado' : 'Sem Mercado Pago'}</span>
                    </td>
                    <td className="num">{t.drivers} motor.<br /><span style={{ color: 'var(--texto-2)' }}>{t.passengers} passag.</span></td>
                    <td className="num">{t.rides_month}</td>
                    <td className="num">{money(t.license_fee_month_cents)}<br /><span style={{ color: 'var(--texto-2)' }}>{money(t.license_fee_per_ride_cents)}/corrida</span></td>
                    <td className="num"><LicenseFee t={t} onSaved={list.reload} onError={setError} /></td>
                    <td className="num">{money(t.open_invoices_cents)}</td>
                    <td>
                      <div className="acoes">
                        <button className={t.active ? 'perigo' : 'secundario'} onClick={() => toggle(t)}>{t.active ? 'Suspender' : 'Reativar'}</button>
                        <button className="secundario" title="Planilhas com todos os dados da cidade (entrega ao licenciado no fim do contrato)"
                          onClick={() => apiDownload(`/master/tenants/${t.id}/export`, `${t.slug}-dados.zip`).catch((e) => setError(errMsg(e)))}>Baixar dados</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <NewTenant onCreated={list.reload} />
    </>
  );
}

function LicenseFee({ t, onSaved, onError }: { t: any; onSaved: () => void; onError: (m: string | null) => void }) {
  const [v, setV] = useState((t.license_monthly_cents / 100).toFixed(2).replace('.', ','));
  const changed = Math.round(Number(v.replace(',', '.')) * 100) !== t.license_monthly_cents;
  async function save() {
    onError(null);
    try {
      await api(`/master/tenants/${t.id}`, { method: 'PATCH', body: { licenseMonthlyCents: Math.round(Number(v.replace(',', '.')) * 100) } });
      onSaved();
    } catch (e) { onError(errMsg(e)); }
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input aria-label={`Licença mensal de ${t.name} (R$)`} value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" style={{ width: 90, textAlign: 'right' }} />
      {changed && <button className="secundario" onClick={save}>Salvar</button>}
    </span>
  );
}

function NewTenant({ onCreated }: { onCreated: () => void }) {
  const empty = { name: '', cityLabel: '', slug: '', fee: '0,20', license: '499,00', adminName: '', adminPhone: '', adminPassword: '' };
  const [f, setF] = useState(empty);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('/master/tenants', {
        method: 'POST',
        body: {
          slug: f.slug.trim().toLowerCase(), name: f.name, cityLabel: f.cityLabel,
          licenseFeePerRideCents: Math.round(Number(f.fee.replace(',', '.')) * 100),
          licenseMonthlyCents: Math.round(Number(f.license.replace(',', '.')) * 100),
          admin: { name: f.adminName, phone: f.adminPhone, password: f.adminPassword },
        },
      });
      setMsg({ ok: true, text: `${f.name} criado. A central já pode entrar com o endereço "${f.slug}".` });
      setF(empty);
      onCreated();
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cartao">
      <h2>Novo licenciado</h2>
      <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>Já nasce com categorias Carro e Moto e os planos Livre, Semanal e Profissional.</p>
      <form className="formulario" onSubmit={submit}>
        <label>Nome da marca<input value={f.name} onChange={set('name')} placeholder="OnDaqui Marília" required /></label>
        <label>Cidade ou região<input value={f.cityLabel} onChange={set('cityLabel')} placeholder="Marília" required /></label>
        <label>Endereço (sem espaços)<input value={f.slug} onChange={set('slug')} placeholder="marilia" pattern="[a-z0-9-]{2,40}" required /></label>
        <label>Taxa por corrida (R$)<input value={f.fee} onChange={set('fee')} inputMode="decimal" required /></label>
        <label>Licença mensal (R$)<input value={f.license} onChange={set('license')} inputMode="decimal" required /></label>
        <label>Responsável da central<input value={f.adminName} onChange={set('adminName')} required /></label>
        <label>Telefone do responsável<input value={f.adminPhone} onChange={set('adminPhone')} inputMode="tel" required /></label>
        <label>Senha inicial (mín. 8)<input type="password" value={f.adminPassword} onChange={set('adminPassword')} minLength={8} required autoComplete="new-password" /></label>
        <button type="submit" className="destaque" disabled={busy}>{busy ? 'Criando…' : 'Criar licenciado'}</button>
      </form>
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status" style={{ marginTop: 12 }}>{msg.text}</div>}
    </section>
  );
}
