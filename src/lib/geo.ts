export interface Point { lat: number; lng: number }

const EARTH_KM = 6371;
/** fator para transformar distância em linha reta em distância aproximada pelas ruas */
export const ROAD_FACTOR = 1.3;
/** velocidade média urbana usada na estimativa de tempo */
export const AVG_SPEED_KMH = 24;

export function haversineKm(a: Point, b: Point): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Estimativa de trajeto quando o serviço de rotas (OSRM, veja routing.ts) não está disponível */
export function estimateTrip(origin: Point, dest: Point) {
  const distanceKm = Math.max(0.3, haversineKm(origin, dest) * ROAD_FACTOR);
  const durationMin = Math.max(2, Math.round((distanceKm / AVG_SPEED_KMH) * 60));
  return { distanceKm: Math.round(distanceKm * 100) / 100, durationMin };
}

/** Expressão SQL de distância em km entre (lat,lng) de uma linha e os parâmetros $latParam,$lngParam */
export function sqlDistanceKm(latCol: string, lngCol: string, latParam: string, lngParam: string) {
  return `(2 * ${EARTH_KM} * asin(sqrt(
    power(sin(radians(${latCol} - ${latParam}) / 2), 2) +
    cos(radians(${latParam})) * cos(radians(${latCol})) * power(sin(radians(${lngCol} - ${lngParam}) / 2), 2)
  )))`;
}

export function insideBox(p: Point, t: { min_lat: number | null; max_lat: number | null; min_lng: number | null; max_lng: number | null }) {
  if (t.min_lat == null || t.max_lat == null || t.min_lng == null || t.max_lng == null) return true;
  return p.lat >= t.min_lat && p.lat <= t.max_lat && p.lng >= t.min_lng && p.lng <= t.max_lng;
}
