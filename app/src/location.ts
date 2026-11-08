import * as Location from 'expo-location';
import type { LatLng, Place } from './types';

export async function askLocation(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

export async function currentPosition(): Promise<LatLng> {
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: p.coords.latitude, lng: p.coords.longitude };
}

/** Endereço legível de um ponto. Sem serviço de endereços (ex.: navegador), usa um texto padrão. */
export async function describe(p: LatLng, fallback: string): Promise<Place> {
  try {
    const [a] = await Location.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lng });
    if (a) {
      const street = [a.street, a.streetNumber].filter(Boolean).join(', ');
      const area = a.district ?? a.subregion ?? a.city ?? '';
      const text = [street || a.name, area].filter(Boolean).join(' · ');
      if (text.length >= 3) return { ...p, address: text };
    }
  } catch { /* sem serviço de endereços */ }
  return { ...p, address: fallback };
}

/** Busca um endereço digitado. Retorna null quando não encontra ou não há serviço. */
export async function search(text: string, city: string | undefined): Promise<Place | null> {
  try {
    const q = city && !text.toLowerCase().includes(city.toLowerCase()) ? `${text}, ${city}` : text;
    const [r] = await Location.geocodeAsync(q);
    if (!r) return null;
    return { lat: r.latitude, lng: r.longitude, address: text.trim() };
  } catch {
    return null;
  }
}

export { Location };
