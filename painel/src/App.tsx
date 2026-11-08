import { useCallback, useEffect, useState } from 'react';
import { api, getSession, onSessionExpired, setSession, type Session } from './api';
import { closeSocket, useRealtime } from './realtime';
import { Wordmark, errMsg } from './ui';
import Overview from './pages/Overview';
import Drivers from './pages/Drivers';
import Rides from './pages/Rides';
import Safety from './pages/Safety';
import Pricing from './pages/Pricing';
import Master from './pages/Master';
import Invoices from './pages/Invoices';
import Receive from './pages/Receive';
import MasterInvoices from './pages/MasterInvoices';
import Accounts from './pages/Accounts';
import Lojas from './pages/Lojas';
import PrivacySettings from './pages/PrivacySettings';
import Commissions from './pages/Commissions';
import Cashback from './pages/Cashback';
import Club from './pages/Club';
import Ads from './pages/Ads';
import Escola from './pages/Escola';
import FoodAdmin, { FoodMenu, FoodOrders, FoodSettings, FoodShifts } from './pages/Food';
import { Credits, Deliveries, StoreSettings } from './pages/Loja';
import { Patients, Places, Report, Trips } from './pages/Saude';

type Page = 'visao' | 'motoristas' | 'corridas' | 'seguranca' | 'tarifas' | 'lojas' | 'prefeitura' | 'recebimentos' | 'comissoes' | 'cashback' | 'clube' | 'anuncios' | 'escola' | 'food' | 'privacidade' | 'faturas';

const PAGES: { id: Page; label: string }[] = [
  { id: 'visao', label: 'Visão geral' },
  { id: 'motoristas', label: 'Motoristas' },
  { id: 'corridas', label: 'Corridas' },
  { id: 'seguranca', label: 'Segurança' },
  { id: 'tarifas', label: 'Serviços e tarifas' },
  { id: 'lojas', label: 'Lojas (Daqui Entrega)' },
  { id: 'prefeitura', label: 'Daqui Prefeitura' },
  { id: 'escola', label: 'Daqui Escola' },
  { id: 'food', label: 'Daqui Food' },
  { id: 'comissoes', label: 'Comissões dos motoristas' },
  { id: 'cashback', label: 'Cashback' },
  { id: 'clube', label: 'Clube do passageiro' },
  { id: 'anuncios', label: 'Anúncios' },
  { id: 'recebimentos', label: 'Recebimentos' },
  { id: 'privacidade', label: 'Privacidade (LGPD)' },
  { id: 'faturas', label: 'Faturas' },
];

/** ?pagina=faturas abre direto na página (volta do Mercado Pago) */
function initialPage<T extends string>(valid: readonly T[], fallback: T): T {
  const p = new URLSearchParams(window.location.search).get('pagina') as T | null;
  if (p && valid.includes(p)) {
    window.history.replaceState(null, '', window.location.pathname);
    return p;
  }
  return fallback;
}

export default function App() {
  const [session, setS] = useState<Session | null>(getSession());

  const logout = () => {
    setSession(null);
    closeSocket();
    setS(null);
  };
  useEffect(() => onSessionExpired(logout), []);

  if (!session) return <Login onLogin={(s) => { setSession(s); setS(s); }} />;
  if (session.role === 'master') return <MasterLayout session={session} onLogout={logout} />;
  if (session.role === 'account_operator') return <AccountLayout session={session} onLogout={logout} />;
  return <TenantLayout session={session} onLogout={logout} />;
}

function TenantLayout({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [page, setPage] = useState<Page>(() => initialPage(PAGES.map((p) => p.id), 'visao'));
  const [openAlerts, setOpenAlerts] = useState(0);
  const [panic, setPanic] = useState<any | null>(null);
  const [city, setCity] = useState('');
  const [suspended, setSuspended] = useState<string | null>(null); // motivo, se a cidade estiver suspensa

  const loadStatus = useCallback(async () => {
    const me = await api('/me').catch(() => null);
    if (!me) return;
    setCity(me.tenant_name ?? '');
    setSuspended(me.tenant_active === false ? (me.suspended_reason ?? 'manual') : null);
    if (me.tenant_active !== false) api('/admin/overview').then((o) => setOpenAlerts(o.open_alerts)).catch(() => {});
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { if (suspended) setPage('faturas'); }, [suspended]);
  useRealtime('invoice:paid', () => { loadStatus(); });

  useRealtime('alert:panic', (a) => { setPanic(a); setOpenAlerts((n) => n + 1); });
  useRealtime('alert:resolved', () => setOpenAlerts((n) => Math.max(0, n - 1)));

  return (
    <div className="layout">
      <nav className="menu" aria-label="Menu principal">
        <div className="marca"><Wordmark size={30} /></div>
        <div className="cidade">{city || session.tenant}</div>
        {PAGES.filter((p) => !suspended || p.id === 'faturas').map((p) => (
          <button key={p.id} className={page === p.id ? 'ativo' : ''} onClick={() => setPage(p.id)}
                  aria-current={page === p.id ? 'page' : undefined}>
            {p.label}
            {p.id === 'seguranca' && openAlerts > 0 && <span className="badge">{openAlerts}</span>}
          </button>
        ))}
        <div className="rodape">
          <span>{session.name}</span>
          <button onClick={onLogout}>Sair</button>
        </div>
      </nav>
      <main className="conteudo">
        {panic && (
          <div className="aviso panico" role="alert">
            <span>
              <strong>Botão de emergência acionado</strong> pelo {panic.by} — {panic.passenger}
              {panic.vehicle ? `, veículo ${panic.vehicle}` : ''}.
            </span>
            <span className="acoes">
              <button onClick={() => { setPage('seguranca'); setPanic(null); }}>Ver ocorrência</button>
            </span>
          </div>
        )}
        {suspended && page !== 'faturas' && (
          <div className="aviso erro" role="alert">Cidade suspensa. Veja as faturas para regularizar.</div>
        )}
        {!suspended && page === 'visao' && <Overview />}
        {!suspended && page === 'motoristas' && <Drivers />}
        {!suspended && page === 'corridas' && <Rides />}
        {!suspended && page === 'seguranca' && <Safety />}
        {!suspended && page === 'tarifas' && <Pricing />}
        {!suspended && page === 'lojas' && <Lojas />}
        {!suspended && page === 'prefeitura' && <Accounts />}
        {!suspended && page === 'comissoes' && <Commissions />}
        {!suspended && page === 'cashback' && <Cashback />}
        {!suspended && page === 'clube' && <Club />}
        {!suspended && page === 'anuncios' && <Ads />}
        {!suspended && page === 'escola' && <Escola />}
        {!suspended && page === 'food' && <FoodAdmin />}
        {!suspended && page === 'recebimentos' && <Receive />}
        {!suspended && page === 'privacidade' && <PrivacySettings />}
        {page === 'faturas' && <Invoices onStatusChange={loadStatus} />}
      </main>
    </div>
  );
}

/** Operador de uma conta: loja (Daqui Entrega) ou Saúde (Daqui Prefeitura) */
function AccountLayout({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [kind, setKind] = useState<string | null>(null);
  useEffect(() => { api('/me').then((m) => setKind(m.account_kind ?? 'prefeitura')).catch(() => setKind('prefeitura')); }, []);
  if (!kind) return null;
  return kind === 'loja' ? <LojaLayout session={session} onLogout={onLogout} /> : <SaudeLayout session={session} onLogout={onLogout} />;
}

/** Loja que pede entregas pelo Daqui Entrega (e, com o Daqui Food ligado, restaurante com cardápio no app) */
function LojaLayout({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [food, setFood] = useState<boolean | null>(null);
  const [store, setStore] = useState('');
  useEffect(() => {
    api('/me').then((m) => setStore(m.account_name ?? '')).catch(() => {});
    api('/account/food').then((f) => setFood(!!f.enabled)).catch(() => setFood(false));
  }, []);
  if (food === null) return null;
  return <LojaMenu session={session} onLogout={onLogout} store={store} food={food} />;
}

function LojaMenu({ session, onLogout, store, food }: { session: Session; onLogout: () => void; store: string; food: boolean }) {
  const pages = [
    ...(food ? [['pedidos', 'Pedidos'], ['cardapio', 'Cardápio'], ['fixo', 'Entregador fixo'], ['restaurante', 'Restaurante']] : []),
    ['entregas', 'Entregas'], ['creditos', 'Créditos e extrato'], ['configuracoes', 'Configurações'],
  ] as [string, string][];
  const [page, setPage] = useState<string>(() => initialPage(pages.map((p) => p[0]), food ? 'pedidos' : 'entregas'));
  return (
    <div className="layout">
      <nav className="menu" aria-label="Menu principal">
        <div className="marca"><Wordmark size={30} /></div>
        <div className="cidade">{food ? 'Daqui Food' : 'Daqui Entrega'}</div>
        {pages.map(([id, label]) => (
          <button key={id} className={page === id ? 'ativo' : ''} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}>{label}</button>
        ))}
        <div className="rodape">
          <span>{session.name}{store ? ` · ${store}` : ''}</span>
          <button onClick={onLogout}>Sair</button>
        </div>
      </nav>
      <main className="conteudo">
        {page === 'pedidos' && <FoodOrders />}
        {page === 'cardapio' && <FoodMenu />}
        {page === 'fixo' && <FoodShifts />}
        {page === 'restaurante' && <FoodSettings />}
        {page === 'entregas' && <Deliveries />}
        {page === 'creditos' && <Credits />}
        {page === 'configuracoes' && <StoreSettings />}
      </main>
    </div>
  );
}

/** Central da Saúde (operador do convênio do Daqui Prefeitura) */
function SaudeLayout({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const pages = [['viagens', 'Viagens'], ['pacientes', 'Pacientes'], ['destinos', 'Destinos'], ['relatorio', 'Relatório do mês']] as const;
  type P = (typeof pages)[number][0];
  const [page, setPage] = useState<P>(() => initialPage(pages.map((p) => p[0]), 'viagens'));
  const [account, setAccount] = useState('');
  useEffect(() => { api('/me').then((m) => setAccount(m.account_name ?? '')).catch(() => {}); }, []);
  return (
    <div className="layout">
      <nav className="menu" aria-label="Menu principal">
        <div className="marca"><Wordmark size={30} /></div>
        <div className="cidade">Daqui Prefeitura</div>
        {pages.map(([id, label]) => (
          <button key={id} className={page === id ? 'ativo' : ''} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}>{label}</button>
        ))}
        <div className="rodape">
          <span>{session.name}{account ? ` · ${account}` : ''}</span>
          <button onClick={onLogout}>Sair</button>
        </div>
      </nav>
      <main className="conteudo">
        {page === 'viagens' && <Trips />}
        {page === 'pacientes' && <Patients />}
        {page === 'destinos' && <Places />}
        {page === 'relatorio' && <Report base="/account" />}
      </main>
    </div>
  );
}

function MasterLayout({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [page, setPage] = useState<'licenciados' | 'faturas'>(() => initialPage(['licenciados', 'faturas'] as const, 'licenciados'));
  return (
    <div className="layout">
      <nav className="menu" aria-label="Menu principal">
        <div className="marca"><Wordmark size={30} /></div>
        <div className="cidade">Painel master</div>
        {(['licenciados', 'faturas'] as const).map((p) => (
          <button key={p} className={page === p ? 'ativo' : ''} onClick={() => setPage(p)} aria-current={page === p ? 'page' : undefined}>
            {p === 'licenciados' ? 'Licenciados' : 'Faturas'}
          </button>
        ))}
        <div className="rodape">
          <span>{session.name}</span>
          <button onClick={onLogout}>Sair</button>
        </div>
      </nav>
      <main className="conteudo">{page === 'licenciados' ? <Master /> : <MasterInvoices />}</main>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [mode, setMode] = useState<'cidade' | 'master'>('cidade');
  const [tenant, setTenant] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  if (forgot) return <ForgotPassword initialTenant={tenant} onLogin={onLogin} onBack={() => setForgot(false)} />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/login', {
        method: 'POST',
        body: { tenant: mode === 'cidade' ? tenant.trim().toLowerCase() : undefined, phone, password },
      });
      if (!['tenant_admin', 'master', 'account_operator'].includes(r.user.role)) {
        throw new Error('Este acesso é só para a central do licenciado. Motoristas e passageiros usam o app.');
      }
      onLogin({ token: r.token, role: r.user.role, name: r.user.name, tenant: mode === 'cidade' ? tenant : undefined });
    } catch (e) {
      setError(e instanceof Error && !('status' in e) ? e.message : errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="caixa" onSubmit={submit}>
        <div className="marca"><Wordmark size={44} color="#12263A" /></div>
        <h1>Painel da central</h1>
        <div className="filtros" role="group" aria-label="Tipo de acesso">
          <button type="button" className={mode === 'cidade' ? 'ativo' : ''} onClick={() => setMode('cidade')}>Licenciado</button>
          <button type="button" className={mode === 'master' ? 'ativo' : ''} onClick={() => setMode('master')}>Master</button>
        </div>
        {mode === 'cidade' && (
          <label>Cidade (endereço do licenciado)
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="ex.: bauru" required autoComplete="organization" />
          </label>
        )}
        <label>Telefone
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="(14) 90000-0001" required autoComplete="tel" />
        </label>
        <label>Senha
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <div className="aviso erro" role="alert">{error}</div>}
        <button type="submit" className="destaque" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        {mode === 'cidade' && <button type="button" className="link" onClick={() => setForgot(true)}>Esqueci minha senha</button>}
      </form>
    </div>
  );
}

/** Senha nova com código por SMS ou WhatsApp (licenciado e operadores de convênio e lojas) */
function ForgotPassword({ initialTenant, onLogin, onBack }: { initialTenant: string; onLogin: (s: Session) => void; onBack: () => void }) {
  const [tenant, setTenant] = useState(initialTenant);
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = tenant.trim().toLowerCase();

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/code', { method: 'POST', body: { tenant: slug, phone, purpose: 'senha' } });
      setSent(true);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }

  async function reset(e: React.FormEvent) {
    e.preventDefault();
    if (!sent) { await send(); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/reset-password', { method: 'POST', body: { tenant: slug, phone, code, password } });
      if (!['tenant_admin', 'account_operator'].includes(r.user.role)) {
        throw new Error('Senha trocada. Esta conta é de motorista ou passageiro: entre pelo app com a senha nova.');
      }
      onLogin({ token: r.token, role: r.user.role, name: r.user.name, tenant: slug });
    } catch (e) {
      setError(e instanceof Error && !('status' in e) ? e.message : errMsg(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <form className="caixa" onSubmit={reset}>
        <div className="marca"><Wordmark size={44} color="#12263A" /></div>
        <h1>Criar uma senha nova</h1>
        <label>Cidade (endereço do licenciado)
          <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="ex.: bauru" required />
        </label>
        <label>Telefone da sua conta
          <input value={phone} onChange={(e) => { setPhone(e.target.value); setSent(false); }} inputMode="tel" placeholder="(14) 90000-0001" required autoComplete="tel" />
        </label>
        {sent && (
          <>
            <div className="aviso ok" role="status">Se este telefone tiver conta, o código chega por SMS ou WhatsApp em instantes. Ele vale por 10 minutos.</div>
            <label>Código de 6 números
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" required />
            </label>
            <label>Senha nova
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required autoComplete="new-password" />
            </label>
          </>
        )}
        {error && <div className="aviso erro" role="alert">{error}</div>}
        <button type="submit" className="destaque" disabled={busy}>
          {busy ? 'Aguarde…' : sent ? 'Salvar senha e entrar' : 'Enviar código'}
        </button>
        {sent && <button type="button" className="link" disabled={busy} onClick={send}>Reenviar código</button>}
        <button type="button" className="link" onClick={onBack}>Voltar para o login</button>
      </form>
    </div>
  );
}
