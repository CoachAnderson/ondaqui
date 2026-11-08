import { useState } from 'react';
import { api } from '../api';
import { useRealtime } from '../realtime';
import { dateTime, rideStatus } from '../format';
import { Erro, Status, errMsg, useLoad } from '../ui';

export default function Safety() {
  const [showAll, setShowAll] = useState(false);
  const list = useLoad(() => api(`/admin/alerts?open=${showAll ? 'false' : 'true'}`), [showAll]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useRealtime('alert:panic', () => list.reload());
  useRealtime('alert:resolved', () => list.reload());

  async function resolve(id: string) {
    setError(null);
    try {
      await api(`/admin/alerts/${id}/resolve`, { method: 'POST', body: { note: notes[id] || undefined } });
      list.reload();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const alerts = list.data?.alerts ?? [];
  return (
    <>
      <div className="topo">
        <div>
          <h1>Segurança</h1>
          <p>Alertas do botão de emergência. Ligue para a pessoa e, se preciso, acione a polícia (190).</p>
        </div>
        <div className="filtros" role="group" aria-label="Filtrar alertas">
          <button className={!showAll ? 'ativo' : ''} onClick={() => setShowAll(false)}>Em aberto</button>
          <button className={showAll ? 'ativo' : ''} onClick={() => setShowAll(true)}>Todos</button>
        </div>
      </div>
      <Erro msg={list.error ?? error} />
      {list.data && alerts.length === 0 && (
        <section className="cartao"><p className="vazio">{showAll ? 'Nenhum alerta registrado.' : 'Nenhum alerta em aberto.'}</p></section>
      )}
      {alerts.map((a: any) => (
        <section key={a.id} className="cartao" style={{ display: 'flex', flexDirection: 'column', gap: 12, borderColor: a.resolved_at ? undefined : '#E8B4AE' }}>
          <div className="topo" style={{ alignItems: 'flex-start' }}>
            <div>
              <h2>{a.user_role === 'driver' ? 'Motorista' : 'Passageiro'} acionou a emergência</h2>
              <p>{dateTime(a.created_at)} · {a.user_name}</p>
            </div>
            {a.resolved_at ? <Status tone="ok">Resolvido</Status> : <Status tone="ruim">Em aberto</Status>}
          </div>
          <dl className="lista-dados">
            <dt>Motorista</dt><dd>{a.driver_name ?? '—'}{a.vehicle_plate ? ` · ${a.vehicle_plate}` : ''}</dd>
            <dt>Corrida</dt><dd>{a.ride_status ? rideStatus[a.ride_status] : '—'}</dd>
            <dt>Local</dt>
            <dd>{a.lat != null
              ? <a href={`https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}`} target="_blank" rel="noreferrer">Abrir no mapa</a>
              : 'Sem localização'}</dd>
            {a.note && <><dt>Anotação</dt><dd>{a.note}</dd></>}
          </dl>
          {!a.resolved_at && (
            <div className="formulario">
              <label>O que foi feito
                <input value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} placeholder="ex.: liguei, passageira está bem" />
              </label>
              <button className="destaque" onClick={() => resolve(a.id)}>Marcar como resolvido</button>
            </div>
          )}
        </section>
      ))}
    </>
  );
}
