import { useEffect, useState } from 'react';
import { api } from './api';
import { decodePolyline } from './polyline';

interface PickupRoute { polyline: string | null; distanceKm: number | null; durationMin: number | null }

/**
 * Caminho do motorista até o embarque, pelas ruas, enquanto ele está a caminho.
 * Atualiza quando o motorista anda bastante (ou a cada 45 s).
 */
export function usePickupRoute(rideId: string, status: string, driverPos: { lat: number; lng: number } | null) {
  const [route, setRoute] = useState<{ coords: { lat: number; lng: number }[]; durationMin: number | null } | null>(null);
  const active = status === 'accepted' && !!driverPos;
  // ~200 m de movimento pedem uma rota nova
  const cell = driverPos ? `${driverPos.lat.toFixed(3)},${driverPos.lng.toFixed(3)}` : '';

  useEffect(() => {
    if (!active) { setRoute(null); return; }
    let alive = true;
    const load = () => api<PickupRoute>(`/rides/${rideId}/pickup-route`)
      .then((r) => alive && setRoute({ coords: decodePolyline(r.polyline), durationMin: r.durationMin }))
      .catch(() => {});
    load();
    const t = setInterval(load, 45_000);
    return () => { alive = false; clearInterval(t); };
  }, [rideId, active, cell]);

  return route;
}
