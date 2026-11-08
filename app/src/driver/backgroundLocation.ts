import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { API_URL } from '../config';
import { storage } from '../storage';

/**
 * Localização do motorista com o app em segundo plano ou com a tela apagada.
 * No Android aparece uma notificação fixa "você está online" (serviço em primeiro plano),
 * exigência do sistema para usar o GPS em segundo plano.
 *
 * Este arquivo precisa ser importado no index.ts, fora de qualquer componente:
 * o sistema pode acordar o app só para rodar a tarefa.
 */
export const LOCATION_TASK = 'ondaqui-localizacao-motorista';
const SESSION_KEY = 'ondaqui.sessao.motorista';

async function storedToken(): Promise<string | null> {
  try {
    const raw = await storage.get(SESSION_KEY);
    return raw ? (JSON.parse(raw).token as string) : null;
  } catch {
    return null;
  }
}

if (Platform.OS !== 'web') {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    const last = data.locations[data.locations.length - 1];
    const token = await storedToken();
    if (!token) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
      return;
    }
    try {
      const res = await fetch(`${API_URL}/driver/location`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ lat: last.coords.latitude, lng: last.coords.longitude, heading: last.coords.heading ?? undefined }),
      });
      // sessão expirada ou conta bloqueada: para de usar o GPS
      if (res.status === 401 || res.status === 403) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
    } catch { /* sem internet: a próxima posição tenta de novo */ }
  });
}

export type BackgroundResult = 'ativo' | 'so-com-app-aberto' | 'indisponivel';

/** Liga o GPS em segundo plano. Sem permissão "o tempo todo", o app usa só o GPS com o app aberto. */
export async function startBackgroundLocation(accent: string): Promise<BackgroundResult> {
  if (Platform.OS === 'web') return 'indisponivel';
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return 'indisponivel';
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return 'so-com-app-aberto';
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return 'ativo';
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 5000,
      distanceInterval: 20,
      activityType: Location.LocationActivityType.AutomotiveNavigation,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Você está online',
        notificationBody: 'Recebendo corridas. Toque para abrir o app.',
        notificationColor: accent,
        killServiceOnDestroy: false,
      },
    });
    return 'ativo';
  } catch {
    return 'so-com-app-aberto';
  }
}

export async function stopBackgroundLocation() {
  if (Platform.OS === 'web') return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch { /* já parado */ }
}
