import { useEffect, useMemo, useState } from 'react';
import RideChat from '../RideChat';
import { api, apiDownload } from '../api';
import { useRealtime } from '../realtime';
import { dateTime, money, phone as fmtPhone, rideStatus } from '../format';
import { Erro, Status, errMsg, rideTone, useLoad } from '../ui';
import PlacePicker, { type PickedPlace } from '../PlacePicker';
import DriverPhoto from '../DriverPhoto';

/*
 * Daqui Prefeitura — painel da central da Saúde (operador do convênio).
 * Agenda viagens de pacientes, acompanha ao vivo e tira o relatório do mês.
 */

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

function useMsg() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const Box = () => (msg ? <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div> : null);
  return { setMsg, Box };
}

// ===================== viagens =====================

export function Trips() {
  const [view, setView] = useState<'ativas' | 'agendadas' | 'dia'>('ativas');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const list = useLoad(() => api(`/account/trips?view=${view}${view === 'dia' ? `&day=${day}` : ''}`), [view, day]);
  const { setMsg, Box } = useMsg();
  const [form, setForm] = useState(false);
  useRealtime('ride:updated', () => list.reload());

  async function act(path: string, ok: string) {
    setMsg(null);
    try { await api(path, { method: 'POST', body: {} }); setMsg({ ok: true, text: ok }); list.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  }

  const trips = list.data?.trips ?? [];
  return (
    <>
      <div className="topo">
        <div>
          <h1>Viagens de pacientes</h1>
          <p>Agende ida e volta, acompanhe o motorista e chame a volta quando o paciente for liberado.</p>
        </div>
        <button className="destaque" onClick={() => setForm(!form)}>{form ? 'Fechar' : 'Agendar viagem'}</button>
      </div>
      {form && <NewTrip onCreated={() => { setForm(false); list.reload(); setMsg({ ok: true, text: 'Viagem agendada.' }); }} />}
      <Box />
      <div className="filtros" role="group" aria-label="Filtrar viagens">
        {([['ativas', 'Em andamento'], ['agendadas', 'Agendadas'], ['dia', 'Por dia']] as const).map(([k, l]) => (
          <button key={k} className={view === k ? 'ativo' : ''} onClick={() => setView(k)}>{l}</button>
        ))}
        {view === 'dia' && <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Dia" style={{ maxWidth: 180 }} />}
      </div>
      <Erro msg={list.error} />
      <section className="cartao">
        {list.data && trips.length === 0 && <p className="vazio">Nenhuma viagem aqui.</p>}
        {trips.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Horário</th><th>Paciente</th><th>Trajeto</th><th>Situação</th><th>Motorista</th><th className="num">Valor</th><th></th></tr></thead>
              <tbody>
                {trips.map((t: any) => (
                  <tr key={t.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dateTime(t.scheduledFor ?? t.requestedAt)}{t.returnOf && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>volta</span></>}</td>
                    <td>
                      <strong>{t.patient?.name}</strong>
                      <br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>
                        {[t.patient?.wheelchair && 'cadeirante', t.patient?.companion && 'com acompanhante'].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </td>
                    <td>{t.origin.address}<br /><span style={{ color: 'var(--texto-2)' }}>→ {t.destination.address}</span></td>
                    <td><Status tone={rideTone(t.status)}>{rideStatus[t.status]}</Status></td>
                    <td>{t.driver ? <>{t.driver.name}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{t.driver.vehicle.model} {t.driver.vehicle.color} · {t.driver.vehicle.plate}{t.driver.phone ? ` · ${fmtPhone(t.driver.phone)}` : ''}</span>
                      {t.driver.hasPhoto && ['accepted', 'arrived', 'in_progress'].includes(t.status) && <><br /><DriverPhoto tripId={t.id} name={t.driver.name} plate={t.driver.vehicle.plate} /></>}
                      {t.driver.camera && <><br /><span style={{ fontSize: 13, color: 'var(--texto-2)' }}>Câmera no veículo ({t.driver.camera === 'video_audio' ? 'vídeo e áudio' : 'vídeo'}): avise o paciente</span></>}</> : '—'}</td>
                    <td className="num">{money(t.priceCents)}</td>
                    <td>
                      <span className="acoes">
                        {t.driver && <RideChat rideId={t.id} label="Falar com o motorista" />}
                        {t.status === 'completed' && !t.returnOf && (
                          <button className="secundario" onClick={() => act(`/account/trips/${t.id}/return`, 'Volta pedida: já estamos chamando um motorista.')}>Chamar volta</button>
                        )}
                        {['scheduled', 'requested', 'accepted', 'arrived'].includes(t.status) && (
                          <button className="perigo" onClick={() => window.confirm(`Cancelar a viagem de ${t.patient?.name}?`) && act(`/account/trips/${t.id}/cancel`, 'Viagem cancelada.')}>Cancelar</button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function NewTrip({ onCreated }: { onCreated: () => void }) {
  const patients = useLoad(() => api('/account/patients'));
  const places = useLoad(() => api('/account/places'));
  const [q, setQ] = useState('');
  const [patientId, setPatientId] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [other, setOther] = useState<PickedPlace | null>(null);
  const [when, setWhen] = useState<'agora' | 'agendar'>('agendar');
  const [at, setAt] = useState(toLocalInput(new Date(Date.now() + 24 * 3600_000)));
  const [back, setBack] = useState<'depois' | 'agendar' | 'nao'>('depois');
  const [backAt, setBackAt] = useState('');
  const [companion, setCompanion] = useState(false);
  const [wheelchair, setWheelchair] = useState(false);
  const [notes, setNotes] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = patients.data?.patients ?? [];
  const filtered = useMemo(() => list.filter((p: any) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.phone.includes(q)), [list, q]);
  const patient = list.find((p: any) => p.id === patientId);
  const place = (places.data?.places ?? []).find((p: any) => p.id === placeId);
  const destination = placeId === 'outro' ? other : place ? { lat: place.lat, lng: place.lng, address: place.address, name: place.name } : null;

  useEffect(() => {
    if (!patient) return;
    setCompanion(patient.needsCompanion);
    setWheelchair(patient.wheelchair);
    setNotes(patient.notes ?? '');
  }, [patient]);

  useEffect(() => {
    if (!patient || !destination) { setQuote(null); return; }
    api('/account/trips/quote', { method: 'POST', body: { patientId, destination } }).then(setQuote).catch(() => setQuote(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, placeId, other?.lat, other?.lng]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!patient || !destination) return;
    setBusy(true);
    setError(null);
    try {
      await api('/account/trips', {
        method: 'POST',
        body: {
          patientId, destination, companion, wheelchair, notes: notes.trim() || undefined,
          scheduledFor: when === 'agendar' ? fromLocalInput(at) : undefined,
          returnAt: back === 'agendar' ? fromLocalInput(backAt) : undefined,
        },
      });
      onCreated();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cartao">
      <h2>Agendar viagem</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
        <div className="formulario">
          <label>Buscar paciente<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou telefone" /></label>
          <label>Paciente
            <select value={patientId} onChange={(e) => setPatientId(e.target.value)} required>
              <option value="">Escolha…</option>
              {filtered.map((p: any) => <option key={p.id} value={p.id}>{p.name} · {fmtPhone(p.phone)}</option>)}
            </select>
          </label>
          <label>Destino
            <select value={placeId} onChange={(e) => setPlaceId(e.target.value)} required>
              <option value="">Escolha…</option>
              {(places.data?.places ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="outro">Outro endereço…</option>
            </select>
          </label>
        </div>
        {patient && <p style={{ margin: 0, color: 'var(--texto-2)' }}>Saída: {patient.home.address}</p>}
        {placeId === 'outro' && <PlacePicker value={other} onChange={setOther} label="Endereço de destino" />}

        <div className="formulario">
          <label>Ida
            <select value={when} onChange={(e) => setWhen(e.target.value as any)}>
              <option value="agendar">Agendar</option>
              <option value="agora">Agora</option>
            </select>
          </label>
          {when === 'agendar' && <label>Data e hora da ida<input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required /></label>}
          <label>Volta
            <select value={back} onChange={(e) => setBack(e.target.value as any)}>
              <option value="depois">Chamar quando for liberado</option>
              <option value="agendar">Agendar horário</option>
              <option value="nao">Sem volta</option>
            </select>
          </label>
          {back === 'agendar' && <label>Data e hora da volta<input type="datetime-local" value={backAt} onChange={(e) => setBackAt(e.target.value)} required /></label>}
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <label className="check"><input type="checkbox" checked={companion} onChange={(e) => setCompanion(e.target.checked)} />Vai com acompanhante</label>
          <label className="check"><input type="checkbox" checked={wheelchair} onChange={(e) => setWheelchair(e.target.checked)} />Cadeirante (veículo adaptado)</label>
        </div>
        <label>Observações para o motorista<input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></label>
        {quote && (
          <p style={{ margin: 0 }}>
            <strong>{money(quote.priceCents)}</strong> por trecho · {quote.distanceKm} km · cerca de {quote.durationMin} min
            {back !== 'nao' && <> · ida e volta: <strong>{money(quote.roundTripCents)}</strong></>}
          </p>
        )}
        {error && <div className="aviso erro" role="alert">{error}</div>}
        <div><button type="submit" className="destaque" disabled={busy || !patient || !destination}>{busy ? 'Agendando…' : when === 'agora' ? 'Pedir agora' : 'Agendar'}</button></div>
      </form>
    </section>
  );
}

// ===================== pacientes =====================

export function Patients() {
  const [q, setQ] = useState('');
  const list = useLoad(() => api(`/account/patients?q=${encodeURIComponent(q)}`), [q]);
  const [editing, setEditing] = useState<any | 'novo' | null>(null);
  return (
    <>
      <div className="topo">
        <div>
          <h1>Pacientes</h1>
          <p>Cadastro com endereço, telefone e necessidades. O motorista vê só o que precisa para a viagem.</p>
        </div>
        <button className="destaque" onClick={() => setEditing('novo')}>Novo paciente</button>
      </div>
      {editing && <PatientForm p={editing === 'novo' ? null : editing} onDone={() => { setEditing(null); list.reload(); }} />}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, telefone ou documento" aria-label="Buscar paciente" style={{ maxWidth: 420 }} />
      <Erro msg={list.error} />
      <section className="cartao">
        {list.data && list.data.patients.length === 0 && <p className="vazio">Nenhum paciente.</p>}
        {list.data?.patients.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Paciente</th><th>Telefone</th><th>Endereço</th><th>Necessidades</th><th></th></tr></thead>
              <tbody>
                {list.data.patients.map((p: any) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong>{p.document && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{p.document}</span></>}</td>
                    <td>{fmtPhone(p.phone)}</td>
                    <td>{p.home.address}</td>
                    <td>{[p.wheelchair && 'cadeirante', p.needsCompanion && 'acompanhante'].filter(Boolean).join(' · ') || '—'}{p.notes && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{p.notes}</span></>}</td>
                    <td><button className="secundario" onClick={() => setEditing(p)}>Editar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function PatientForm({ p, onDone }: { p: any | null; onDone: () => void }) {
  const [f, setF] = useState({
    name: p?.name ?? '', phone: p?.phone ?? '', document: p?.document ?? '', notes: p?.notes ?? '',
    wheelchair: p?.wheelchair ?? false, needsCompanion: p?.needsCompanion ?? false,
  });
  const [home, setHome] = useState<PickedPlace | null>(p?.home ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!home) { setError('Marque o endereço do paciente'); return; }
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, document: f.document || undefined, notes: f.notes || undefined, home };
      await api(p ? `/account/patients/${p.id}` : '/account/patients', { method: p ? 'PATCH' : 'POST', body });
      onDone();
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <section className="cartao">
      <h2>{p ? `Editar ${p.name}` : 'Novo paciente'}</h2>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
        <div className="formulario">
          <label>Nome completo<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={3} /></label>
          <label>Telefone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" required /></label>
          <label>Cartão SUS ou CPF<input value={f.document} onChange={(e) => setF({ ...f, document: e.target.value })} /></label>
        </div>
        <PlacePicker value={home} onChange={setHome} label="Endereço de casa" />
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <label className="check"><input type="checkbox" checked={f.wheelchair} onChange={(e) => setF({ ...f, wheelchair: e.target.checked })} />Cadeirante</label>
          <label className="check"><input type="checkbox" checked={f.needsCompanion} onChange={(e) => setF({ ...f, needsCompanion: e.target.checked })} />Precisa de acompanhante</label>
        </div>
        <label>Observações (aparece para o motorista)<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} /></label>
        {error && <div className="aviso erro" role="alert">{error}</div>}
        <div className="acoes">
          <button type="submit" className="destaque" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
          <button type="button" className="secundario" onClick={onDone}>Cancelar</button>
          {p && <button type="button" className="perigo" onClick={async () => {
            if (!window.confirm(`Desativar ${p.name}?`)) return;
            await api(`/account/patients/${p.id}`, { method: 'PATCH', body: { active: false } }).catch(() => {});
            onDone();
          }}>Desativar</button>}
        </div>
      </form>
    </section>
  );
}

// ===================== destinos frequentes =====================

export function Places() {
  const list = useLoad(() => api('/account/places'));
  const [name, setName] = useState('');
  const [place, setPlace] = useState<PickedPlace | null>(null);
  const { setMsg, Box } = useMsg();

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!place) return;
    try {
      await api('/account/places', { method: 'POST', body: { name, ...place } });
      setName(''); setPlace(null); list.reload();
      setMsg({ ok: true, text: 'Destino salvo.' });
    } catch (err) { setMsg({ ok: false, text: errMsg(err) }); }
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Destinos frequentes</h1>
          <p>Hospitais, UBS, clínicas e laboratórios. Aparecem prontos na hora de agendar.</p>
        </div>
      </div>
      <Box />
      <section className="cartao">
        {list.data?.places.length === 0 && <p className="vazio">Nenhum destino salvo.</p>}
        {list.data?.places.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Nome</th><th>Endereço</th><th></th></tr></thead>
              <tbody>
                {list.data.places.map((p: any) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td><td>{p.address}</td>
                    <td><button className="perigo" onClick={async () => { await api(`/account/places/${p.id}`, { method: 'DELETE' }).catch(() => {}); list.reload(); }}>Remover</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="cartao">
        <h2>Novo destino</h2>
        <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <label>Nome<input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Hospital de Base" required minLength={2} /></label>
          <PlacePicker value={place} onChange={setPlace} />
          <div><button type="submit" className="destaque" disabled={!place || name.trim().length < 2}>Salvar destino</button></div>
        </form>
      </section>
    </>
  );
}

// ===================== relatório (operador e licenciado) =====================

export function Report({ base, title }: { base: string; title?: string }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const rep = useLoad(() => api(`${base}/report?month=${month}`), [base, month]);
  const [error, setError] = useState<string | null>(null);
  const d = rep.data;
  return (
    <>
      <div className="topo">
        <div>
          <h1>{title ?? 'Relatório do mês'}</h1>
          <p>Viagens concluídas no mês, para a prestação de contas e o pagamento da central.</p>
        </div>
        <span className="acoes">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mês" />
          <button className="secundario" onClick={() => apiDownload(`${base}/report.csv?month=${month}`, `pacientes-${month}.csv`).catch((e) => setError(errMsg(e)))}>
            Baixar planilha
          </button>
        </span>
      </div>
      <Erro msg={rep.error ?? error} />
      {d && (
        <section className="cartao grade-kpi">
          <div className="kpi"><span className="rotulo">Viagens</span><span className="valor">{d.trips}</span><span className="nota">{d.cancelled} canceladas</span></div>
          <div className="kpi"><span className="rotulo">Pacientes atendidos</span><span className="valor">{d.patients}</span></div>
          <div className="kpi"><span className="rotulo">Quilômetros</span><span className="valor">{String(d.distanceKm).replace('.', ',')}</span></div>
          <div className="kpi"><span className="rotulo">Valor do mês</span><span className="valor">{money(d.totalCents)}</span></div>
        </section>
      )}
      {d?.byDriver.length > 0 && (() => { const internal = d.byDriver.some((b: any) => b.netCents !== undefined); return (
        <section className="cartao">
          <h2>Por motorista (repasse)</h2>
          <div className="tabela" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Motorista</th><th>Placa</th><th className="num">Viagens</th><th className="num">Valor</th>
                {internal && <><th className="num">Comissão do plano</th><th className="num">Repassar ao motorista</th></>}</tr></thead>
              <tbody>{d.byDriver.map((b: any) => (
                <tr key={b.driver + b.plate}><td>{b.driver}</td><td>{b.plate}</td><td className="num">{b.trips}</td><td className="num">{money(b.totalCents)}</td>
                  {internal && <><td className="num">{money(b.commissionCents ?? 0)}</td><td className="num"><strong>{money(b.netCents ?? b.totalCents)}</strong></td></>}</tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ); })()}
      {d && (
        <section className="cartao">
          <h2>Viagens</h2>
          {d.rows.length === 0 && <p className="vazio">Nenhuma viagem concluída neste mês.</p>}
          {d.rows.length > 0 && (
            <div className="tabela" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Data</th><th>Paciente</th><th>Trajeto</th><th>Motorista</th><th className="num">Km</th><th className="num">Valor</th></tr></thead>
                <tbody>
                  {d.rows.map((r: any) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{dateTime(r.completed_at)}</td>
                      <td>{r.patient}</td>
                      <td>{r.origin_address}<br /><span style={{ color: 'var(--texto-2)' }}>→ {r.dest_address}</span></td>
                      <td>{r.driver} · {r.vehicle_plate}</td>
                      <td className="num">{String(r.distance_km).replace('.', ',')}</td>
                      <td className="num">{money(r.price_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
