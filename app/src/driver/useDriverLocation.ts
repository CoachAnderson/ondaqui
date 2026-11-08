import { useEffect, useRef, useState } from 'react';
import { post } from '../api';
import { LOCATION_INTERVAL_MS } from '../config';
import { Location, askLocation } from '../location';
import { useBrand } from '../theme';
import { startBackgroundLocation, stopBackgroundLocation, type BackgroundResult } from './backgroundLocation';

/**
 * Enquanto o motorista está online, envia a posição para a central.
 * Com permissão "o tempo todo", o GPS segue funcionando com a tela apagada (segundo plano).
 * Sem ela, a posição é enviada só com o app aberto.
 */
export function useDriverLocation(online: boolean) {
  const { accent } = useBrand();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<BackgroundResult | null>(null);
  const last = useRef(0);

  useEffect(() => {
    if (!online) {
      void stopBackgroundLocation();
      setMode(null);
      return;
    }
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      if (!(await askLocation())) {
        setError('Ative a localização para receber corridas.');
        return;
      }
      setError(null);
      const send = (lat: number, lng: number, heading?: number | null) => {
        const now = Date.now();
        if (now - last.current < LOCATION_INTERVAL_MS) return;
        last.current = now;
        post('/driver/location', { lat, lng, heading: heading ?? undefined }).catch(() => {});
      };
      // posição imediata, para já poder receber corridas
      try {
        const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        last.current = 0;
        send(p.coords.latitude, p.coords.longitude, p.coords.heading);
      } catch { /* o acompanhamento abaixo tenta de novo */ }
      if (cancelled) return;

      const bg = await startBackgroundLocation(accent);
      if (cancelled) { void stopBackgroundLocation(); return; }
      setMode(bg);
      if (bg === 'ativo') return; // a tarefa em segundo plano envia as posições

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: LOCATION_INTERVAL_MS, distanceInterval: 20 },
        (p) => send(p.coords.latitude, p.coords.longitude, p.coords.heading),
      );
      if (cancelled) sub.remove();
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [online, accent]);

  return { error, mode };
}
