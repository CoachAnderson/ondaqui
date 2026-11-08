import { useState } from 'react';
import RideChat from '../RideChat';
import { api } from '../api';
import { useRealtime } from '../realtime';
import { cancelReason, dateTime, money, payment, rideStatus } from '../format';
import { Erro, Status, rideTone, useLoad } from '../ui';

type Filter = 'active' | 'scheduled' | 'completed' | 'cancelled' | 'all';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'active', label: 'Em andamento' },
  { id: 'scheduled', label: 'Agendadas' },
  { id: 'completed', label: 'Finalizadas' },
  { id: 'cancelled', label: 'Canceladas' },
];

export default function Rides() {
  const [filter, setFilter] = useState<Filter>('all');
  const list = useLoad(() => api(`/admin/rides?status=${filter}&limit=100`), [filter]);
  useRealtime('ride:updated', () => list.reload());

  const rides = list.data?.rides ?? [];
  const done = rides.filter((r: any) => r.status === 'completed');
  const gross = done.reduce((s: number, r: any) => s + r.priceCents, 0);
  const commission = done.reduce((s: number, r: any) => s + r.commissionCents, 0);

  return (
    <>
      <div className="topo">
        <div>
          <h1>Corridas</h1>
          <p>As 100 corridas mais recentes, atualizadas em tempo real.</p>
        </div>
      </div>
      <div className="filtros" role="group" aria-label="Filtrar corridas">
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'ativo' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      <Erro msg={list.error} />
      {done.length > 0 && (
        <p style={{ margin: 0, color: 'var(--texto-2)' }}>
          {done.length} finalizadas nesta lista · {money(gross)} em corridas · {money(commission)} de comissão
        </p>
      )}
      <section className="cartao">
        {list.data && rides.length === 0 && <p className="vazio">Nenhuma corrida nesta lista.</p>}
        {rides.length > 0 && (
          <div className="tabela">
            <table>
              <thead>
                <tr><th>Pedido</th><th>Situação</th><th>Trajeto</th><th>Passageiro</th><th>Motorista</th><th className="num">Valor</th><th className="num">Comissão</th><th></th></tr>
              </thead>
              <tbody>
                {rides.map((r: any) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dateTime(r.requestedAt)}</td>
                    <td>
                      <Status tone={rideTone(r.status)}>{rideStatus[r.status]}</Status>
                      {r.cancelReason && <><br /><span style={{ color: 'var(--texto-2)', fontSize: 13 }}>{cancelReason[r.cancelReason] ?? r.cancelReason}</span></>}
                    </td>
                    <td>
                      <strong>{r.serviceName ?? 'Corrida'}</strong>{r.scheduledFor ? <span style={{ color: 'var(--texto-2)' }}> · agendada {dateTime(r.scheduledFor)}</span> : null}<br />
                      {r.origin.address}<br />
                      <span style={{ color: 'var(--texto-2)' }}>
                        {r.kind === 'particular' ? `${r.hoursBooked} h à disposição` : `→ ${r.destination.address} · ${r.distanceKm} km`}
                      </span>
                    </td>
                    <td>{r.passenger.name}</td>
                    <td>{r.driver ? <>{r.driver.name}<br /><span style={{ color: 'var(--texto-2)' }}>{r.driver.vehicle.plate}</span></> : '—'}</td>
                    <td className="num">{money(r.priceCents)}<br /><span style={{ color: 'var(--texto-2)' }}>{payment[r.paymentMethod]}</span></td>
                    <td className="num">{r.status === 'completed' ? money(r.commissionCents) : '—'}</td>
                    <td>{r.driver && <RideChat rideId={r.id} label="Conversa" readOnly />}</td>
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
