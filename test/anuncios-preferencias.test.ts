import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, centro, destino, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';

let ctx: Ctx;
let admin: string, maria: string, joao: string, joaoId: string;

beforeAll(async () => {
  ctx = await startServer();
  [admin, maria, joao] = await Promise.all([login(ctx, '14900000001'), login(ctx, '14900000010'), login(ctx, '14900000020')]);
  joaoId = (await one(`SELECT id FROM users WHERE phone = '14900000020'`)).id;
});
afterAll(async () => stopServer(ctx));

describe('anúncios', () => {
  let pizza: string, oficina: string;

  it('o licenciado cadastra anúncios com link seguro e lugar', async () => {
    let r = await api(ctx, 'POST', '/admin/ads', { advertiser: 'Pizzaria do Zé', title: 'Pizza grande por R$ 39', link: 'http://golpe.com', placements: ['inicio'] }, admin);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('https://');
    expect((await api(ctx, 'POST', '/admin/ads', { advertiser: 'X', title: 'Sem lugar', placements: [] }, admin)).status).toBe(400);
    r = await api(ctx, 'POST', '/admin/ads', {
      advertiser: 'Pizzaria do Zé', title: 'Pizza grande por R$ 39', body: 'Entrega grátis no centro', ctaLabel: 'Pedir no WhatsApp',
      link: 'https://wa.me/5514999990000', placements: ['inicio', 'corrida'], priceCents: 15000,
    }, admin);
    expect(r.status).toBe(201);
    pizza = r.body.ad.id;
    r = await api(ctx, 'POST', '/admin/ads', { advertiser: 'Auto Center Bauru', title: 'Troca de óleo com 15% para motoristas', link: 'https://autocenter.com.br', placements: ['motorista'] }, admin);
    oficina = r.body.ad.id;
    expect((await api(ctx, 'POST', '/admin/ads', { advertiser: 'X', title: 'Teste', placements: ['inicio'] }, maria)).status).toBe(403);
  });

  it('cada app vê os anúncios do seu lugar, e cada exibição é contada', async () => {
    let r = await api(ctx, 'GET', '/ads?lugar=inicio', undefined, maria);
    expect(r.body.ad).toMatchObject({ id: pizza, advertiser: 'Pizzaria do Zé', ctaLabel: 'Pedir no WhatsApp', hasImage: false });
    expect((await api(ctx, 'GET', '/ads?lugar=corrida', undefined, maria)).body.ad.id).toBe(pizza);
    expect((await api(ctx, 'GET', '/ads?lugar=motorista', undefined, maria)).body.ad).toBeNull();
    r = await api(ctx, 'GET', '/ads', undefined, joao);
    expect(r.body.ad.id).toBe(oficina);
    expect((await api(ctx, 'GET', '/ads?lugar=inicio', undefined, joao)).body.ad).toBeNull();
    // toque: conta e devolve o link
    r = await api(ctx, 'POST', `/ads/${pizza}/click`, { lugar: 'inicio' }, maria);
    expect(r.body.link).toBe('https://wa.me/5514999990000');
    const list = (await api(ctx, 'GET', '/admin/ads', undefined, admin)).body.ads;
    expect(list.find((a: any) => a.id === pizza)).toMatchObject({ impressions: 2, clicks: 1, impressions7d: 2, live: true, priceCents: 15000 });
  });

  it('pausado ou fora do período não aparece; imagem e exclusão', async () => {
    await api(ctx, 'PATCH', `/admin/ads/${pizza}`, { active: false }, admin);
    expect((await api(ctx, 'GET', '/ads?lugar=inicio', undefined, maria)).body.ad).toBeNull();
    await api(ctx, 'PATCH', `/admin/ads/${pizza}`, { active: true, startsOn: '2099-01-01' }, admin);
    expect((await api(ctx, 'GET', '/ads?lugar=inicio', undefined, maria)).body.ad).toBeNull();
    await api(ctx, 'PATCH', `/admin/ads/${pizza}`, { startsOn: '2020-01-01', endsOn: '2020-12-31' }, admin);
    expect((await api(ctx, 'GET', '/ads?lugar=inicio', undefined, maria)).body.ad).toBeNull();
    await api(ctx, 'PATCH', `/admin/ads/${pizza}`, { endsOn: null }, admin);
    expect((await api(ctx, 'PUT', `/admin/ads/${pizza}/image`, { image: fakeSelfie }, admin)).status).toBe(200);
    const r = await api(ctx, 'GET', '/ads?lugar=inicio', undefined, maria);
    expect(r.body.ad.hasImage).toBe(true);
    expect((await fetch(`${ctx.base}/ads/${pizza}/image`, { headers: { authorization: `Bearer ${maria}` } })).status).toBe(200);
    expect((await api(ctx, 'DELETE', `/admin/ads/${oficina}`, undefined, admin)).status).toBe(200);
    expect((await api(ctx, 'GET', '/ads', undefined, joao)).body.ad).toBeNull();
  });
});

describe('preferências da viagem', () => {
  let rideId: string;

  it('o passageiro escolhe no perfil; "tanto faz" não aparece', async () => {
    let r = await api(ctx, 'GET', '/me/trip-prefs', undefined, maria);
    expect(r.body.prefs).toEqual({ music: 'tanto_faz', talk: 'tanto_faz', ac: 'tanto_faz' });
    expect(r.body.options.music.length).toBeGreaterThan(5);
    expect((await api(ctx, 'PUT', '/me/trip-prefs', { music: 'axe' }, maria)).status).toBe(400);
    r = await api(ctx, 'PUT', '/me/trip-prefs', { music: 'sertanejo', talk: 'silencio', ac: 'tanto_faz' }, maria);
    expect(r.body.summary).toEqual(['Música: Sertanejo', 'Prefiro silêncio']);
    expect((await api(ctx, 'GET', '/me/trip-prefs', undefined, joao)).status).toBe(403);
  });

  it('vão para a corrida e o motorista vê', async () => {
    const p = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix' }, maria);
    rideId = p.body.ride.id;
    expect(p.body.ride.tripPrefs).toMatchObject({ music: 'sertanejo', talk: 'silencio', summary: ['Música: Sertanejo', 'Prefiro silêncio'] });
    await query(`UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now() WHERE id = $1`, [rideId, joaoId]);
    const d = (await api(ctx, 'GET', `/rides/${rideId}`, undefined, joao)).body.ride;
    expect(d.tripPrefs.summary).toEqual(['Música: Sertanejo', 'Prefiro silêncio']);
    // mudar o perfil depois não muda a corrida já pedida
    await api(ctx, 'PUT', '/me/trip-prefs', { music: 'rock' }, maria);
    expect((await api(ctx, 'GET', `/rides/${rideId}`, undefined, joao)).body.ride.tripPrefs.music).toBe('sertanejo');
  });

  it('na avaliação, o passageiro conta se foram respeitadas; entra na nota do motorista', async () => {
    await query(`UPDATE rides SET status = 'completed', completed_at = now() WHERE id = $1`, [rideId]);
    expect((await api(ctx, 'POST', `/rides/${rideId}/rate`, { stars: 5, prefsRespected: true }, maria)).status).toBe(200);
    expect((await one(`SELECT prefs_respected FROM rides WHERE id = $1`, [rideId])).prefs_respected).toBe(true);
    const me = (await api(ctx, 'GET', '/driver/me', undefined, joao)).body;
    expect(me.rating.prefs).toEqual({ asked: 1, respected: 1 });
  });

  it('só para esta corrida; sem preferência, nada aparece; entrega não leva', async () => {
    let p = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix', tripPrefs: { music: 'tanto_faz', talk: 'tanto_faz', ac: 'tanto_faz' } }, maria);
    expect(p.body.ride.tripPrefs).toBeNull();
    await api(ctx, 'POST', `/rides/${p.body.ride.id}/cancel`, {}, maria);
    p = await api(ctx, 'POST', '/rides', {
      origin: centro, destination: destino, paymentMethod: 'pix', category: 'entrega',
      delivery: { recipientName: 'Fulano', recipientPhone: '14999998888', packageDesc: 'Caixa' },
    }, maria);
    expect(p.body.ride.tripPrefs).toBeNull();
    await api(ctx, 'POST', `/rides/${p.body.ride.id}/cancel`, {}, maria);
  });
});
