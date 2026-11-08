import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker, Polyline, type LatLng as MapLatLng } from 'react-native-maps';
import type { MapPoint, MapRoute, RideMapProps } from './RideMap.types';

export type { MapPoint, MapRoute } from './RideMap.types';

const toMap = (p: { lat: number; lng: number }): MapLatLng => ({ latitude: p.lat, longitude: p.lng });

/** Mapa nativo (Apple Maps no iPhone, Google Maps no Android) */
export default function RideMap({ points, routes = [], height = 260, onLongPress }: RideMapProps) {
  const ref = useRef<MapView>(null);
  const key = points.map((p) => `${p.id}:${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|')
    + routes.map((r) => `${r.id}:${r.coords.length}`).join('|');

  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    // enquadra os pontos e a rota inteira
    const all = [...points, ...routes.flatMap((r) => r.coords)];
    if (all.length === 1) {
      ref.current.animateToRegion({ ...toMap(points[0]), latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
    } else {
      ref.current.fitToCoordinates(all.map(toMap), {
        edgePadding: { top: 60, right: 60, bottom: 60, left: 60 }, animated: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const first = points[0];
  return (
    <View style={[styles.wrap, { height }]}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        initialRegion={first ? { ...toMap(first), latitudeDelta: 0.03, longitudeDelta: 0.03 } : undefined}
        showsUserLocation
        onLongPress={onLongPress ? (e) => onLongPress({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude }) : undefined}
      >
        {routes.filter((r) => r.coords.length > 1).map((r: MapRoute) => (
          <Polyline key={r.id} coordinates={r.coords.map(toMap)} strokeColor={r.color} strokeWidth={r.dashed ? 4 : 5}
            lineDashPattern={r.dashed ? [8, 6] : undefined} />
        ))}
        {points.map((p: MapPoint) => (
          <Marker key={p.id} coordinate={toMap(p)} title={p.label} pinColor={p.color} />
        ))}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 16, overflow: 'hidden', backgroundColor: '#E8E2D8' },
});
