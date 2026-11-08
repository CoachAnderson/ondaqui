import { useEffect, useMemo, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet';
import { decodePolyline } from '../polyline';
import { API_URL, api } from '../api';
import { rideStatus } from '../format';
import { Wordmark } from '../ui';

interface Shared {
  status: string; tenant: string; origin: string; destination: string;
  kind?: string; service?: string; delivery?: { recipientName: string; code: string | null } | null;
  driver: null | { name: string; vehicle: { plate: string; model: string; color: string }; location: { lat: number; lng: number } | null; hasPhoto?: boolean; hasVehiclePhoto?: boolean; camera?: 'video' | 'video_audio' | null };
  store?: { name: string; hasLogo: boolean } | null;
  route?: { polyline: string | null; from: { lat: number; lng: number }; to: { lat: number; lng: number } | null } | null;
  hasDropoffPhoto?: boolean;
  requestedAt: string; startedAt: string | null; completedAt: string | null;
}

/** Com o traçado: enquadra a rota inteira e o motorista uma vez (depois a família mexe no mapa à vontade) */
function FitRoute({ line, at }: { line: [number, number][]; at: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    if (line.length > 1) map.fitBounds([...line, at], { padding: [30, 30] });
  }, [line.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Follow({ at }: { at: [number, number] }) {
  const map = useMap();
  useEffect(() => { map.setView(at, map.getZoom()); }, [at[0], at[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Página pública que o passageiro compartilha com a família: /acompanhar/<código> */
export default function Track({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api<Shared>(`/public/share/${encodeURIComponent(token)}`)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [token]);

  // a versão muda a cada atualização para não ficar com foto velha no cache
  const photo = (which: string) => `${API_URL}/public/share/${encodeURIComponent(token)}/photo/${which}?v=${data?.status ?? ''}`;
  const loc = data?.driver?.location;
  const pos: [number, number] | null = loc ? [loc.lat, loc.lng] : null;
  const ended = data && ['completed', 'cancelled'].includes(data.status);
  // traçado da viagem pelas ruas (quando o serviço de rotas está ligado)
  const line = useMemo(() => decodePolyline(data?.route?.polyline).map((c) => [c.lat, c.lng] as [number, number]), [data?.route?.polyline]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--areia)' }}>
      <header style={{ background: 'var(--noite)', color: 'var(--areia)', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Wordmark size={28} />
        {data && <span style={{ marginLeft: 'auto', fontSize: 14, color: '#C9D3DD' }}>{data.tenant}</span>}
      </header>
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '20px 16px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {data?.store && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {data.store.hasLogo && <img src={photo('logo')} alt={`Logo de ${data.store.name}`} style={{ width: 56, height: 56, objectFit: 'contain', background: '#fff', borderRadius: 12, border: '1px solid var(--linha)' }} />}
            <span style={{ color: 'var(--texto-2)' }}>Pedido de <strong style={{ color: 'var(--texto)' }}>{data.store.name}</strong></span>
          </div>
        )}
        <h1>{data?.kind === 'entrega' ? 'Acompanhe sua entrega' : 'Acompanhe a corrida'}</h1>
        {data?.delivery?.code && (
          <div className="aviso ok" role="status" style={{ marginTop: 12 }}>
            <strong>Código de entrega: <span style={{ fontSize: 22, letterSpacing: 4 }}>{data.delivery.code}</span></strong><br />
            Só diga este código ao entregador quando estiver com o pacote na mão.
          </div>
        )}
        {error && <div className="aviso erro" role="alert">{error}</div>}
        {data && (
          <>
            <div className={`aviso ${data.status === 'completed' ? 'ok' : data.status === 'cancelled' ? 'erro' : ''}`}
                 style={!ended ? { background: 'var(--noite)', color: 'var(--branco)' } : undefined} role="status">
              <strong>{data.status === 'completed' ? 'Chegou ao destino' : rideStatus[data.status]}</strong>
              {!ended && ' · atualiza sozinho a cada 10 segundos'}
            </div>
            {pos && !ended && (
              <div className="mapa" style={{ height: 320 }}>
                <MapContainer center={pos} zoom={15} style={{ height: '100%', width: '100%' }}>
                  <TileLayer attribution='&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                             url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  {line.length > 1 && <Polyline positions={line} pathOptions={{ color: '#F2622E', weight: 5, opacity: 0.8 }} />}
                  {data?.route?.from && <CircleMarker center={[data.route.from.lat, data.route.from.lng]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#1E8A5C', fillOpacity: 1 }} />}
                  {data?.route?.to && <CircleMarker center={[data.route.to.lat, data.route.to.lng]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: '#12263A', fillOpacity: 1 }} />}
                  <CircleMarker center={pos} radius={10} pathOptions={{ color: '#fff', weight: 3, fillColor: '#F2622E', fillOpacity: 1 }} />
                  {line.length > 1 ? <FitRoute line={line} at={pos} /> : <Follow at={pos} />}
                </MapContainer>
              </div>
            )}
            {data.driver && (data.driver.hasPhoto || data.driver.hasVehiclePhoto) && (
              <section className="cartao" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                {data.driver.hasPhoto && <img src={photo('perfil')} alt={`Foto de ${data.driver.name}`} style={{ width: 84, height: 84, borderRadius: '50%', objectFit: 'cover' }} />}
                {data.driver.hasVehiclePhoto && <img src={photo('veiculo')} alt="Foto do veículo" style={{ flex: 1, maxWidth: 260, height: 84, borderRadius: 12, objectFit: 'cover' }} />}
                <span style={{ color: 'var(--texto-2)', fontSize: 14 }}>Fotos conferidas pela central</span>
              </section>
            )}
            {data.driver?.camera && !ended && (
              <div className="aviso ok" role="status">Este veículo tem câmera de segurança ({data.driver.camera === 'video_audio' ? 'vídeo e áudio' : 'vídeo'}), avisada ao passageiro antes do embarque.</div>
            )}
            {data.hasDropoffPhoto && (
              <section className="cartao">
                <h3 style={{ marginBottom: 8 }}>Comprovante da entrega</h3>
                <img src={photo('entrega')} alt="Foto do pacote entregue" style={{ width: '100%', borderRadius: 12 }} />
              </section>
            )}
            <section className="cartao">
              <dl className="lista-dados">
                <dt>Saindo de</dt><dd>{data.origin}</dd>
                <dt>Indo para</dt><dd>{data.destination}</dd>
                {data.driver && (
                  <>
                    <dt>Motorista</dt><dd>{data.driver.name}</dd>
                    <dt>Veículo</dt><dd>{data.driver.vehicle.model} {data.driver.vehicle.color} · {data.driver.vehicle.plate}</dd>
                  </>
                )}
              </dl>
            </section>
            <p style={{ color: 'var(--texto-2)', margin: 0, fontSize: 14 }}>
              Se perceber algo errado, ligue para a pessoa. Em caso de perigo, ligue 190.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
