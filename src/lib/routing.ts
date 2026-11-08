import { config } from './config.js';
import { estimateTrip, type Point } from './geo.js';

/**
 * Distância e tempo reais pelas ruas, calculados pelo OSRM (OpenStreetMap) instalado na VPS.
 * Se o OSRM não estiver configurado, demorar ou não achar a rota, usa a estimativa
 * (linha reta × 1,3 a 24 km/h). O app nunca para por causa do serviço de rotas.
 */
export interface Trip {
  distanceKm: number; durationMin: number; source: 'rota' | 'estimativa';
  /** traçado pelas ruas (polyline codificada, precisão 5); só existe com o OSRM */
  polyline?: string | null;
}

const CACHE_MAX = 1000;
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; trip: Trip }>();

/** ~1 m de precisão: a mesma corrida (cotação e pedido) usa a rota guardada */
const key = (a: Point, b: Point) => [a.lat, a.lng, b.lat, b.lng].map((n) => n.toFixed(5)).join(',');

/** ponto de partida ou chegada a mais disso de uma rua conhecida: o mapa não cobre esse lugar */
const MAX_SNAP_M = 600;

let lastWarn = 0;
function warn(msg: string) {
  // no máximo um aviso por minuto no log
  if (Date.now() - lastWarn > 60_000) { lastWarn = Date.now(); console.warn(`[rotas] ${msg} — usando a estimativa`); }
}

const fallback = (a: Point, b: Point): Trip => ({ ...estimateTrip(a, b), source: 'estimativa' });

export async function routeTrip(a: Point, b: Point): Promise<Trip> {
  if (!config.routingUrl) return fallback(a, b);
  const k = key(a, b);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.trip;

  try {
    const url = `${config.routingUrl}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=polyline&alternatives=false&steps=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(config.routingTimeoutMs) });
    const data = (await res.json()) as {
      code: string;
      routes?: { distance: number; duration: number; geometry?: string }[];
      waypoints?: { distance: number }[];
    };
    const r = data.routes?.[0];
    if (data.code !== 'Ok' || !r) { warn(`rota não encontrada (${data.code})`); return fallback(a, b); }
    if (data.waypoints?.some((w) => w.distance > MAX_SNAP_M)) { warn('endereço fora do mapa de rotas'); return fallback(a, b); }

    const distanceKm = Math.max(0.3, Math.round((r.distance / 1000) * 100) / 100);
    // o tempo do OSRM é sem trânsito: o fator ajusta para a cidade (padrão 1,3)
    const durationMin = Math.max(2, Math.round((r.duration / 60) * config.routingTimeFactor));
    const trip: Trip = { distanceKm, durationMin, source: 'rota', polyline: typeof r.geometry === 'string' ? r.geometry : null };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(k, { at: Date.now(), trip });
    return trip;
  } catch (e) {
    warn(`serviço de rotas indisponível (${(e as Error).name})`);
    return fallback(a, b);
  }
}

/** usado pelos testes */
export const clearRouteCache = () => cache.clear();
