import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, centro, destino, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { pushOutbox } from '../src/lib/push.js';
import { setMercadoPagoGateway, type MercadoPagoGateway, type MpPayment } from '../src/lib/mercadopago.js';
import { sendClubReminders } from '../src/lib/club.js';
import { generateCashbackPayouts } from '../src/lib/cashback.js';
import { drainWebhooks } from '../src/routes/billing.js';

const CITY_TOKEN = 'APP_USR-6666666666666666-cidade-bauru-clube-0000000000';
const payments = new Map<string, MpPayment & { token: string }>();
const prefs: any[] = [];
let next = 9_000_000_001;
const fake: MercadoPagoGateway = {
  async createPreference(token, p) { prefs.push({ token, p }); return { id: `pref-${prefs.length}`, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${prefs.length}` }; },
  async getPayment(token, id) { const x = payments.get(id); if (!x || x.token !== token) throw new Error('404'); return x; },
  async findPaymentsByReference(token, ref) { return [...payments.values()].filter((x) => x.token === token && x.external_reference === ref); },
  async getAccount(token) { if (token === CITY_TOKEN) return { id: '1', nickname: 'CIDADE', site_id: 'MLB' }; throw new Error('401'); },
  async createPixPayment() { throw new Error('não usado'); },
};
const pay = (ref: string, cents: number, status = 'approved') => {
  const id = String(next++);
  payments.set(id, { id, token: CITY_TOKEN, status, external_reference: ref, transaction_amount: cents / 100, currency_id: 'BRL' });
  return id;
};

let ctx: Ctx;
let admin: string, maria: string, joao: string, mariaId: string, joaoId: string, tenantId: string;
const today = async () => (await one(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).d as string;
const plusDays = async (n: number) => (await one(`SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date + $1::int)::text AS d`, [n])).d as string;

beforeAll(async () => {
  setMercadoPagoGateway(fake);
  ctx = await startServer();
  [admin, maria, joao] = await Promise.all([login(ctx, '14900000001'), login(ctx, '14900000010'), login(ctx, '14900000020')]);
  mariaId = (await one(`SELECT id FROM users WHERE phone = '14900000010'`)).id;
  joaoId = (await one(`SELECT id FROM users WHERE phone = '14900000020'`)).id;
  tenantId = (await one(`SELECT id FROM tenants WHERE slug = 'bauru'`)).id;
  await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[maria-clube-00001]', platform: 'android' }, maria);
});
afterAll(async () => { setMercadoPagoGateway(null); await stopServer(ctx); });
beforeEach(() => { pushOutbox.length = 0; });

const cotar = (token = maria) => api(ctx, 'POST', '/rides/quote', { origin: centro, destination: destino, category: 'carro' }, token);
const pedir = (extra: Record<string, unknown> = {}, token = maria) =>
  api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix', ...extra }, token);

describe('clube: configuração e assinatura', () => {
  it('vem desligado: não aparece na cotação e não dá para assinar', async () => {
    expect((await api(ctx, 'GET', '/club', undefined, maria)).body).toMatchObject({ member: false, rules: { enabled: false } });
    expect((await cotar()).body.club).toBeNull();
    expect((await api(ctx, 'POST', '/club/checkout', {}, maria)).body.code).toBe('clube_desligado');
  });

  it('o licenciado liga e define os benefícios', async () => {
    const r = await api(ctx, 'PATCH', '/admin/club', {
      enabled: true, name: 'Clube Daqui', priceCents: 1990, discountPct: 10, discountMaxCents: 500, noSurge: true, cashbackMultiplier: 2, priority: true,
    }, admin);
    expect(r.status).toBe(200);
    expect(r.body.rules).toMatchObject({ enabled: true, name: 'Clube Daqui', priceCents: 1990, discountPct: 10, days: 30 });
    expect((await api(ctx, 'PATCH', '/admin/club', { discountPct: 50 }, admin)).status).toBe(400);
    expect((await api(ctx, 'PATCH', '/admin/club', { enabled: false }, maria)).status).toBe(403);
  });

  it('quem não assina vê quanto economizaria, mas paga o preço cheio', async () => {
    const q = (await cotar()).body;
    const off = Math.min(Math.floor(q.priceCents * 0.1), 500);
    expect(q.club).toEqual({ member: false, discountCents: off, surgeWaivedCents: 0, payCents: q.priceCents });
  });

  it('assina pelo Mercado Pago da cidade; confirmado, vale 30 dias', async () => {
    expect((await api(ctx, 'POST', '/club/checkout', {}, maria)).body.code).toBe('mercadopago_nao_configurado');
    expect((await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: CITY_TOKEN }, admin)).status).toBe(200);
    const c = await api(ctx, 'POST', '/club/checkout', {}, maria);
    expect(c.status).toBe(201);
    expect(c.body.amountCents).toBe(1990);
    expect(prefs.at(-1)).toMatchObject({ token: CITY_TOKEN, p: { title: 'OnDaqui Bauru — Clube Daqui (30 dias)' } });
    expect((await api(ctx, 'POST', '/club/sync', {}, maria)).body).toMatchObject({ applied: false });
    pay(c.body.chargeId, 1990);
    const s = await api(ctx, 'POST', '/club/sync', {}, maria);
    expect(s.body).toMatchObject({ applied: true, until: await plusDays(29) });
    const v = (await api(ctx, 'GET', '/club', undefined, maria)).body;
    expect(v).toMatchObject({ member: true, daysLeft: 29, available: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(pushOutbox.some((m) => m.title === 'Bem-vindo ao Clube ✅')).toBe(true);
    // renovar soma 30 dias ao que já tinha
    const c2 = await api(ctx, 'POST', '/club/checkout', {}, maria);
    const paid2 = pay(c2.body.chargeId, 1990);
    expect((await api(ctx, 'POST', '/club/sync', {}, maria)).body.until).toBe(await plusDays(59));
    // pagamento com valor errado não vale
    const c3 = await api(ctx, 'POST', '/club/checkout', {}, maria);
    pay(c3.body.chargeId, 100);
    expect((await api(ctx, 'POST', '/club/sync', {}, maria)).body.applied).toBe(false);
    // estorno tira o mês pago
    payments.get(paid2)!.status = 'refunded';
    const refundId = paid2;
    await fetch(`${ctx.base}/webhooks/mercadopago/t/bauru?data.id=${refundId}&type=payment`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'payment', data: { id: refundId } }),
    });
    await drainWebhooks();
    expect((await one(`SELECT club_until::text AS d FROM users WHERE id = $1`, [mariaId])).d).toBe(await plusDays(29));
  });
});

describe('clube: benefícios na corrida', () => {
  beforeAll(async () => {
    await query(`UPDATE tenants SET current_surge = 1.5, cashback_pct = 5, cashback_max_ride_cents = 300, cashback_max_month_cents = 3000 WHERE id = $1`, [tenantId]);
  });
  afterAll(async () => { await query(`UPDATE tenants SET current_surge = 1 WHERE id = $1`, [tenantId]); });

  it('assinante não paga a dinâmica e ganha o desconto; o motorista recebe o valor cheio', async () => {
    const q = (await cotar()).body;
    expect(q.surge).toBe(1.5);
    const waived = q.priceCents - q.baseCents;
    const off = Math.min(Math.floor(q.baseCents * 0.1), 500);
    expect(waived).toBeGreaterThan(0);
    expect(q.club).toEqual({ member: true, discountCents: waived + off, surgeWaivedCents: waived, payCents: q.priceCents - waived - off });

    const p = await pedir();
    expect(p.status).toBe(201);
    const ride = p.body.ride;
    expect(ride.priceCents).toBe(q.priceCents); // o preço da corrida (o que o motorista recebe) é o cheio
    expect(ride.club).toEqual({ discountCents: waived + off });
    expect(ride.cashback.payCents).toBe(q.priceCents - waived - off);

    await query(`UPDATE rides SET driver_id = $2, status = 'in_progress', accepted_at = now(), started_at = now() WHERE id = $1`, [ride.id, joaoId]);
    expect((await api(ctx, 'GET', `/rides/${ride.id}/payment`, undefined, maria)).body.amountCents).toBe(q.priceCents - waived - off);
    const done = (await api(ctx, 'POST', `/rides/${ride.id}/complete`, {}, joao)).body;
    expect(done).toMatchObject({ priceCents: q.priceCents, collectCents: q.priceCents - waived - off, clubDiscountCents: waived + off });
    // cashback em dobro: 10% sobre o que pagou, teto da corrida também dobrado
    const paid = q.priceCents - waived - off;
    const r = await one(`SELECT cashback_earned_cents FROM rides WHERE id = $1`, [ride.id]);
    expect(r.cashback_earned_cents).toBe(Math.min(Math.floor(paid * 0.1), 600));
    await new Promise((x) => setTimeout(x, 30));
    expect(pushOutbox.find((m) => m.title === 'Você chegou!')?.body).toContain('O Clube economizou');

    const v = (await api(ctx, 'GET', '/club', undefined, maria)).body;
    expect(v.savedMonthCents).toBe(waived + off);
  });

  it('o desconto do Clube entra no acerto da semana com o motorista', async () => {
    const week = (await one(`SELECT date_trunc('week', now())::date::text AS d`)).d;
    const total = (await one(`SELECT sum(cashback_used_cents + club_discount_cents)::int AS t FROM rides WHERE driver_id = $1 AND status = 'completed'`, [joaoId])).t;
    const [p] = await generateCashbackPayouts(week);
    expect(p).toMatchObject({ driver_id: joaoId, cashback_cents: total, amount_cents: total, status: 'open' });
  });

  it('cashback usado vale sobre o que sobra depois do Clube', async () => {
    await query(`INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, expires_at) VALUES ($1, $2, 'ajuste', 50000, now() + interval '30 days')`, [tenantId, mariaId]);
    const p = await pedir({ useCashback: true });
    const ride = p.body.ride;
    const afterClub = ride.priceCents - ride.club.discountCents;
    expect(ride.cashback.usedCents).toBe(Math.floor(afterClub * 0.5));
    expect(ride.cashback.payCents).toBe(afterClub - ride.cashback.usedCents);
    await api(ctx, 'POST', `/rides/${ride.id}/cancel`, {}, maria);
  });

  it('vencido, volta a pagar o preço normal', async () => {
    await query(`UPDATE users SET club_until = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE id = $1`, [mariaId]);
    const q = (await cotar()).body;
    expect(q.club).toMatchObject({ member: false, payCents: q.priceCents });
    const p = await pedir();
    expect(p.body.ride.club).toBeNull();
    expect(p.body.ride.cashback.payCents).toBe(p.body.ride.priceCents);
    await api(ctx, 'POST', `/rides/${p.body.ride.id}/cancel`, {}, maria);
  });
});

describe('clube: prioridade no despacho', () => {
  it('motorista com oferta aberta de um assinante não recebe oferta de quem não assina', async () => {
    await query(`UPDATE users SET club_until = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 10 WHERE id = $1`, [mariaId]);
    await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, joao);
    expect((await api(ctx, 'POST', '/driver/online', { online: true }, joao)).status).toBe(200);
    await api(ctx, 'POST', '/driver/location', { lat: -22.3250, lng: -49.0860 }, joao);
    const assinante = await pedir();
    expect(assinante.body.driversNotified).toBe(1);
    expect(assinante.body.ride.club).not.toBeNull();
    const outro = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true, tenant: 'bauru', name: 'Bia Comum', phone: '14955557777', password: 'senha123', role: 'passenger' });
    const comum = await pedir({}, outro.body.token);
    expect(comum.status).toBe(201);
    expect(comum.body.driversNotified).toBe(0);
    // o motorista recusou a do assinante: a outra corrida já pode ir para ele
    await api(ctx, 'POST', `/rides/${assinante.body.ride.id}/decline`, {}, joao);
    await api(ctx, 'POST', `/rides/${assinante.body.ride.id}/cancel`, {}, maria);
    const o = await one(`SELECT 1 FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [comum.body.ride.id, joaoId]);
    expect(o).toBeFalsy(); // só na próxima rodada
    const { sweepPendingRides } = await import('../src/lib/rides.js');
    await sweepPendingRides();
    expect(await one(`SELECT status FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [comum.body.ride.id, joaoId])).toMatchObject({ status: 'sent' });
    await api(ctx, 'POST', `/rides/${comum.body.ride.id}/cancel`, {}, outro.body.token);
    await api(ctx, 'POST', '/driver/online', { online: false }, joao);
  });
});

describe('clube: central e avisos', () => {
  it('a central dá cortesia pelo celular', async () => {
    const r = await api(ctx, 'POST', '/admin/club/grant', { phone: '14955557777', months: 2, note: 'Cortesia de lançamento' }, admin);
    expect(r.status).toBe(200);
    expect(r.body.until).toBe(await plusDays(59));
    expect((await api(ctx, 'POST', '/admin/club/grant', { phone: '14900000020', months: 1, note: 'motorista' }, admin)).status).toBe(404);
    const adm = (await api(ctx, 'GET', '/admin/club', undefined, admin)).body;
    expect(adm.summary.members).toBe(2);
    expect(adm.summary.revenue_month).toBe(1990); // um mês pago (o outro foi estornado) + cortesia sem valor
    expect(adm.members.find((m: any) => m.name === 'Bia Comum')).toMatchObject({ active: true, months: 1, paid_cents: 0 });
  });

  it('avisa 3 dias antes de vencer, uma vez só', async () => {
    await query(`UPDATE users SET club_until = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 3 WHERE id = $1`, [mariaId]);
    expect(await sendClubReminders()).toBe(1);
    expect(pushOutbox.some((m) => m.title === 'Renove o Clube Daqui' && m.body.includes('vence em 3 dias'))).toBe(true);
    expect(await sendClubReminders()).toBe(0);
    expect(await today()).toMatch(/^\d{4}-/);
  });

  it('os meses do Clube vão na cópia dos dados do passageiro', async () => {
    expect((await api(ctx, 'GET', '/me/export', undefined, maria)).body.clube.length).toBeGreaterThan(0);
  });
});
