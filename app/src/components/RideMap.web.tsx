import { createElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MapPoint, MapRoute, RideMapProps } from './RideMap.types';
import { colors } from '../theme';

export type { MapPoint, MapRoute } from './RideMap.types';

/**
 * Versão web (só para testes no navegador): mostra os pontos em um quadro
 * proporcional, sem o mapa de ruas. Nos celulares o app usa o mapa nativo.
 */
export default function RideMap({ points, routes = [], height = 260 }: RideMapProps) {
  // o quadro enquadra os pontos e a rota
  const all = [...points, ...routes.flatMap((r) => r.coords)];
  const lats = all.map((p) => p.lat), lngs = all.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const spanLat = Math.max(maxLat - minLat, 0.004), spanLng = Math.max(maxLng - minLng, 0.004);
  const single = all.length === 1;
  const x = (p: { lng: number }) => (single ? 50 : 10 + ((p.lng - minLng) / spanLng) * 80);
  const y = (p: { lat: number }) => (single ? 45 : 10 + ((maxLat - p.lat) / spanLat) * 72);
  const lines = routes.filter((r) => r.coords.length > 1);
  return (
    <View style={[styles.wrap, { height }]} accessibilityLabel="Mapa da corrida">
      {lines.length > 0 && createElement('svg', {
        viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': true,
        style: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
      }, lines.map((r: MapRoute) => createElement('polyline', {
        key: r.id, fill: 'none', stroke: r.color, strokeWidth: r.dashed ? 3 : 4, strokeLinecap: 'round', strokeLinejoin: 'round',
        strokeDasharray: r.dashed ? '6 5' : undefined, vectorEffect: 'non-scaling-stroke',
        points: r.coords.map((c) => `${x(c).toFixed(2)},${y(c).toFixed(2)}`).join(' '),
      })))}
      {points.map((p: MapPoint) => {
        const right = x(p) > 55; // rótulo do lado de dentro do quadro
        return (
          <View key={p.id} style={[styles.point, right ? { right: `${100 - x(p)}%`, flexDirection: 'row-reverse' } : { left: `${x(p)}%` }, { top: `${y(p)}%` }]}>
            <View style={[styles.dot, { backgroundColor: p.color }]} />
            <Text style={styles.label} numberOfLines={1}>{p.label}</Text>
          </View>
        );
      })}
      <Text style={styles.note}>Mapa de ruas disponível no app do celular</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 16, overflow: 'hidden', backgroundColor: '#E8E2D8', borderWidth: 1, borderColor: colors.linha },
  point: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: -8, marginTop: -8 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: colors.branco },
  label: { fontSize: 13, fontWeight: '700', color: colors.texto, backgroundColor: '#FFFFFFCC', paddingHorizontal: 6, borderRadius: 6, maxWidth: 160 },
  note: { position: 'absolute', bottom: 8, right: 10, fontSize: 12, color: colors.texto2 },
});
