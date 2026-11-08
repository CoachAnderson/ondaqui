import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { api } from './api';

/**
 * Notificações push (Expo Push Service).
 * Só funcionam em celular de verdade, em um app gerado pelo EAS (build de desenvolvimento
 * ou de loja) e com EAS_PROJECT_ID definido. No navegador e sem projeto, o app segue
 * funcionando só com o tempo real, sem push.
 */

// os mesmos canais usados pela API (apps/api/src/lib/push.ts)
export const CHANNEL_OFFERS = 'corridas';
export const CHANNEL_UPDATES = 'avisos';

let registeredToken: string | null = null;

export type PushData = { type?: 'offer' | 'ride' | 'offline'; rideId?: string };

/** Com o app aberto: avisos de corrida aparecem; ofertas não (o cartão já está na tela) */
export function setupNotifications() {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const data = n.request.content.data as PushData;
      const show = data?.type !== 'offer';
      return { shouldShowBanner: show, shouldShowList: true, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync(CHANNEL_OFFERS, {
      name: 'Novas corridas',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 400, 200, 400, 200, 400],
      enableVibrate: true,
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    void Notifications.setNotificationChannelAsync(CHANNEL_UPDATES, {
      name: 'Andamento da corrida',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

export type PushStatus = 'ativo' | 'negado' | 'indisponivel';

/** Pede permissão, pega o token do aparelho e envia para a API */
export async function registerPush(): Promise<PushStatus> {
  if (Platform.OS === 'web' || !Device.isDevice) return 'indisponivel';
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return 'indisponivel';
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'negado';
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  await api('/me/push-token', { method: 'POST', body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' } });
  registeredToken = token;
  return 'ativo';
}

/** Ao sair da conta, o aparelho para de receber avisos dela */
export async function unregisterPush() {
  if (!registeredToken) return;
  const token = registeredToken;
  registeredToken = null;
  await api('/me/push-token', { method: 'DELETE', body: { token } }).catch(() => {});
}

/** Chama onOpen quando a pessoa toca numa notificação (inclusive com o app fechado) */
export function useNotificationOpen(onOpen: (data: PushData) => void) {
  const ref = useRef(onOpen);
  ref.current = onOpen;
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.getLastNotificationResponseAsync().then((r) => {
      if (r) ref.current(r.notification.request.content.data as PushData);
    }).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      ref.current(r.notification.request.content.data as PushData);
    });
    return () => sub.remove();
  }, []);
}

/** Registra o push assim que a pessoa entra na conta */
export function usePushRegistration(onStatus?: (s: PushStatus) => void) {
  const ref = useRef(onStatus);
  ref.current = onStatus;
  useEffect(() => {
    registerPush().then((s) => ref.current?.(s)).catch(() => ref.current?.('indisponivel'));
  }, []);
}
