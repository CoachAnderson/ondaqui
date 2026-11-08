import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, centro, destino, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { EXPO_PUSH_URL, pushOutbox } from '../src/lib/push.js';
import { config } from '../src/lib/config.js';
import { query } from '../src/lib/db.js';
import { sweepPendingRides } from '../src/lib/rides.js';

let ctx: Ctx;
let maria: string, joao: string;
const TK_MARIA = 'ExponentPushToken[maria-aparelho-1]';
const TK_JOAO = 'ExponentPushToken[joao-aparelho-01]';

const sentTo = (token: string) => pushOutbox.filter((m) => m.to === token);
const settle = () => new Promise((r) => setTimeout(r, 150)); // push é enviado sem travar a resposta

beforeAll(async () => {
  ctx = await startServer();
  [maria, joao] = await Promise.all([login(ctx, '14900000010'), login(ctx, '14900000020')]);
  await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, joao);
  await api(ctx, 'POST', '/driver/online', { online: true }, joao);
  await api(ctx, 'POST', '/driver/location', { lat: -22.32, lng: -49.085 }, joao);
});
afterAll(async () => stopServer(ctx));
beforeEach(() => { pushOutbox.length = 0; });

describe('notificações push', () => {
  it('registra o aparelho e recusa token inválido', async () => {
    expect((await api(ctx, 'POST', '/me/push-token', { token: TK_MARIA, platform: 'android' }, maria)).status).toBe(200);
    expect((await api(ctx, 'POST', '/me/push-token', { token: TK_JOAO, platform: 'ios' }, joao)).status).toBe(200);
    const bad = await api(ctx, 'POST', '/me/push-token', { token: 'qualquer-coisa', platform: 'android' }, maria);
    expect(bad.status).toBe(400);
  });

  it('oferta de corrida chega por push ao motorista, no canal de corridas', async () => {
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'cash' }, maria);
    expect(r.status).toBe(201);
    await settle();
    const [offer] = sentTo(TK_JOAO);
    expect(offer.title).toMatch(/^Nova corrida · R\$/);
    expect(offer.data).toEqual({ type: 'offer', rideId: r.body.ride.id });
    expect(offer.channelId).toBe('corridas');
    expect(offer.ttl).toBe(30);
    expect(sentTo(TK_MARIA)).toHaveLength(0);

    pushOutbox.length = 0;
    await api(ctx, 'POST', `/rides/${r.body.ride.id}/accept`, {}, joao);
    await settle();
    const [accepted] = sentTo(TK_MARIA);
    expect(accepted.title).toBe('Motorista a caminho');
    expect(accepted.body).toContain('BAU-1A23');

    pushOutbox.length = 0;
    await api(ctx, 'POST', `/rides/${r.body.ride.id}/cancel`, {}, maria);
    await settle();
    expect(sentTo(TK_JOAO)[0].title).toBe('Corrida cancelada');
  });

  it('o token passa para a conta que entrou por último no aparelho', async () => {
    await api(ctx, 'POST', '/me/push-token', { token: TK_MARIA, platform: 'android' }, joao);
    const rows = await query(`SELECT u.phone FROM push_tokens p JOIN users u ON u.id = p.user_id WHERE token = $1`, [TK_MARIA]);
    expect(rows[0].phone).toBe('14900000020');
    await api(ctx, 'POST', '/me/push-token', { token: TK_MARIA, platform: 'android' }, maria);
    expect((await api(ctx, 'DELETE', '/me/push-token', { token: TK_JOAO }, joao)).status).toBe(200);
    await api(ctx, 'POST', '/me/push-token', { token: TK_JOAO, platform: 'ios' }, joao);
  });

  it('motorista sem sinal de GPS fica offline e é avisado', async () => {
    await query(`UPDATE drivers SET location_at = now() - interval '15 minutes'
                  WHERE user_id = (SELECT id FROM users WHERE phone = '14900000020')`);
    const r = await sweepPendingRides();
    expect(r.wentOffline).toBe(1);
    await settle();
    expect(sentTo(TK_JOAO)[0].title).toBe('Você ficou offline');
    const me = await api(ctx, 'GET', '/driver/me', undefined, joao);
    expect(me.body.online).toBe(false);
  });

  it('apaga o token quando a Expo diz que o aparelho não existe mais', async () => {
    const realFetch = globalThis.fetch;
    const calls: any[] = [];
    config.pushMode = 'expo';
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url) !== EXPO_PUSH_URL) return realFetch(url, init);
      const msgs = JSON.parse(init.body);
      calls.push(...msgs);
      return new Response(JSON.stringify({
        data: msgs.map((m: any) => (m.to === TK_MARIA
          ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: 'abc' })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const { pushTo } = await import('../src/lib/push.js');
      const ids = await query(`SELECT id FROM users WHERE phone IN ('14900000010','14900000020')`);
      await pushTo(ids.map((x) => x.id), { title: 'Teste', body: 'teste' });
      expect(calls.map((c) => c.to).sort()).toEqual([TK_JOAO, TK_MARIA].sort());
      expect(calls[0].priority).toBe('high');
      const left = await query('SELECT token FROM push_tokens ORDER BY token');
      expect(left.map((x) => x.token)).toEqual([TK_JOAO]);
    } finally {
      globalThis.fetch = realFetch;
      config.pushMode = 'test';
    }
  });
});
