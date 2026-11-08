import { useEffect, useState } from 'react';
import { api, apiDownload } from '../api';
import { dateTime } from '../format';
import { Erro, errMsg, useLoad } from '../ui';

const FIELDS = [
  ['legalName', 'legal_name', 'Razão social', 'Mobilidade Exemplo Ltda'],
  ['cnpj', 'cnpj', 'CNPJ', '00.000.000/0000-00'],
  ['legalAddress', 'legal_address', 'Endereço da empresa', 'Rua, número, bairro, cidade/UF, CEP'],
  ['supportWhatsapp', 'support_whatsapp', 'WhatsApp de atendimento', '(14) 99999-0000'],
  ['supportEmail', 'support_email', 'E-mail de atendimento', 'atendimento@suaempresa.com.br'],
  ['dpoName', 'dpo_name', 'Encarregado de dados (DPO)', 'Nome de quem responde pelos dados'],
  ['dpoEmail', 'dpo_email', 'E-mail do encarregado', 'privacidade@suaempresa.com.br'],
] as const;

/** Licenciado: dados da empresa que aparecem na política de privacidade pública da cidade */
export default function PrivacySettings() {
  const p = useLoad(() => api('/admin/privacy'));
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (p.data) setF(Object.fromEntries(FIELDS.map(([k, col]) => [k, p.data[col] ?? ''])));
  }, [p.data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); p.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
    finally { setBusy(false); }
  }

  const d = p.data;
  const url = d ? (d.publicUrl.startsWith('/') ? window.location.origin + d.publicUrl : d.publicUrl) : '';

  return (
    <>
      <div className="topo">
        <div>
          <h1>Privacidade (LGPD)</h1>
          <p>A política de privacidade do app da sua cidade. Ela é obrigatória pela LGPD e exigida pela Apple e pelo Google para publicar o app.</p>
        </div>
      </div>
      <Erro msg={p.error} />
      {d && (
        <>
          <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2>Página pública</h2>
            {d.missing.length > 0
              ? <div className="aviso erro" role="status">Falta preencher: {d.missing.join(', ')}. Até lá, a página mostra um aviso de política incompleta.</div>
              : <div className="aviso ok" role="status">Completa. Use este endereço no cadastro do app na App Store e na Google Play.</div>}
            <div className="acoes" style={{ alignItems: 'center' }}>
              <code style={{ background: 'var(--areia-2)', padding: '8px 12px', borderRadius: 8, wordBreak: 'break-all' }}>{url}</code>
              <button className="secundario" onClick={() => { navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => {}); }}>
                {copied ? 'Copiado' : 'Copiar'}
              </button>
              <a href={url} target="_blank" rel="noreferrer">Abrir a página</a>
            </div>
            <p style={{ margin: 0, color: 'var(--texto-2)' }}>
              Termos de uso, montados com os mesmos dados:{' '}
              <a href={`/termos/${d.slug}/passageiro`} target="_blank" rel="noreferrer">do passageiro</a> ·{' '}
              <a href={`/termos/${d.slug}/motorista`} target="_blank" rel="noreferrer">do motorista</a>.
            </p>
            <p style={{ margin: 0, color: 'var(--texto-2)' }}>
              Versão {d.privacy_version}, de {new Date(`${String(d.privacy_updated_on).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR')}.
              {' '}{d.users.accepted} de {d.users.total} passageiros e motoristas aceitaram esta versão.
            </p>
          </section>

          <section className="cartao">
            <h2>Dados da sua empresa</h2>
            <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
              Sua empresa é a controladora dos dados dos passageiros e motoristas da cidade. A tecnologia aparece como operadora.
            </p>
            <div className="formulario">
              {FIELDS.map(([k, , label, ph]) => (
                <label key={k}>{label}
                  <input value={f[k] ?? ''} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })}
                    type={k.toLowerCase().includes('email') ? 'email' : 'text'} />
                </label>
              ))}
              <button disabled={busy} onClick={() => run(() => api('/admin/privacy', { method: 'PATCH', body: f }), 'Salvo. A página pública já mostra os dados novos.')}>
                Salvar
              </button>
            </div>
          </section>

          <section className="cartao">
            <h2>Publicar uma versão nova</h2>
            <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
              Faça isso quando a forma de usar os dados mudar (um serviço novo, um parceiro novo). Todos os passageiros e motoristas
              vão precisar aceitar de novo na próxima vez que abrirem o app. Corrigir um telefone ou e-mail não precisa de versão nova.
            </p>
            <button className="secundario" disabled={busy}
              onClick={() => run(() => api('/admin/privacy/new-version', { method: 'POST', body: {} }), 'Versão nova publicada. O app vai pedir o aceite.')}>
              Publicar versão {d.privacy_version + 1}
            </button>
          </section>
          <ExportCity onError={(text) => setMsg({ ok: false, text })} />
          {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}
        </>
      )}
    </>
  );
}

/** Planilhas com todos os dados da cidade (portabilidade prevista no contrato de licença) */
function ExportCity({ onError }: { onError: (msg: string) => void }) {
  const hist = useLoad(() => api('/admin/exports'));
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await apiDownload('/admin/export', `dados-da-cidade-${new Date().toISOString().slice(0, 10)}.zip`);
      hist.reload();
    } catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2>Exportar os dados da cidade</h2>
      <p style={{ margin: 0, color: 'var(--texto-2)' }}>
        Um arquivo ZIP com planilhas (abrem no Excel) de passageiros, motoristas, corridas, lojas e convênios, pacientes,
        comissões e mensalidades, e uma cópia em JSON. Não leva senhas, chaves do Mercado Pago nem fotos.
        Os arquivos têm dados pessoais: guarde em local seguro. Cada exportação fica registrada.
      </p>
      <div><button className="secundario" disabled={busy} onClick={go}>{busy ? 'Preparando…' : 'Baixar os dados (ZIP)'}</button></div>
      {hist.data?.exports.length > 0 && (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--texto-2)' }}>
          Últimas exportações: {hist.data.exports.slice(0, 5).map((e: any) => `${dateTime(e.created_at)} (${e.by_role === 'master' ? 'plataforma' : e.by_name ?? '—'})`).join(' · ')}
        </p>
      )}
    </section>
  );
}
