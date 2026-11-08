import { config } from './config.js';
import { query } from './db.js';

/**
 * Notificações push pelo Expo Push Service.
 * PUSH_MODE=expo (padrão) envia de verdade; off desliga; test guarda em pushOutbox (testes).
 */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
}

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const pushOutbox: PushMessage[] = [];
export const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$/;

/** Mensagem que vai para o celular, sem o token (que é preenchido por aparelho) */
export type Notification = Omit<PushMessage, 'to'>;

/** Canais do Android criados pelo app (veja apps/app/src/push.ts) */
export const CHANNEL_OFFERS = 'corridas';
export const CHANNEL_UPDATES = 'avisos';

async function sendBatch(messages: PushMessage[]) {
  if (config.pushMode === 'off' || messages.length === 0) return;
  if (config.pushMode === 'test') { pushOutbox.push(...messages); return; }

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(config.expoAccessToken ? { authorization: `Bearer ${config.expoAccessToken}` } : {}),
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`Expo Push respondeu ${res.status}`);
    const json = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    // celular desinstalou o app ou trocou de token: para de mandar para ele
    const dead = (json.data ?? [])
      .map((t, k) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? chunk[k].to : null))
      .filter((t): t is string => !!t);
    if (dead.length) await query('DELETE FROM push_tokens WHERE token = ANY($1)', [dead]);
  }
}

/** Envia para todos os aparelhos das pessoas. Nunca derruba a requisição que chamou. */
export async function pushTo(userIds: string | string[], n: Notification) {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (ids.length === 0 || config.pushMode === 'off') return;
  try {
    const rows = await query<{ token: string }>('SELECT token FROM push_tokens WHERE user_id = ANY($1)', [ids]);
    await sendBatch(rows.map((r) => ({ sound: 'default', priority: 'high', ...n, to: r.token })));
  } catch (e) {
    console.error('falha ao enviar push:', (e as Error).message);
  }
}
