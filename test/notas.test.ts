import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { api, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { pushOutbox } from '../src/lib/push.js';

let ctx: Ctx;
let admin: string, maria: string, ana: string, anaId: string, mariaId: string, tenantId: string;

beforeAll(async () => {
  ctx = await startServer();
  admin = await login(ctx, '14900000001');
  maria = await login(ctx, '14900000010');
  ana = await login(ctx, '14900000021');
  anaId = (await one(`SELECT id FROM users WHERE phone = '14900000021'`)).id;
  mariaId = (await one(`SELECT id FROM users WHERE phone = '14900000010'`)).id;
  tenantId = (await one(`SELECT id FROM tenants WHERE slug = 'bauru'`)).id;
  await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[ana-nota-0001]', platform: 'android' }, ana);
});
afterAll(async () => stopServer(ctx));

/** corrida concluída e avaliada direto no banco (a avaliação que dispara o aviso passa pela API) */
async function rated(stars: number | null) {
  return (await one(
    `INSERT INTO rides (tenant_id, passenger_id, driver_id, category_code, status, origin_lat, origin_lng, origin_address,
                        dest_lat, dest_lng, dest_address, distance_km, duration_min, price_cents, payment_method,
                        boarding_code, share_token, driver_rating, completed_at)
     VALUES ($1,$2,$3,'carro','completed',-22.32,-49.08,'Centro',-22.34,-49.05,'Bairro',5,12,2000,'pix','1234',$4,$5, now())
     RETURNING id`,
    [tenantId, mariaId, anaId, randomBytes(9).toString('base64url'), stars],
  )).id as string;
}

describe('aviso de nota baixa', () => {
  it('com poucas avaliações não avisa, mesmo com nota baixa', async () => {
    for (let i = 0; i < 8; i++) await rated(4);
    const last = await rated(null);
    await api(ctx, 'POST', `/rides/${last}/rate`, { stars: 3 }, maria);
    expect((await one('SELECT count(*)::int AS n FROM driver_rating_alerts')).n).toBe(0);
    const me = await api(ctx, 'GET', '/driver/me', undefined, ana);
    expect(me.body.rating).toMatchObject({ ratings: 9, below: 4.5, alert: null });
  });

  it('média abaixo de 4,5 com 10 avaliações: avisa o motorista, uma vez só na semana', async () => {
    pushOutbox.length = 0;
    const r = await rated(null);
    await api(ctx, 'POST', `/rides/${r}/rate`, { stars: 4 }, maria);
    const alerts = await query('SELECT * FROM driver_rating_alerts WHERE driver_id = $1', [anaId]);
    expect(alerts).toHaveLength(1);
    expect(Number(alerts[0].average)).toBe(3.9);
    expect(pushOutbox.some((m) => m.title === 'Sua nota caiu' && m.body.includes('3,90'))).toBe(true);

    const again = await rated(null);
    await api(ctx, 'POST', `/rides/${again}/rate`, { stars: 1 }, maria);
    expect((await one('SELECT count(*)::int AS n FROM driver_rating_alerts')).n).toBe(1);

    const me = await api(ctx, 'GET', '/driver/me', undefined, ana);
    expect(me.body.rating.alert).toMatchObject({ average: 3.9, acknowledged: false });
    await api(ctx, 'POST', '/driver/rating-alert/ack', {}, ana);
    expect((await api(ctx, 'GET', '/driver/me', undefined, ana)).body.rating.alert.acknowledged).toBe(true);
  });

  it('a central vê a nota de cada motorista e a lista de quem está abaixo', async () => {
    const low = await api(ctx, 'GET', '/admin/drivers?status=nota_baixa', undefined, admin);
    expect(low.body.drivers.map((d: any) => d.name)).toEqual(['Ana Motorista']);
    expect(low.body.drivers[0].rating).toMatchObject({ ratings: 11, low: true });
    expect(low.body.drivers[0].rating.alertAt).not.toBeNull();
    const all = await api(ctx, 'GET', '/admin/drivers', undefined, admin);
    expect(all.body.drivers.find((d: any) => d.name === 'João Motorista').rating).toBeNull();
  });

  it('a média usa só as últimas 50 avaliações: quem melhorou sai da lista', async () => {
    for (let i = 0; i < 50; i++) await rated(5);
    const low = await api(ctx, 'GET', '/admin/drivers?status=nota_baixa', undefined, admin);
    expect(low.body.drivers).toHaveLength(0);
  });
});
