import { useEffect, useState } from 'react';
import { api, apiImage } from '../api';
import { date, dateTime, driverStatus, money, phone } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

type Filter = 'pending' | 'approved' | 'blocked' | 'nota_baixa' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'pending', label: 'Aguardando aprovação' },
  { id: 'approved', label: 'Aprovados' },
  { id: 'blocked', label: 'Bloqueados' },
  { id: 'nota_baixa', label: 'Nota baixa' },
  { id: 'all', label: 'Todos' },
];

const today = () => new Date().toISOString().slice(0, 10);

function subscription(d: any, plans: any[]) {
  const plan = plans.find((p) => p.code === d.plan);
  if (!plan || plan.period_days === 0) return { tone: 'neutra' as const, text: `${plan?.name ?? d.plan}` };
  if (d.paidUntil && d.paidUntil >= today()) return { tone: 'ok' as const, text: `Pago até ${date(d.paidUntil)}` };
  if (d.trialUntil && d.trialUntil >= today()) return { tone: 'ok' as const, text: `Grátis até ${date(d.trialUntil)}` };
  return { tone: 'ruim' as const, text: 'Mensalidade em aberto' };
}

const VEHICLE: Record<string, string> = { carro: 'Carro', moto: 'Moto', utilitario: 'Utilitário (frete)' };
const OPT_LABEL: Record<string, string> = { entrega: 'Entregas', particular: 'Particular por hora', pet: 'Pet' };
const VERIFIED: { id: string; label: string; hint: string }[] = [
  { id: 'mulher', label: 'Daqui Mulher', hint: 'Motorista mulher conferida nos documentos. Atende só passageiras.' },
  { id: 'executivo', label: 'Daqui Executivo', hint: 'Carro mais novo, confortável e bem conservado, conferido pela central.' },
  { id: 'paciente', label: 'Daqui Prefeitura (pacientes)', hint: 'Treinado para transporte de pacientes do convênio da Saúde.' },
  { id: 'cadeirante', label: 'Veículo adaptado para cadeirante', hint: 'Recebe as viagens de pacientes cadeirantes.' },
  { id: 'escolar', label: 'Transporte escolar (Daqui Escola)', hint: 'Mais de 21 anos, CNH D, curso especializado e veículo vistoriado e autorizado (Detran e Prefeitura) conferidos.' },
];

/** Foto do perfil e do veículo: obrigatórias para trabalhar; o cliente só vê depois que a central aprova */
function Photos({ d, busy, onSave }: { d: any; busy: boolean; onSave: (body: object, ok: string) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      const next: Record<string, string> = {};
      const want: [string, string][] = [];
      if (d.hasPhoto) want.push(['perfil', `/admin/drivers/${d.id}/photo?which=perfil`]);
      if (d.hasVehiclePhoto) want.push(['veiculo', `/admin/drivers/${d.id}/photo?which=veiculo`]);
      if (d.pendingPhoto) want.push(['perfil-nova', `/admin/drivers/${d.id}/photo?which=perfil&versao=nova`]);
      if (d.pendingVehiclePhoto) want.push(['veiculo-nova', `/admin/drivers/${d.id}/photo?which=veiculo&versao=nova`]);
      for (const [k, path] of want) {
        try { const u = await apiImage(path); made.push(u); next[k] = u; } catch { /* sem foto */ }
      }
      if (alive) setUrls(next);
    })();
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [d.id, d.hasPhoto, d.hasVehiclePhoto, d.pendingPhoto, d.pendingVehiclePhoto, d.photoStatus, d.photoReview]);

  const approved = d.photoStatus === 'approved';
  const toReview = d.photoReview === 'pending';
  const [text, tone]: [string, 'ok' | 'alerta' | 'ruim' | 'neutra'] =
    toReview ? [approved ? 'Fotos novas para conferir' : 'Aguardando sua aprovação', 'alerta']
    : approved ? ['Aprovadas', 'ok']
    : d.photoReview === 'rejected' || d.photoStatus === 'rejected' ? ['Recusadas', 'ruim']
    : ['Não enviou', 'ruim'];
  const img = (k: string, alt: string, wide = false) =>
    urls[k] ? <img className="selfie" style={wide ? { width: 220 } : undefined} src={urls[k]} alt={alt} /> : null;

  return (
    <section>
      <h3>Fotos que o cliente vê <Status tone={tone}>{text}</Status></h3>
      <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>
        Obrigatórias: sem a foto do motorista e a do veículo aprovadas, ele não recebe corridas.
        Confira se é a mesma pessoa da CNH e o mesmo veículo da placa {d.vehicle?.plate}.
      </p>
      {approved && (
        <>
          <div style={{ fontSize: 13, color: 'var(--texto-2)', marginBottom: 6 }}>Aprovadas (o cliente vê estas)</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{img('perfil', `Foto aprovada de ${d.name}`)}{img('veiculo', 'Foto aprovada do veículo', true)}</div>
        </>
      )}
      {toReview && (
        <>
          <div style={{ fontSize: 13, color: 'var(--texto-2)', margin: '12px 0 6px' }}>Novas, para conferir</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {img(d.pendingPhoto ? 'perfil-nova' : 'perfil', `Foto nova de ${d.name}`)}
            {img(d.pendingVehiclePhoto ? 'veiculo-nova' : 'veiculo', 'Foto nova do veículo', true)}
          </div>
          {!approved && (!(d.pendingPhoto || d.hasPhoto) || !(d.pendingVehiclePhoto || d.hasVehiclePhoto)) && (
            <p style={{ color: 'var(--vermelho)', fontSize: 14 }}>Ainda falta {!(d.pendingPhoto || d.hasPhoto) ? 'a foto do motorista' : 'a foto do veículo'}.</p>
          )}
          <div className="acoes" style={{ marginTop: 12 }}>
            <button disabled={busy} onClick={() => onSave({ photoApproved: true }, 'Fotos aprovadas')}>Aprovar fotos</button>
            <button className="perigo" disabled={busy} onClick={() => onSave({ photoApproved: false }, approved
              ? 'Fotos novas recusadas: o cliente continua vendo as aprovadas'
              : 'Fotos recusadas: o motorista vai enviar outras')}>Recusar</button>
          </div>
        </>
      )}
      {!approved && !toReview && <p className="vazio" style={{ textAlign: 'left', padding: 0 }}>O motorista precisa enviar as fotos pelo app.</p>}
    </section>
  );
}

/** Tipo de veículo e serviços que só a central libera */
function Services({ d, busy, onSave }: { d: any; busy: boolean; onSave: (body: object, ok: string) => void }) {
  const [vehicle, setVehicle] = useState(d.vehicleType);
  const [verified, setVerified] = useState<string[]>(d.verified ?? []);
  useEffect(() => { setVehicle(d.vehicleType); setVerified(d.verified ?? []); }, [d.vehicleType, d.verified]);
  const toggle = (k: string) => setVerified((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]));
  return (
    <section>
      <h3>Serviços que atende</h3>
      <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>
        Entregas, Particular e Pet o motorista escolhe no app. Estes aqui só você libera, depois de conferir.
      </p>
      <label>Tipo de veículo
        <select value={vehicle} disabled={busy} onChange={(e) => setVehicle(e.target.value)}>
          {Object.entries(VEHICLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {vehicle === 'carro' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {VERIFIED.map((v) => (
            <label key={v.id} className="check" title={v.hint}>
              <input type="checkbox" checked={verified.includes(v.id)} onChange={() => toggle(v.id)} />
              <span>{v.label}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{v.hint}</span></span>
            </label>
          ))}
        </div>
      )}
      <div className="acoes" style={{ marginTop: 14 }}>
        <button className="secundario" disabled={busy}
          onClick={() => onSave({ vehicleType: vehicle, verified: vehicle === 'carro' ? verified : [] }, 'Serviços salvos')}>Salvar serviços</button>
      </div>
    </section>
  );
}

const statusTone = (s: string) => (s === 'approved' ? 'ok' : s === 'pending' ? 'alerta' : 'ruim');

export default function Drivers() {
  const [filter, setFilter] = useState<Filter>('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useLoad(() => api(`/admin/drivers${filter === 'all' ? '' : `?status=${filter}`}`), [filter]);
  const plans = useLoad(() => api('/admin/plans'));
  const planList = plans.data?.plans ?? [];

  return (
    <>
      <div className="topo">
        <div>
          <h1>Motoristas</h1>
          <p>Aprove cadastros, confira documentos e acompanhe a mensalidade de cada um.</p>
        </div>
      </div>
      <div className="filtros" role="group" aria-label="Filtrar motoristas">
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'ativo' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      <Erro msg={list.error} />
      <section className="cartao">
        {list.data && list.data.drivers.length === 0 && <p className="vazio">Nenhum motorista nesta lista.</p>}
        {list.data && list.data.drivers.length > 0 && (
          <div className="tabela">
            <table>
              <thead>
                <tr><th>Motorista</th><th>Veículo</th><th>Situação</th><th className="num">Nota</th><th>Plano</th><th>Pix</th><th>Agora</th></tr>
              </thead>
              <tbody>
                {list.data.drivers.map((d: any) => {
                  const sub = subscription(d, planList);
                  return (
                    <tr key={d.id} className="clicavel" onClick={() => setOpenId(d.id)}>
                      <td>
                        <button className="link" onClick={(e) => { e.stopPropagation(); setOpenId(d.id); }}>{d.name}</button>
                        <br /><span style={{ color: 'var(--texto-2)' }}>{phone(d.phone)}</span>
                      </td>
                      <td>{d.vehicle.model} {d.vehicle.color}<br /><span style={{ color: 'var(--texto-2)' }}>{d.vehicle.plate}</span></td>
                      <td><Status tone={statusTone(d.status)}>{driverStatus[d.status]}</Status></td>
                      <td className="num">
                        {d.rating ? <>
                          <span style={d.rating.low ? { color: 'var(--vermelho)', fontWeight: 700 } : undefined}>★ {d.rating.average.toFixed(2).replace('.', ',')}</span>
                          <br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{d.rating.ratings} aval.{d.rating.alertAt ? ' · avisado' : ''}</span>
                        </> : <span style={{ color: 'var(--texto-2)' }}>—</span>}
                      </td>
                      <td><Status tone={sub.tone}>{sub.text}</Status></td>
                      <td>{d.pix.validated ? <Status tone="ok">Validado</Status> : d.pix.key ? <Status tone="alerta">Conferir</Status> : <Status tone="neutra">Sem Pix</Status>}</td>
                      <td>{d.online ? <Status tone="ok">Online</Status> : <Status tone="neutra">Offline</Status>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {openId && (
        <DriverPanel id={openId} plans={planList} onClose={() => setOpenId(null)} onChanged={list.reload} />
      )}
    </>
  );
}

function DriverPanel({ id, plans, onClose, onChanged }: { id: string; plans: any[]; onClose: () => void; onChanged: () => void }) {
  const det = useLoad(() => api(`/admin/drivers/${id}`), [id]);
  const [selfie, setSelfie] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const d = det.data?.driver;
  const [docs, setDocs] = useState({ cnhEarOk: false, inssOk: false, criminalRecordOk: false, insuranceAppOk: false });

  useEffect(() => { if (d) setDocs(d.compliance); }, [d?.id, d?.compliance.cnhEarOk, d?.compliance.inssOk, d?.compliance.criminalRecordOk, d?.compliance.insuranceAppOk]);
  useEffect(() => {
    let url: string | null = null;
    if (d?.hasSelfie) apiImage(`/admin/drivers/${id}/selfie`).then((u) => { url = u; setSelfie(u); }).catch(() => setSelfie(null));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [id, d?.hasSelfie, d?.selfieCheckedAt]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function act(body: object | null, path = '', ok = 'Salvo') {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/admin/drivers/${id}${path}`, { method: path ? 'POST' : 'PATCH', body: body ?? {} });
      setMsg({ ok: true, text: ok });
      det.reload();
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const plan = plans.find((p) => p.code === d?.plan);

  return (
    <div className="lateral-fundo" onClick={onClose}>
      <aside className="lateral" role="dialog" aria-modal="true" aria-labelledby="t-motorista" onClick={(e) => e.stopPropagation()}>
        <div className="cabeca">
          <div>
            <h2 id="t-motorista">{d?.name ?? 'Motorista'}</h2>
            {d && <Status tone={statusTone(d.status)}>{driverStatus[d.status]}</Status>}
          </div>
          <button className="secundario" onClick={onClose} aria-label="Fechar">Fechar</button>
        </div>
        <Erro msg={det.error} />
        {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}
        {d && (
          <>
            <dl className="lista-dados">
              <dt>Telefone</dt><dd>{phone(d.phone)}</dd>
              <dt>Veículo</dt><dd>{d.vehicle.model} {d.vehicle.color} · {d.vehicle.plate}</dd>
              <dt>Tipo de veículo</dt><dd>{VEHICLE[d.vehicleType] ?? d.vehicleType}</dd>
              <dt>Atende também</dt><dd>{(d.services ?? []).map((s: string) => OPT_LABEL[s] ?? s).join(', ') || '—'}</dd>
              <dt>Cadastro</dt><dd>{dateTime(d.createdAt)}</dd>
              <dt>Corridas</dt><dd>{det.data.stats.rides}{det.data.stats.rating ? ` · nota ${det.data.stats.rating}` : ''}</dd>
              <dt>Selfie do turno</dt><dd>{d.selfieCheckedAt ? dateTime(d.selfieCheckedAt) : 'Nunca enviada'}</dd>
            </dl>
            {selfie && <img className="selfie" src={selfie} alt={`Selfie mais recente de ${d.name}`} />}

            <section>
              <h3>Documentos exigidos por lei</h3>
              <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>Confira cada um antes de aprovar.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label className="check"><input type="checkbox" checked={docs.cnhEarOk} onChange={(e) => setDocs({ ...docs, cnhEarOk: e.target.checked })} />CNH com “exerce atividade remunerada”</label>
                <label className="check"><input type="checkbox" checked={docs.inssOk} onChange={(e) => setDocs({ ...docs, inssOk: e.target.checked })} />Inscrito no INSS</label>
                <label className="check"><input type="checkbox" checked={docs.criminalRecordOk} onChange={(e) => setDocs({ ...docs, criminalRecordOk: e.target.checked })} />Certidão de antecedentes criminais</label>
                <label className="check"><input type="checkbox" checked={docs.insuranceAppOk} onChange={(e) => setDocs({ ...docs, insuranceAppOk: e.target.checked })} />Seguro APP (acidentes pessoais a passageiros)</label>
              </div>
              <div className="acoes" style={{ marginTop: 14 }}>
                <button className="secundario" disabled={busy} onClick={() => act(docs, '', 'Documentos salvos')}>Salvar documentos</button>
                {d.status !== 'approved' && <button className="destaque" disabled={busy} onClick={() => act({ ...docs, status: 'approved' }, '', 'Motorista aprovado')}>Aprovar</button>}
                {d.status === 'pending' && <button className="perigo" disabled={busy} onClick={() => act({ status: 'rejected' }, '', 'Cadastro recusado')}>Recusar</button>}
                {d.status === 'approved' && <button className="perigo" disabled={busy} onClick={() => act({ status: 'blocked' }, '', 'Motorista bloqueado')}>Bloquear</button>}
              </div>
            </section>

            <Photos d={d} busy={busy} onSave={(body, ok) => act(body, '', ok)} />

            {d.camera && (
              <section>
                <h3>Câmera de segurança</h3>
                <p style={{ color: 'var(--texto-2)', margin: '4px 0 10px' }}>
                  O motorista declarou que {d.camera.kind === 'video_audio' ? 'grava vídeo e áudio' : 'grava vídeo'} e assumiu os compromissos de uso.
                  Os passageiros já são avisados antes do embarque. Confira se há adesivo de aviso visível no carro.
                </p>
                <div className="acoes" style={{ alignItems: 'center' }}>
                  {d.camera.status === 'approved' ? <Status tone="ok">Conferida</Status> : d.camera.status === 'rejected' ? <Status tone="ruim">Barrada</Status> : <Status tone="alerta">Para conferir</Status>}
                  {d.camera.status !== 'approved' && <button disabled={busy} onClick={() => act({ cameraApproved: true }, '', 'Câmera conferida')}>Conferida</button>}
                  {d.camera.status !== 'rejected' && <button className="perigo" disabled={busy} onClick={() => act({ cameraApproved: false }, '', 'Câmera barrada: o aviso some e o motorista não pode gravar')}>Barrar</button>}
                </div>
              </section>
            )}

            <Services d={d} busy={busy} onSave={(body, ok) => act(body, '', ok)} />

            <section>
              <h3>Pix do motorista (antigolpe)</h3>
              <p style={{ color: 'var(--texto-2)', margin: '4px 0 12px' }}>
                O passageiro só vê o Pix depois que você confirmar que o titular da chave é o próprio motorista.
              </p>
              {d.pix.key ? (
                <dl className="lista-dados">
                  <dt>Chave</dt><dd>{d.pix.key}</dd>
                  <dt>Titular informado</dt><dd>{d.pix.holderName ?? '—'}</dd>
                </dl>
              ) : <p className="vazio" style={{ textAlign: 'left', padding: 0 }}>Motorista não cadastrou chave Pix.</p>}
              {d.pix.key && (
                <div className="acoes" style={{ marginTop: 12 }}>
                  {d.pix.validated
                    ? <button className="perigo" disabled={busy} onClick={() => act({ pixValidated: false }, '', 'Validação do Pix removida')}>Remover validação</button>
                    : <button disabled={busy} onClick={() => act({ pixValidated: true }, '', 'Pix validado')}>Validar Pix</button>}
                </div>
              )}
            </section>

            <section>
              <h3>Plano e mensalidade</h3>
              <div className="formulario" style={{ marginTop: 10 }}>
                <label>Plano
                  <select value={d.plan} disabled={busy} onChange={(e) => act({ planCode: e.target.value }, '', 'Plano alterado')}>
                    {plans.map((p) => <option key={p.code} value={p.code}>{p.name}{p.price_cents ? ` · ${money(p.price_cents)}` : ''}</option>)}
                  </select>
                </label>
                {plan && plan.period_days > 0 && (
                  <button disabled={busy} onClick={() => act({ periods: 1 }, '/payments', 'Pagamento registrado')}>
                    Registrar pagamento ({money(plan.price_cents)})
                  </button>
                )}
              </div>
              <dl className="lista-dados" style={{ marginTop: 12 }}>
                <dt>Mês grátis até</dt><dd>{date(d.trialUntil)}</dd>
                <dt>Pago até</dt><dd>{date(d.paidUntil)}</dd>
              </dl>
              {det.data.payments.length > 0 && (
                <div className="tabela" style={{ marginTop: 12 }}>
                  <table>
                    <thead><tr><th>Pago em</th><th>Período</th><th className="num">Valor</th></tr></thead>
                    <tbody>
                      {det.data.payments.map((p: any) => (
                        <tr key={p.paid_at}><td>{dateTime(p.paid_at)}</td><td>{date(p.period_start)} a {date(p.period_end)}</td><td className="num">{money(p.amount_cents)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}
