import { useEffect, useState } from 'react';
import { api } from '../api';
import { money, phone as fmtPhone } from '../format';
import { useRealtime } from '../realtime';
import { Erro, Status, errMsg, useLoad } from '../ui';
import PlacePicker, { type PickedPlace } from '../PlacePicker';

const DAY = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const LEG: Record<string, string> = { ida_volta: 'Ida e volta', ida: 'Só ida', volta: 'Só volta' };
const TRIP: Record<string, [string, 'ok' | 'alerta' | 'ruim' | 'neutra']> = {
  previsto: ['A buscar', 'neutra'], embarcou: ['No carro', 'alerta'], entregue: ['Entregue', 'ok'], ausente: ['Não foi', 'ruim'], cancelado: ['Cancelada', 'neutra'],
};
const toCents = (v: string) => Math.round(Number(v.replace(/\./g, '').replace(',', '.')) * 100);
const reais = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const day = (d: string | null) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR') : '');
const thisMonth = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);

/**
 * Daqui Escola: a central liga o serviço, cadastra as escolas, escolhe o motorista de cada pedido (só os liberados
 * para transporte escolar), acompanha o dia, registra pagamentos e repassa ao motorista no fim do mês.
 */
export default function Escola() {
  const [mes, setMes] = useState(thisMonth());
  const e = useLoad(() => api(`/admin/escola?mes=${mes}`), [mes]);
  useRealtime('escola:request', () => e.reload());
  useRealtime('escola:paid', () => e.reload());
  const [f, setF] = useState({ base: '', km: '', pct: '', grace: '' });
  const [school, setSchool] = useState<{ name: string; place: PickedPlace | null }>({ name: '', place: null });
  const [off, setOff] = useState({ from: '', to: '', note: '' });
  const [pick, setPick] = useState<Record<string, { driver: string; price: string }>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const r = e.data?.rules;
    if (r) setF({ base: reais(r.baseCents), km: reais(r.perKmCents), pct: String(r.commissionPct).replace('.', ','), grace: String(r.graceDays) });
  }, [e.data]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); e.reload(); }
    catch (err) { setMsg({ ok: false, text: errMsg(err) }); }
    finally { setBusy(null); }
  }

  const d = e.data;
  const r = d?.rules;
  const requests = (d?.contracts ?? []).filter((c: any) => c.status === 'solicitado');
  const contracts = (d?.contracts ?? []).filter((c: any) => c.status === 'ativo' || c.status === 'pausado');
  const today = d?.today ?? [];
  const settings = (enabled?: boolean) => ({
    ...(enabled !== undefined ? { enabled } : {}),
    baseCents: toCents(f.base), perKmCents: toCents(f.km), commissionPct: Number(f.pct.replace(',', '.')) || 0, graceDays: Number(f.grace) || 0,
  });

  function assignControls(c: any) {
    const p = pick[c.id] ?? { driver: c.driver?.id ?? '', price: reais(c.monthlyCents) };
    return (
      <div className="acoes" style={{ alignItems: 'center' }}>
        <select value={p.driver} onChange={(ev) => setPick({ ...pick, [c.id]: { ...p, driver: ev.target.value } })} aria-label="Motorista">
          <option value="">Escolha o motorista</option>
          {d.drivers.map((x: any) => <option key={x.id} value={x.id}>{x.name} · {x.vehicle_model} ({x.students} alunos)</option>)}
        </select>
        <input style={{ width: 90 }} inputMode="decimal" value={p.price} aria-label="Mensalidade (R$)"
          onChange={(ev) => setPick({ ...pick, [c.id]: { ...p, price: ev.target.value } })} />
        <button disabled={!p.driver || busy === c.id}
          onClick={() => run(c.id, () => api(`/admin/escola/contracts/${c.id}/assign`, { method: 'POST', body: { driverId: p.driver, monthlyCents: toCents(p.price) } }),
            'Motorista definido. Os pais e o motorista foram avisados.')}>{c.driver ? 'Trocar' : 'Confirmar'}</button>
      </div>
    );
  }

  return (
    <>
      <div className="topo">
        <div>
          <h1>Daqui Escola</h1>
          <p>
            Transporte escolar com motorista fixo. Os pais pedem e pagam pelo app; você escolhe o motorista, que precisa estar liberado
            para escolar (mais de 21 anos, CNH D, curso especializado e veículo vistoriado e autorizado pelo Detran e pela Prefeitura).
            Todo dia de aula as viagens aparecem para o motorista, e os pais recebem aviso no embarque e na chegada.
          </p>
        </div>
      </div>
      <Erro msg={e.error} />
      {d && (
        <section className="grade-kpi">
          <div className="cartao kpi"><span className="rotulo">Alunos</span><span className="valor">{contracts.filter((c: any) => c.status === 'ativo').length}</span><span className="nota">{d.drivers.length} {d.drivers.length === 1 ? 'motorista liberado' : 'motoristas liberados'}</span></div>
          <div className="cartao kpi"><span className="rotulo">Pedidos aguardando</span><span className="valor" style={{ color: requests.length ? 'var(--laranja-escuro)' : undefined }}>{requests.length}</span></div>
          <div className="cartao kpi"><span className="rotulo">Mensalidades vencidas</span><span className="valor" style={{ color: contracts.some((c: any) => c.overdue) ? 'var(--vermelho)' : undefined }}>{contracts.filter((c: any) => c.overdue).length}</span></div>
          <div className="cartao kpi"><span className="rotulo">Viagens hoje</span><span className="valor">{today.filter((t: any) => t.status === 'entregue').length} / {today.filter((t: any) => t.status !== 'cancelado').length}</span><span className="nota">entregues</span></div>
        </section>
      )}
      {msg && <div className={`aviso ${msg.ok ? 'ok' : 'erro'}`} role="status">{msg.text}</div>}

      {r && (
        <section className="cartao">
          <h2>Preços e regras {r.enabled ? <Status tone="ok">Ligado</Status> : <Status tone="neutra">Desligado</Status>}</h2>
          {!d.mercadopago && <div className="aviso erro" role="status" style={{ margin: '8px 0' }}>Conecte o Mercado Pago em Recebimentos para os pais pagarem pelo app. Sem ele, registre os pagamentos aqui.</div>}
          <p style={{ color: 'var(--texto-2)', margin: '4px 0 16px' }}>
            Mensalidade = base + valor por km da casa até a escola (ida e volta, 5 dias). Só ida ou só volta: 60%. Menos dias: proporcional.
            Você pode ajustar o valor de cada aluno ao escolher o motorista.
          </p>
          <div className="formulario">
            <label>Base por mês (R$)<input inputMode="decimal" value={f.base} onChange={(ev) => setF({ ...f, base: ev.target.value })} /></label>
            <label>Por km, por mês (R$)<input inputMode="decimal" value={f.km} onChange={(ev) => setF({ ...f, km: ev.target.value })} /></label>
            <label>Comissão da central (%)<input inputMode="decimal" value={f.pct} onChange={(ev) => setF({ ...f, pct: ev.target.value })} /></label>
            <label>Tolerância depois do vencimento (dias)<input inputMode="numeric" value={f.grace} onChange={(ev) => setF({ ...f, grace: ev.target.value })} /></label>
            <button disabled={busy === 'regras'} onClick={() => run('regras', () => api('/admin/escola', { method: 'PATCH', body: settings() }), 'Regras salvas.')}>Salvar</button>
            {r.enabled
              ? <button className="secundario" onClick={() => window.confirm('Desligar o Daqui Escola? As viagens param de ser montadas.') && run('regras', () => api('/admin/escola', { method: 'PATCH', body: { enabled: false } }), 'Desligado.')}>Desligar</button>
              : <button className="destaque" onClick={() => run('regras', () => api('/admin/escola', { method: 'PATCH', body: settings(true) }), 'Daqui Escola ligado. Os pais já veem no app.')}>Salvar e ligar</button>}
          </div>
          <p style={{ color: 'var(--texto-2)', margin: '12px 0 0', fontSize: 14 }}>
            Exemplo: casa a 3 km da escola, ida e volta, 5 dias: {money(Math.round((toCents(f.base) + toCents(f.km) * 3) / 100) * 100)} por mês.
            Para liberar um motorista, abra a ficha dele em Motoristas e marque "Transporte escolar".
          </p>
        </section>
      )}

      {d && requests.length > 0 && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Pedidos dos pais</h2>
          {d.drivers.length === 0 && <div className="aviso erro" role="status">Nenhum motorista liberado para transporte escolar. Libere em Motoristas.</div>}
          <div className="tabela">
            <table>
              <thead><tr><th>Aluno</th><th>Escola</th><th>Trechos e horários</th><th className="num">Km</th><th>Motorista e mensalidade</th><th></th></tr></thead>
              <tbody>
                {requests.map((c: any) => (
                  <tr key={c.id}>
                    <td><strong>{c.studentName}</strong>{c.grade ? ` · ${c.grade}` : ''}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{c.parent.name} · {fmtPhone(c.parent.phone)}<br />{c.home.address}</span></td>
                    <td>{c.school.name}</td>
                    <td style={{ fontSize: 13 }}>{LEG[c.legs]} · {c.weekdays.map((x: number) => DAY[x]).join(', ')}<br />{[c.pickupTime && `casa ${c.pickupTime}`, c.returnTime && `escola ${c.returnTime}`].filter(Boolean).join(' · ')}{c.notes ? <><br />{c.notes}</> : null}</td>
                    <td className="num">{String(c.distanceKm).replace('.', ',')}</td>
                    <td>{assignControls(c)}</td>
                    <td><button className="secundario" onClick={() => { const note = window.prompt('Motivo (os pais recebem):'); if (note) run(c.id, () => api(`/admin/escola/contracts/${c.id}/refuse`, { method: 'POST', body: { note } }), 'Pedido recusado.'); }}>Recusar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Hoje</h2>
          {today.length === 0 ? <p className="vazio">Sem viagens hoje (fim de semana, feriado ou ninguém com mensalidade em dia).</p> : (
            <div className="tabela">
              <table>
                <thead><tr><th>Hora</th><th>Aluno</th><th>Trecho</th><th>Motorista</th><th>Situação</th></tr></thead>
                <tbody>
                  {today.map((t: any) => (
                    <tr key={t.id}>
                      <td>{t.time}</td><td>{t.student.name}</td>
                      <td style={{ fontSize: 13 }}>{t.leg === 'ida' ? 'Ida' : 'Volta'}: {t.from.address} → {t.to.address}</td>
                      <td>{t.driver?.name ?? '—'}</td>
                      <td><Status tone={TRIP[t.status][1]}>{TRIP[t.status][0]}{t.status === 'ausente' && t.absentBy === 'pais' ? ' (aviso dos pais)' : ''}</Status></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {d && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Alunos</h2>
          {contracts.length === 0 ? <p className="vazio">Nenhum aluno ainda.</p> : (
            <div className="tabela">
              <table>
                <thead><tr><th>Aluno</th><th>Escola</th><th>Motorista</th><th className="num">Mensalidade</th><th>Pago até</th><th></th></tr></thead>
                <tbody>
                  {contracts.map((c: any) => (
                    <tr key={c.id}>
                      <td><strong>{c.studentName}</strong><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{c.parent.name} · {fmtPhone(c.parent.phone)}</span></td>
                      <td>{c.school.name}<br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{LEG[c.legs]} · {c.weekdays.map((x: number) => DAY[x]).join(', ')}</span></td>
                      <td>{c.driver?.name ?? '—'}</td>
                      <td className="num">{money(c.monthlyCents)}</td>
                      <td>{c.status === 'pausado' ? <Status tone="neutra">Pausado</Status>
                        : !c.paidUntil ? <Status tone="alerta">1ª mensalidade em aberto</Status>
                        : c.overdue ? <Status tone="ruim">Venceu {day(c.paidUntil)}</Status> : <Status tone="ok">{day(c.paidUntil)}</Status>}</td>
                      <td>
                        <div className="acoes">
                          <button className="secundario" onClick={() => window.confirm(`Registrar ${money(c.monthlyCents)} recebidos de ${c.parent.name}?`) && run(c.id, () => api(`/admin/escola/contracts/${c.id}/mark-paid`, { method: 'POST', body: { months: 1 } }), 'Pagamento registrado.')}>Recebi</button>
                          {c.status === 'ativo'
                            ? <button className="secundario" onClick={() => run(c.id, () => api(`/admin/escola/contracts/${c.id}/pause`, { method: 'POST', body: {} }), 'Pausado.')}>Pausar</button>
                            : <button className="secundario" onClick={() => run(c.id, () => api(`/admin/escola/contracts/${c.id}/resume`, { method: 'POST', body: {} }), 'Retomado.')}>Retomar</button>}
                          <button className="secundario" onClick={() => window.confirm(`Encerrar o transporte de ${c.studentName}?`) && run(c.id, () => api(`/admin/escola/contracts/${c.id}/end`, { method: 'POST', body: {} }), 'Encerrado.')}>Encerrar</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {d && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="acoes" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>Repasse aos motoristas</h2>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>Mês <input type="month" value={mes} onChange={(ev) => setMes(ev.target.value)} /></label>
          </div>
          <p style={{ margin: 0, color: 'var(--texto-2)' }}>O que os pais pagaram no mês, por motorista, menos a comissão da central. Pague por Pix e dê baixa.</p>
          {d.payouts.length === 0 ? <p className="vazio">Nada recebido neste mês.</p> : (
            <div className="tabela">
              <table>
                <thead><tr><th>Motorista</th><th className="num">Alunos</th><th className="num">Recebido</th><th className="num">Comissão</th><th className="num">Repassar</th><th>Pix</th><th></th></tr></thead>
                <tbody>
                  {d.payouts.map((p: any) => (
                    <tr key={p.driver_id}>
                      <td>{p.driver_name}</td><td className="num">{p.contracts}</td><td className="num">{money(p.received_cents)}</td>
                      <td className="num">{money(p.commission_cents)}</td><td className="num"><strong>{money(p.amount_cents)}</strong></td>
                      <td style={{ fontSize: 13 }}>{p.pix_key ?? '—'}{p.pix_key && !p.pix_validated ? ' (não conferido)' : ''}</td>
                      <td>{p.paid_at ? <Status tone="ok">Pago {day(p.paid_at)}</Status>
                        : <button className="secundario" onClick={() => run(p.driver_id, () => api('/admin/escola/payouts', { method: 'POST', body: { driverId: p.driver_id, month: mes } }), 'Repasse registrado.')}>Paguei</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {d && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Escolas atendidas</h2>
          {d.schools.length > 0 && (
            <div className="tabela"><table>
              <thead><tr><th>Escola</th><th>Endereço</th><th className="num">Alunos</th><th></th></tr></thead>
              <tbody>{d.schools.map((s: any) => (
                <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}>
                  <td>{s.name}</td><td style={{ fontSize: 13 }}>{s.address}</td><td className="num">{s.students}</td>
                  <td><button className="secundario" onClick={() => run(s.id, () => api(`/admin/escola/schools/${s.id}`, { method: 'PATCH', body: { active: !s.active } }), s.active ? 'Escola escondida dos pais.' : 'Escola de volta.')}>{s.active ? 'Esconder' : 'Mostrar'}</button></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
          <div className="formulario">
            <label>Nome da escola<input value={school.name} onChange={(ev) => setSchool({ ...school, name: ev.target.value })} placeholder="EE Ernesto Monte" /></label>
          </div>
          <PlacePicker value={school.place} onChange={(p) => setSchool({ ...school, place: p })} label="Endereço da escola" />
          <div><button disabled={school.name.trim().length < 3 || !school.place} onClick={() => run('escola', async () => {
            await api('/admin/escola/schools', { method: 'POST', body: { name: school.name.trim(), place: school.place } });
            setSchool({ name: '', place: null });
          }, 'Escola cadastrada.')}>Cadastrar escola</button></div>
        </section>
      )}

      {d && (
        <section className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2>Dias sem aula</h2>
          <p style={{ margin: 0, color: 'var(--texto-2)' }}>Feriados, recessos e férias: não há viagem nesses dias. Lance um dia ou um período.</p>
          {d.daysOff.length > 0 && (
            <p style={{ margin: 0 }}>{d.daysOff.map((o: any) => (
              <span key={o.day} style={{ display: 'inline-flex', gap: 6, marginRight: 14 }}>{day(o.day)}{o.note ? ` (${o.note})` : ''}
                <button className="secundario" style={{ padding: '0 8px', minHeight: 0 }} aria-label={`Remover ${day(o.day)}`} onClick={() => run(o.day, () => api(`/admin/escola/days-off/${o.day}`, { method: 'DELETE' }), 'Dia removido.')}>×</button></span>
            ))}</p>
          )}
          <div className="formulario">
            <label>De<input type="date" value={off.from} onChange={(ev) => setOff({ ...off, from: ev.target.value })} /></label>
            <label>Até (opcional)<input type="date" value={off.to} onChange={(ev) => setOff({ ...off, to: ev.target.value })} /></label>
            <label>Motivo<input value={off.note} onChange={(ev) => setOff({ ...off, note: ev.target.value })} placeholder="Férias de julho" /></label>
            <button disabled={!off.from} onClick={() => run('off', async () => {
              await api('/admin/escola/days-off', { method: 'POST', body: { from: off.from, to: off.to || undefined, note: off.note || undefined } });
              setOff({ from: '', to: '', note: '' });
            }, 'Dias sem aula lançados.')}>Lançar</button>
          </div>
        </section>
      )}
    </>
  );
}
