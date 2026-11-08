import { useState } from 'react';
import { api } from '../api';
import { money, phone as fmtPhone } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';
import { Report } from './Saude';

/** Licenciado: convênios do Daqui Prefeitura (ex.: Secretaria de Saúde) */
export default function Accounts() {
  const list = useLoad(() => api('/admin/accounts?kind=prefeitura'));
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const accounts = list.data?.accounts ?? [];
  const current = accounts.find((a: any) => a.id === open);

  async function toggle(a: any) {
    try { await api(`/admin/accounts/${a.id}`, { method: 'PATCH', body: { active: !a.active } }); list.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }

  if (current) {
    return (
      <>
        <button className="secundario" onClick={() => setOpen(null)} style={{ alignSelf: 'flex-start' }}>← Voltar aos convênios</button>
        <Report base={`/admin/accounts/${current.id}`} title={current.name} />
        <Operators account={current} onAdded={list.reload} />
      </>
    );
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Daqui Prefeitura</h1>
          <p>Convênios com a Prefeitura para transporte de pacientes. A Saúde agenda, a central atende e o relatório sai pronto no fim do mês.</p>
        </div>
      </div>
      <Erro msg={list.error} />
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}
      <section className="cartao">
        {list.data && accounts.length === 0 && <p className="vazio">Nenhum convênio ainda.</p>}
        {accounts.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Convênio</th><th>Situação</th><th className="num">Pacientes</th><th className="num">Viagens no mês</th><th className="num">Valor no mês</th><th>Acessos</th><th></th></tr></thead>
              <tbody>
                {accounts.map((a: any) => (
                  <tr key={a.id}>
                    <td><strong>{a.name}</strong>{a.document && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>CNPJ {a.document}</span></>}</td>
                    <td>{a.active ? <Status tone="ok">Ativo</Status> : <Status tone="ruim">Desativado</Status>}</td>
                    <td className="num">{a.patients}</td>
                    <td className="num">{a.trips_month}</td>
                    <td className="num">{money(a.total_month_cents)}</td>
                    <td>{a.operators.map((o: any) => <div key={o.id}>{o.name} · {fmtPhone(o.phone)}</div>)}</td>
                    <td>
                      <span className="acoes">
                        <button className="secundario" onClick={() => setOpen(a.id)}>Relatório</button>
                        <button className={a.active ? 'perigo' : 'secundario'} onClick={() => toggle(a)}>{a.active ? 'Desativar' : 'Reativar'}</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <NewAccount onCreated={(name) => { list.reload(); setMsg({ ok: true, text: `${name} criado. O operador já pode entrar no painel com o endereço da cidade.` }); }} />
    </>
  );
}

function NewAccount({ onCreated }: { onCreated: (name: string) => void }) {
  const empty = { name: '', document: '', contactName: '', contactPhone: '', opName: '', opPhone: '', opPassword: '' };
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/admin/accounts', {
        method: 'POST',
        body: {
          name: f.name, document: f.document || undefined, contactName: f.contactName || undefined, contactPhone: f.contactPhone || undefined,
          operator: { name: f.opName, phone: f.opPhone, password: f.opPassword },
        },
      });
      onCreated(f.name);
      setF(empty);
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <section className="cartao">
      <h2>Novo convênio</h2>
      <form className="formulario" onSubmit={submit} style={{ marginTop: 12 }}>
        <label>Órgão<input value={f.name} onChange={set('name')} placeholder="Secretaria Municipal de Saúde" required minLength={3} /></label>
        <label>CNPJ<input value={f.document} onChange={set('document')} /></label>
        <label>Responsável<input value={f.contactName} onChange={set('contactName')} /></label>
        <label>Telefone do órgão<input value={f.contactPhone} onChange={set('contactPhone')} inputMode="tel" /></label>
        <label>Nome do operador<input value={f.opName} onChange={set('opName')} required minLength={3} /></label>
        <label>Celular do operador (login)<input value={f.opPhone} onChange={set('opPhone')} inputMode="tel" required /></label>
        <label>Senha inicial (mín. 8)<input type="password" value={f.opPassword} onChange={set('opPassword')} minLength={8} required autoComplete="new-password" /></label>
        <button type="submit" className="destaque" disabled={busy}>{busy ? 'Criando…' : 'Criar convênio'}</button>
      </form>
      {error && <div className="aviso erro" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    </section>
  );
}

function Operators({ account, onAdded }: { account: any; onAdded: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', password: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/admin/accounts/${account.id}/operators`, { method: 'POST', body: f });
      setMsg({ ok: true, text: `${f.name} pode entrar no painel.` });
      setF({ name: '', phone: '', password: '' });
      onAdded();
    } catch (err) { setMsg({ ok: false, text: errMsg(err) }); }
  }
  return (
    <section className="cartao">
      <h2>Acessos da Saúde</h2>
      <ul style={{ margin: '8px 0 16px', paddingLeft: 18 }}>{account.operators.map((o: any) => <li key={o.id}>{o.name} · {fmtPhone(o.phone)}</li>)}</ul>
      <form className="formulario" onSubmit={submit}>
        <label>Nome<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={3} /></label>
        <label>Celular (login)<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" required /></label>
        <label>Senha inicial<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={8} required autoComplete="new-password" /></label>
        <button type="submit" className="secundario">Adicionar acesso</button>
      </form>
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status" style={{ marginTop: 12 }}>{msg.text}</div>}
    </section>
  );
}
