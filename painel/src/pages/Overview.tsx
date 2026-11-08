import { useMemo } from 'react';
import { CircleMarker, MapContainer, Rectangle, TileLayer, Tooltip } from 'react-leaflet';
import { api } from '../api';
import { useRealtime } from '../realtime';
import { money, rideStatus, payment } from '../format';
import { Erro, Status, rideTone, useLoad } from '../ui';

const COR_LIVRE = '#1F8A5B';
const COR_OCUPADO = '#F2622E';
const COR_PEDIDO = '#2E6BF2';

export default function Overview() {
  const kpi = useLoad(() => api('/admin/overview'));
  const map = useLoad(() => api('/admin/map'));

  // posição dos motoristas ao vivo
  useRealtime<{ driverId: string; lat: number; lng: number }>('driver:location', (p) => {
    map.setData((m: any) => {
      if (!m) return m;
      const known = m.drivers.some((d: any) => d.id === p.driverId);
      if (!known) { map.reload(); return m; }
      return { ...m, drivers: m.drivers.map((d: any) => (d.id === p.driverId ? { ...d, lat: p.lat, lng: p.lng } : d)) };
    });
  });
  useRealtime('driver:status', () => { map.reload(); kpi.reload(); });
  useRealtime('ride:updated', () => { map.reload(); kpi.reload(); });

  const area = map.data?.area;
  const bounds = useMemo(() => {
    if (area?.min_lat != null) return [[area.min_lat, area.min_lng], [area.max_lat, area.max_lng]] as [[number, number], [number, number]];
    return null;
  }, [area?.min_lat, area?.min_lng, area?.max_lat, area?.max_lng]);

  const k = kpi.data;
  return (
    <>
      <div className="topo">
        <div>
          <h1>Visão geral</h1>
          <p>O que está acontecendo na cidade agora.</p>
        </div>
      </div>
      <Erro msg={kpi.error ?? map.error} />

      {k && (
        <div className="grade-kpi">
          <Kpi rotulo="Motoristas online" valor={k.drivers_online} nota={`${k.drivers_approved} aprovados`} />
          <Kpi rotulo="Corridas agora" valor={k.rides_active} />
          <Kpi rotulo="Corridas hoje" valor={k.rides_today} nota={`${money(k.gross_today_cents)} em corridas`} />
          <Kpi rotulo="Receita do mês" valor={money(k.subscriptions_month_cents + k.commission_month_cents)}
               nota={`${money(k.subscriptions_month_cents)} mensalidades · ${money(k.commission_month_cents)} comissões`} />
          <Kpi rotulo="Cadastros para aprovar" valor={k.drivers_pending} nota={`${k.passengers} passageiros cadastrados`} />
        </div>
      )}

      <div className="duas">
        <section className="cartao" aria-labelledby="t-mapa">
          <h2 id="t-mapa">Mapa ao vivo</h2>
          <div className="mapa" style={{ marginTop: 12 }}>
            {map.data && (
              <MapContainer
                {...(bounds ? { bounds } : { center: [-22.3246, -49.0871] as [number, number], zoom: 13 })}
                style={{ height: '100%', width: '100%' }} scrollWheelZoom
              >
                <TileLayer
                  attribution='&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {bounds && <Rectangle bounds={bounds} pathOptions={{ color: '#12263A', weight: 1, fill: false, dashArray: '6 6' }} />}
                {map.data.drivers.map((d: any) => (
                  <CircleMarker key={d.id} center={[d.lat, d.lng]} radius={9}
                    pathOptions={{ color: '#fff', weight: 2, fillColor: d.busy ? COR_OCUPADO : COR_LIVRE, fillOpacity: 1 }}>
                    <Tooltip>{d.name} · {d.plate} · {d.busy ? 'em corrida' : 'livre'}</Tooltip>
                  </CircleMarker>
                ))}
                {map.data.rides.filter((r: any) => r.status === 'requested').map((r: any) => (
                  <CircleMarker key={r.id} center={[r.origin.lat, r.origin.lng]} radius={7}
                    pathOptions={{ color: '#fff', weight: 2, fillColor: COR_PEDIDO, fillOpacity: 1 }}>
                    <Tooltip>Passageiro esperando: {r.origin.address}</Tooltip>
                  </CircleMarker>
                ))}
              </MapContainer>
            )}
          </div>
          <div className="legenda">
            <span><i style={{ background: COR_LIVRE }} />Motorista livre</span>
            <span><i style={{ background: COR_OCUPADO }} />Em corrida</span>
            <span><i style={{ background: COR_PEDIDO }} />Passageiro esperando</span>
            <span>Tracejado: área de atendimento</span>
          </div>
        </section>

        <section className="cartao" aria-labelledby="t-ativas">
          <h2 id="t-ativas">Corridas em andamento</h2>
          {map.data && map.data.rides.length === 0 && <p className="vazio">Nenhuma corrida neste momento.</p>}
          {map.data && map.data.rides.length > 0 && (
            <div className="tabela" style={{ marginTop: 12 }}>
              <table>
                <thead><tr><th>Situação</th><th>Trajeto</th><th>Motorista</th><th className="num">Valor</th></tr></thead>
                <tbody>
                  {map.data.rides.map((r: any) => (
                    <tr key={r.id}>
                      <td><Status tone={rideTone(r.status)}>{rideStatus[r.status]}</Status></td>
                      <td>{r.origin.address}<br /><span style={{ color: 'var(--texto-2)' }}>→ {r.destination.address}</span></td>
                      <td>{r.driver ? <>{r.driver.name}<br /><span style={{ color: 'var(--texto-2)' }}>{r.driver.vehicle.plate}</span></> : '—'}</td>
                      <td className="num">{money(r.priceCents)}<br /><span style={{ color: 'var(--texto-2)' }}>{payment[r.paymentMethod]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Kpi({ rotulo, valor, nota }: { rotulo: string; valor: React.ReactNode; nota?: string }) {
  return (
    <div className="cartao kpi">
      <span className="rotulo">{rotulo}</span>
      <span className="valor">{valor}</span>
      {nota && <span className="nota">{nota}</span>}
    </div>
  );
}
