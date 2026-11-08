import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, centro, destino, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { pushOutbox } from '../src/lib/push.js';
import { purgeOldMessages } from '../src/routes/chat.js';

let ctx: Ctx;
let maria: string, joao: string, ana: string, admin: string, rideId: string;

beforeAll(async () => {
  ctx = await startServer();
  maria = await login(ctx, '14900000010');
  joao = await login(ctx, '14900000020');
  ana = await login(ctx, '14900000021');
  admin = await login(ctx, '14900000001');
  const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix' }, maria);
  rideId = r.body.ride.id;
  await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[joao-chat-0001]', platform: 'android' }, joao);
});
afterAll(async () => stopServer(ctx));

const say = (token: string, body: string) => api(ctx, 'POST', `/rides/${rideId}/messages`, { body }, token);

describe('chat da corrida', () => {
  it('abre só quando o motorista aceita', async () => {
    const r = await say(maria, 'Oi');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('chat_fechado');
    await query(`UPDATE rides SET driver_id = (SELECT id FROM users WHERE phone = '14900000020'), status = 'accepted', accepted_at = now() WHERE id = $1`, [rideId]);
  });

  it('passageira e motorista conversam sem trocar telefone; o outro lado recebe push', async () => {
    pushOutbox.length = 0;
    let r = await say(maria, 'Estou no portão azul');
    expect(r.status).toBe(201);
    expect(pushOutbox.at(-1)).toMatchObject({ to: 'ExponentPushToken[joao-chat-0001]', title: 'Maria', body: 'Estou no portão azul' });
    r = await say(joao, 'Cheguei');
    expect(r.body.message).toMatchObject({ side: 'motorista', mine: true });

    const m = await api(ctx, 'GET', `/rides/${rideId}/messages`, undefined, maria);
    expect(m.body.open).toBe(true);
    expect(m.body.with).toBe('João');
    expect(m.body.quickReplies).toContain('Estou no local');
    expect(m.body.messages.map((x: any) => [x.side, x.mine, x.body])).toEqual([
      ['cliente', true, 'Estou no portão azul'], ['motorista', false, 'Cheguei'],
    ]);
    expect(JSON.stringify(m.body)).not.toMatch(/14900000020/); // telefone do motorista não aparece
    const d = await api(ctx, 'GET', `/rides/${rideId}/messages`, undefined, joao);
    expect(d.body.with).toBe('Maria');
    expect(d.body.messages[0]).toMatchObject({ mine: false, read: false });
    expect((await api(ctx, 'POST', `/rides/${rideId}/messages/read`, {}, joao)).body.read).toBe(1);
    expect((await api(ctx, 'GET', `/rides/${rideId}/messages`, undefined, maria)).body.messages[0].read).toBe(true);
  });

  it('valida o texto, e quem não é da corrida não lê', async () => {
    expect((await say(maria, '   ')).status).toBe(400);
    expect((await say(maria, 'x'.repeat(501))).status).toBe(400);
    expect((await api(ctx, 'GET', `/rides/${rideId}/messages`, undefined, ana)).status).toBe(403);
  });

  it('a central lê (ocorrências), mas não escreve', async () => {
    const r = await api(ctx, 'GET', `/rides/${rideId}/messages`, undefined, admin);
    expect(r.body.messages).toHaveLength(2);
    expect(r.body.open).toBe(false);
    expect((await say(admin, 'Oi')).status).toBe(403);
  });

  it('fecha no fim da corrida, vai na cópia dos dados e some depois de 30 dias', async () => {
    await query(`UPDATE rides SET status = 'completed', completed_at = now() WHERE id = $1`, [rideId]);
    expect((await say(maria, 'Obrigada')).status).toBe(409);
    expect((await api(ctx, 'GET', `/rides/${rideId}/messages`, undefined, maria)).body.open).toBe(false);
    const exp = await api(ctx, 'GET', '/me/export', undefined, maria);
    expect(exp.body.mensagensEnviadasNoChat.map((x: any) => x.body)).toEqual(['Estou no portão azul']);

    expect(await purgeOldMessages()).toBe(0);
    await query(`UPDATE rides SET completed_at = now() - interval '31 days' WHERE id = $1`, [rideId]);
    expect(await purgeOldMessages()).toBe(2);
    expect((await one(`SELECT count(*)::int AS n FROM ride_messages WHERE ride_id = $1`, [rideId])).n).toBe(0);
  });
});
