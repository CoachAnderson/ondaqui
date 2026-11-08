import { useState } from 'react';
import { api } from '../api';
import { Erro, Status, errMsg, useLoad } from '../ui';

/** Conta Mercado Pago da cidade: recebe as mensalidades dos motoristas direto do app */
export default function Receive() {
  const mp = useLoad(() => api('/admin/mercadopago'));
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const d = mp.data;

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api('/admin/mercadopago', { method: 'PUT', body: { accessToken: token.trim(), webhookSecret: secret.trim() || undefined } });
      setMsg({ ok: true, text: `Conta conectada: ${r.account}` });
      setToken('');
      setSecret('');
      mp.reload();
    } catch (err) {
      setMsg({ ok: false, text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm('Desconectar a conta? Os motoristas não vão mais conseguir pagar pelo app.')) return;
    await api('/admin/mercadopago', { method: 'DELETE' }).catch(() => {});
    mp.reload();
  }

  async function copy() {
    try { await navigator.clipboard.writeText(d.webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* sem permissão */ }
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Recebimentos</h1>
          <p>Conecte a conta Mercado Pago da sua central. A mensalidade dos motoristas cai direto nela, com Pix ou cartão.</p>
        </div>
      </div>
      <Erro msg={mp.error} />

      {d && (
        <section className="cartao">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <h2>Mercado Pago</h2>
            {d.connected
              ? <Status tone={d.testMode ? 'alerta' : 'ok'}>{d.testMode ? 'Conectado (modo teste)' : 'Conectado'}</Status>
              : <Status tone="neutra">Não conectado</Status>}
          </div>
          {d.connected && (
            <dl className="lista-dados" style={{ marginTop: 14 }}>
              <dt>Conta</dt><dd>{d.account}</dd>
              <dt>Access Token</dt><dd>{d.token}</dd>
              <dt>Assinatura secreta</dt><dd>{d.webhookSecretSet ? 'Configurada' : 'Não configurada (recomendado configurar)'}</dd>
            </dl>
          )}

          <form className="formulario" onSubmit={connect} style={{ marginTop: 18 }}>
            <label>Access Token de produção
              <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="APP_USR-…" required autoComplete="off" spellCheck={false} />
            </label>
            <label>Assinatura secreta dos webhooks
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="opcional, mas recomendado" autoComplete="off" spellCheck={false} />
            </label>
            <button type="submit" className="destaque" disabled={busy}>{busy ? 'Conferindo…' : d.connected ? 'Trocar conta' : 'Conectar conta'}</button>
          </form>
          {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status" style={{ marginTop: 12 }}>{msg.text}</div>}
          {d.connected && <button className="perigo" style={{ marginTop: 14 }} onClick={disconnect}>Desconectar</button>}
        </section>
      )}

      {d && (
        <section className="cartao">
          <h2>Como conectar (5 minutos)</h2>
          <ol style={{ lineHeight: 1.7, paddingLeft: 20, margin: '10px 0 0' }}>
            <li>Entre em <a href="https://www.mercadopago.com.br/developers/panel/app" target="_blank" rel="noreferrer">mercadopago.com.br/developers</a> com a conta da central e crie uma aplicação (produto: <strong>Checkout Pro</strong>).</li>
            <li>Em <strong>Credenciais de produção</strong>, copie o <strong>Access Token</strong> e cole acima. Para testar antes, use o Access Token de uma conta de teste.</li>
            <li>Em <strong>Webhooks → Configurar notificações</strong>, cole este endereço no modo produção e marque o evento <strong>Pagamentos</strong>:
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' }}>
                <code style={{ background: 'var(--areia-2)', padding: '6px 10px', borderRadius: 8, wordBreak: 'break-all' }}>{d.webhookUrl}</code>
                <button type="button" className="secundario" onClick={copy}>{copied ? 'Copiado' : 'Copiar'}</button>
              </div>
            </li>
            <li>Ainda em Webhooks, copie a <strong>assinatura secreta</strong> e cole no segundo campo. Com ela, o OnDaqui só aceita avisos que vieram mesmo do Mercado Pago.</li>
          </ol>
          <p style={{ color: 'var(--texto-2)', fontSize: 14, marginTop: 12 }}>
            O token fica guardado criptografado e só aparece aqui com os últimos 4 caracteres. Todo pagamento é conferido direto no Mercado Pago antes de liberar o plano do motorista.
          </p>
        </section>
      )}
    </>
  );
}
