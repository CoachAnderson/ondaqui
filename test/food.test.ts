import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, destino, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { setMercadoPagoGateway, type MercadoPagoGateway, type MpPayment } from '../src/lib/mercadopago.js';
import { isOpenAt, runFoodJobs, SHIFT_OFFER_SEC } from '../src/lib/food.js';
import { drainWebhooks } from '../src/routes/billing.js';

// ---------- Mercado Pago simulado (conta do restaurante) ----------
const REST_TOKEN = 'APP_USR-5555555555555555-cantina-da-praca-000000000000';
const payments = new Map<string, { token: string; pay: MpPayment }>();
const refunds: string[] = [];
let next = 9_000_000_001;
const fake: MercadoPagoGateway = {
  async createPreference() { return { id: 'pref', init_point: 'https://www.mercadopago.com.br/checkout' }; },
  async getPayment(token, id) { const x = payments.get(id); if (!x || x.token !== token) throw new Error('404'); return x.pay; },
  async findPaymentsByReference() { return []; },
  async getAccount(token) { if (token === REST_TOKEN) return { id: '9', nickname: 'CANTINA', site_id: 'MLB' }; throw new Error('401'); },
  async createPixPayment(token, p) {
    const id = String(next++);
    payments.set(id, { token, pay: { id, status: 'pending', external_reference: p.externalReference, transaction_amount: p.amountCents / 100, currency_id: 'BRL' } });
    return { id, status: 'pending', qrCode: `00020126PIX-PEDIDO-${id}`, qrCodeBase64: 'iVBORw0KGgo=' };
  },
  async refundPayment(token, id) { refunds.push(id); const x = payments.get(id)!; x.pay.status = 'refunded'; return { status: 'approved' }; },
};

let ctx: Ctx;
let maria: string, cozinha: string, carlos: string, admin: string;
let restId: string, carlosId: string;
let menu: any[];
const balance = async () => (await one('SELECT balance_cents FROM accounts WHERE id = $1', [restId])).balance_cents as number;
const item = (name: string) => menu.flatMap((s) => s.items).find((i: any) => i.name.startsWith(name));
const casa = { ...destino, address: 'Av. Getúlio Vargas, 2000, Bauru' };

async function pedir(payment: 'app' | 'entrega', extra: Record<string, unknown> = {}) {
  return api(ctx, 'POST', '/food/orders', {
    restaurantId: restId, destination: casa, payment,
    items: [{ itemId: item('Lasanha').id, qty: 1, notes: 'sem cebola' }, { itemId: item('Refrigerante').id, qty: 2 }], ...extra,
  }, maria);
}

beforeAll(async () => {
  setMercadoPagoGateway(fake);
  ctx = await startServer();
  [maria, cozinha, carlos, admin] = await Promise.all([
    login(ctx, '14900000010'), login(ctx, '14900000050'), login(ctx, '14900000022'), login(ctx, '14900000001'),
  ]);
  restId = (await one(`SELECT id FROM accounts WHERE name = 'Cantina da Praça'`)).id;
  carlosId = (await one(`SELECT id FROM users WHERE phone = '14900000022'`)).id;
  await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, carlos);
  await api(ctx, 'POST', '/driver/online', { online: true }, carlos);
  await api(ctx, 'POST', '/driver/location', { lat: -22.3255, lng: -49.0860 }, carlos);
});
afterAll(async () => { setMercadoPagoGateway(null); await stopServer(ctx); });

describe('horário de funcionamento', () => {
  const at = (iso: string) => new Date(iso);
  const h: any = [[], [['18:00', '02:00']], [['11:00', '15:00'], ['18:00', '23:00']], [], [], [], []];
  it('respeita faixas do dia e a que passa da meia-noite', () => {
    expect(isOpenAt(h, at('2026-11-09T22:00:00-03:00'))).toBe(true);   // segunda 22h
    expect(isOpenAt(h, at('2026-11-10T01:30:00-03:00'))).toBe(true);   // terça 1h30, faixa de segunda
    expect(isOpenAt(h, at('2026-11-10T02:30:00-03:00'))).toBe(false);
    expect(isOpenAt(h, at('2026-11-10T12:00:00-03:00'))).toBe(true);   // terça almoço
    expect(isOpenAt(h, at('2026-11-10T16:00:00-03:00'))).toBe(false);
    expect(isOpenAt(h, at('2026-11-08T12:00:00-03:00'))).toBe(false);  // domingo fechado
  });
});

describe('cliente: restaurantes, cardápio e pedido pago na entrega', () => {
  it('lista os restaurantes abertos e mostra o cardápio', async () => {
    const l = await api(ctx, 'GET', `/food/restaurants?lat=${casa.lat}&lng=${casa.lng}`, undefined, maria);
    expect(l.body.enabled).toBe(true);
    expect(l.body.restaurants[0]).toMatchObject({ name: 'Cantina da Praça', open: true, category: 'Italiana', minOrderCents: 2000, pay: { app: false, delivery: true } });
    const r = await api(ctx, 'GET', `/food/restaurants/${restId}`, undefined, maria);
    menu = r.body.menu;
    expect(menu.map((s: any) => s.name)).toEqual(['Massas', 'Pizzas', 'Bebidas']);
    // fotos dos pratos: o cliente vê a do cardápio
    expect(item('Lasanha').hasPhoto).toBe(true);
    const foto = await fetch(`${ctx.base}/food/items/${item('Lasanha').id}/photo`, { headers: { authorization: `Bearer ${maria}` } });
    expect(foto.status).toBe(200);
    expect(foto.headers.get('content-type')).toBe('image/jpeg');
  });

  it('cotação: comida, frete e total; pedido mínimo', async () => {
    const q = await api(ctx, 'POST', '/food/quote', { restaurantId: restId, destination: casa, items: [{ itemId: item('Lasanha').id, qty: 1 }, { itemId: item('Refrigerante').id, qty: 2 }] }, maria);
    expect(q.body.subtotalCents).toBe(3890 + 2 * 650);
    expect(q.body.deliveryFeeCents).toBeGreaterThan(0);
    expect(q.body.totalCents).toBe(q.body.subtotalCents + q.body.deliveryFeeCents);
    expect(q.body.minOrderOk).toBe(true);
    const pouco = await api(ctx, 'POST', '/food/orders', { restaurantId: restId, destination: casa, payment: 'entrega', items: [{ itemId: item('Refrigerante').id, qty: 1 }] }, maria);
    expect(pouco.body.code).toBe('pedido_minimo');
    const app = await pedir('app');
    expect(app.body.code).toBe('pagamento_indisponivel'); // restaurante sem Mercado Pago
  });

  it('pedido na entrega: restaurante aceita, fica pronto, motoboy entrega cobrando na maquininha do restaurante', async () => {
    const before = await balance();
    const r = await pedir('entrega', { notes: 'Portão azul' });
    expect(r.status).toBe(201);
    const o = r.body.order;
    expect(o).toMatchObject({ status: 'novo', payment: 'entrega', payStatus: 'na_entrega', subtotalCents: 5190 });
    expect(o.items[0]).toMatchObject({ name: 'Lasanha à bolonhesa', qty: 1, notes: 'sem cebola' });

    const lista = await api(ctx, 'GET', '/account/food/orders', undefined, cozinha);
    expect(lista.body.orders.map((x: any) => x.id)).toContain(o.id);
    expect(lista.body.orders[0].customer).toMatchObject({ name: 'Maria Passageira' });

    // depois de aceito, o cliente não cancela mais pelo app
    expect((await api(ctx, 'POST', `/account/food/orders/${o.id}/accept`, { prepMin: 20 }, cozinha)).body.order.status).toBe('aceito');
    expect((await api(ctx, 'POST', `/food/orders/${o.id}/cancel`, {}, maria)).body.code).toBe('ja_aceito');

    const pronto = await api(ctx, 'POST', `/account/food/orders/${o.id}/ready`, {}, cozinha);
    const d = pronto.body.order.delivery;
    expect(pronto.body.order.status).toBe('pronto');
    expect(d).toMatchObject({ kind: 'entrega', paymentMethod: 'conta_loja', shift: false });
    expect(d.cod).toMatchObject({ amountCents: o.totalCents, status: 'pendente' });
    expect(await balance()).toBe(before - pronto.body.order.freightCents);
    // o cliente vê o código de entrega; o restaurante, o de coleta
    const cli = (await api(ctx, 'GET', `/food/orders/${o.id}`, undefined, maria)).body.order;
    expect(cli.delivery.deliveryCode).toMatch(/^\d{4}$/);
    expect(cli.delivery.boardingCode).toBeUndefined();

    const rideId = d.id;
    expect((await api(ctx, 'POST', `/rides/${rideId}/accept`, {}, carlos)).status).toBe(200);
    await api(ctx, 'POST', `/rides/${rideId}/pickup-photo`, { image: fakeSelfie }, carlos);
    await api(ctx, 'POST', `/rides/${rideId}/start`, { boardingCode: d.boardingCode }, carlos);
    expect((await api(ctx, 'GET', `/food/orders/${o.id}`, undefined, maria)).body.order.status).toBe('em_entrega');
    await api(ctx, 'POST', `/rides/${rideId}/dropoff-photo`, { image: fakeSelfie }, carlos);
    const cedo = await api(ctx, 'POST', `/rides/${rideId}/complete`, { deliveryCode: cli.delivery.deliveryCode }, carlos);
    expect(cedo.body.code).toBe('cobranca_pendente');
    await api(ctx, 'POST', `/rides/${rideId}/cod/confirm`, { method: 'maquininha' }, carlos);
    expect((await api(ctx, 'POST', `/rides/${rideId}/complete`, { deliveryCode: cli.delivery.deliveryCode }, carlos)).status).toBe(200);

    const fim = (await api(ctx, 'GET', `/food/orders/${o.id}`, undefined, maria)).body.order;
    expect(fim.status).toBe('entregue');
    // comissão da central: 10% da comida, no extrato do restaurante
    const com = await one(`SELECT amount_cents FROM account_ledger WHERE food_order_id = $1 AND kind = 'comissao'`, [o.id]);
    expect(com.amount_cents).toBe(-519);
    expect((await one(`SELECT commission_cents FROM food_orders WHERE id = $1`, [o.id])).commission_cents).toBe(519);
  });
});

describe('pagamento pelo app: Pix no Mercado Pago do restaurante', () => {
  it('o restaurante conecta o Mercado Pago e passa a receber pelo app', async () => {
    expect((await api(ctx, 'PUT', '/account/store/mercadopago', { accessToken: REST_TOKEN }, cozinha)).status).toBe(200);
    const l = await api(ctx, 'GET', `/food/restaurants`, undefined, maria);
    expect(l.body.restaurants[0].pay.app).toBe(true);
  });

  it('Pix pago: o pedido chega ao restaurante; recusado, o Pix volta', async () => {
    const r = await pedir('app');
    const o = r.body.order;
    expect(o).toMatchObject({ status: 'aguardando_pagamento', payStatus: 'pendente' });
    expect(o.pix.qrCode).toContain('PIX-PEDIDO');
    // o restaurante ainda não vê o pedido sem pagamento
    expect((await api(ctx, 'GET', '/account/food/orders', undefined, cozinha)).body.orders.map((x: any) => x.id)).not.toContain(o.id);

    const pid = (await one(`SELECT mp_payment_id FROM food_orders WHERE id = $1`, [o.id])).mp_payment_id;
    payments.get(pid)!.pay.status = 'approved';
    const res = await fetch(`${ctx.base}/webhooks/mercadopago/loja/${restId}?data.id=${pid}&type=payment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    await drainWebhooks();
    const pago = (await api(ctx, 'GET', `/food/orders/${o.id}`, undefined, maria)).body.order;
    expect(pago).toMatchObject({ status: 'novo', payStatus: 'pago', pix: null });

    const rec = await api(ctx, 'POST', `/account/food/orders/${o.id}/refuse`, { reason: 'acabou a massa' }, cozinha);
    expect(rec.body.refunded).toBe(true);
    expect(refunds).toContain(pid);
    expect((await api(ctx, 'GET', `/food/orders/${o.id}`, undefined, maria)).body.order).toMatchObject({ status: 'recusado', payStatus: 'estornado', refuseReason: 'acabou a massa' });
  });

  it('Pix não pago no prazo cancela o pedido; pago depois, é devolvido na hora', async () => {
    const o = (await pedir('app')).body.order;
    await query(`UPDATE food_orders SET created_at = now() - interval '31 minutes' WHERE id = $1`, [o.id]);
    await runFoodJobs();
    expect((await one(`SELECT status FROM food_orders WHERE id = $1`, [o.id])).status).toBe('cancelado');
    const pid = (await one(`SELECT mp_payment_id FROM food_orders WHERE id = $1`, [o.id])).mp_payment_id;
    payments.get(pid)!.pay.status = 'approved';
    const tarde = (await api(ctx, 'GET', `/food/orders/${o.id}`, undefined, maria)).body.order;
    expect(tarde).toMatchObject({ status: 'cancelado', payStatus: 'estornado' });
  });

  it('o cliente cancela um pedido novo; restaurante que não responde tem o pedido cancelado', async () => {
    const a = (await pedir('entrega')).body.order;
    expect((await api(ctx, 'POST', `/food/orders/${a.id}/cancel`, {}, maria)).status).toBe(200);
    const b = (await pedir('entrega')).body.order;
    await query(`UPDATE food_orders SET created_at = now() - interval '16 minutes' WHERE id = $1`, [b.id]);
    await runFoodJobs();
    expect((await one(`SELECT status, cancelled_by FROM food_orders WHERE id = $1`, [b.id]))).toMatchObject({ status: 'cancelado', cancelled_by: 'sistema' });
  });

  it('restaurante pausado ou fora do horário não recebe pedidos', async () => {
    await api(ctx, 'PUT', '/account/food/settings', { open: false }, cozinha);
    expect((await pedir('entrega')).body.code).toBe('restaurante_fechado');
    await api(ctx, 'PUT', '/account/food/settings', { open: true }, cozinha);
  });
});

describe('entregador fixo por turno', () => {
  let shiftId: string;

  it('o restaurante pede o turno (sai dos créditos) e a central escolhe o entregador', async () => {
    const before = await balance();
    const startsAt = new Date(Date.now() + 40 * 60_000).toISOString();
    const r = await api(ctx, 'POST', '/account/food/shifts', { startsAt, hours: 3 }, cozinha);
    expect(r.status).toBe(201);
    shiftId = r.body.shift.id;
    expect(r.body.shift).toMatchObject({ status: 'solicitado', hours: 3, priceCents: 6000, driverCents: 5400 });
    expect(await balance()).toBe(before - 6000);

    const lista = await api(ctx, 'GET', '/admin/food/shifts', undefined, admin);
    expect(lista.body.couriers.map((c: any) => c.id)).toContain(carlosId);
    const a = await api(ctx, 'POST', `/admin/food/shifts/${shiftId}/assign`, { driverId: carlosId }, admin);
    expect(a.body.shift).toMatchObject({ status: 'confirmado', driver: { id: carlosId } });
    const meus = await api(ctx, 'GET', '/driver/food/shifts', undefined, carlos);
    expect(meus.body.shifts[0]).toMatchObject({ id: shiftId, restaurant: { name: 'Cantina da Praça' } });
  });

  it('no turno, a entrega vai só para o fixo e não cobra frete', async () => {
    await query(`UPDATE food_shifts SET starts_at = now() - interval '1 minute', ends_at = now() + interval '3 hours' WHERE id = $1`, [shiftId]);
    const o = (await pedir('entrega')).body.order;
    await api(ctx, 'POST', `/account/food/orders/${o.id}/accept`, {}, cozinha);
    const before = await balance();
    const p = (await api(ctx, 'POST', `/account/food/orders/${o.id}/ready`, {}, cozinha)).body.order;
    expect(p.delivery.shift).toBe(true);
    expect(await balance()).toBe(before);
    const offers = await query(`SELECT driver_id FROM ride_offers WHERE ride_id = $1`, [p.delivery.id]);
    expect(offers.map((x) => x.driver_id)).toEqual([carlosId]);

    const cli = (await api(ctx, 'GET', `/food/orders/${o.id}`, undefined, maria)).body.order;
    await api(ctx, 'POST', `/rides/${p.delivery.id}/accept`, {}, carlos);
    await api(ctx, 'POST', `/rides/${p.delivery.id}/pickup-photo`, { image: fakeSelfie }, carlos);
    await api(ctx, 'POST', `/rides/${p.delivery.id}/start`, { boardingCode: p.delivery.boardingCode }, carlos);
    await api(ctx, 'POST', `/rides/${p.delivery.id}/dropoff-photo`, { image: fakeSelfie }, carlos);
    await api(ctx, 'POST', `/rides/${p.delivery.id}/cod/confirm`, { method: 'maquininha' }, carlos);
    const done = await api(ctx, 'POST', `/rides/${p.delivery.id}/complete`, { deliveryCode: cli.delivery.deliveryCode }, carlos);
    expect(done.body).toMatchObject({ shift: true, commissionCents: 0, driverReceivesCents: 0 });
    expect((await one(`SELECT deliveries FROM food_shifts WHERE id = $1`, [shiftId])).deliveries).toBe(1);
  });

  it('com o fixo sem responder, a entrega vai para o rotativo e o frete é cobrado', async () => {
    const o = (await pedir('entrega')).body.order;
    await api(ctx, 'POST', `/account/food/orders/${o.id}/accept`, {}, cozinha);
    const before = await balance();
    const p = (await api(ctx, 'POST', `/account/food/orders/${o.id}/ready`, {}, cozinha)).body.order;
    expect(p.delivery.shift).toBe(true);
    await query(`UPDATE rides SET requested_at = now() - make_interval(secs => $2) WHERE id = $1`, [p.delivery.id, SHIFT_OFFER_SEC + 5]);
    await runFoodJobs();
    const r = await one(`SELECT shift_id FROM rides WHERE id = $1`, [p.delivery.id]);
    expect(r.shift_id).toBeNull();
    expect(await balance()).toBe(before - p.freightCents);
    // o restaurante cancela: o frete volta
    await api(ctx, 'POST', `/account/food/orders/${o.id}/cancel`, { reason: 'cliente desistiu por telefone' }, cozinha);
    expect(await balance()).toBe(before);
  });

  it('turno concluído entra nos ganhos do entregador e a central dá baixa no repasse', async () => {
    await query(`UPDATE food_shifts SET ends_at = now() - interval '1 minute', starts_at = now() - interval '3 hours 1 minute' WHERE id = $1`, [shiftId]);
    await runFoodJobs();
    expect((await one(`SELECT status FROM food_shifts WHERE id = $1`, [shiftId])).status).toBe('concluido');
    const e = await api(ctx, 'GET', '/driver/earnings?days=1', undefined, carlos);
    expect(e.body.shiftCents).toBe(5400);
    expect((await api(ctx, 'POST', `/admin/food/shifts/${shiftId}/paid`, {}, admin)).status).toBe(200);
    expect((await api(ctx, 'POST', `/admin/food/shifts/${shiftId}/paid`, {}, admin)).status).toBe(409);
  });
});

describe('central e cardápio', () => {
  it('o painel da central mostra o mês e liga o Daqui Food por restaurante', async () => {
    const r = await api(ctx, 'GET', '/admin/food', undefined, admin);
    expect(r.body.rules).toMatchObject({ enabled: true, commissionPct: 10, shiftHourCents: 2000 });
    expect(r.body.month.delivered).toBe(2);
    expect(r.body.month.commissionCents).toBe(1038);
    const farm = r.body.restaurants.find((x: any) => x.name === 'Farmácia Central');
    expect(farm.foodEnabled).toBe(false);
    expect((await api(ctx, 'GET', '/account/food', undefined, await login(ctx, '14900000040'))).body.enabled).toBe(false);
  });

  it('o restaurante cuida do cardápio: categoria, item, "acabou"', async () => {
    const c = await api(ctx, 'POST', '/account/food/categories', { name: 'Sobremesas', sort: 40 }, cozinha);
    const i = await api(ctx, 'POST', '/account/food/items', { categoryId: c.body.category.id, name: 'Tiramisù', priceCents: 1800 }, cozinha);
    expect(i.status).toBe(201);
    expect(i.body.item.hasPhoto).toBe(false);
    expect((await api(ctx, 'PUT', `/account/food/items/${i.body.item.id}/photo`, { image: fakeSelfie }, cozinha)).status).toBe(200);
    expect((await api(ctx, 'GET', '/account/food/menu', undefined, cozinha)).body.menu.flatMap((x: any) => x.items).find((x: any) => x.name === 'Tiramisù').hasPhoto).toBe(true);
    await api(ctx, 'PUT', `/account/food/items/${i.body.item.id}`, { available: false }, cozinha);
    const m = (await api(ctx, 'GET', `/food/restaurants/${restId}`, undefined, maria)).body.menu;
    expect(m.map((s: any) => s.name)).not.toContain('Sobremesas'); // sem itens disponíveis, a seção some
    const pedidoAcabou = await api(ctx, 'POST', '/food/quote', { restaurantId: restId, destination: casa, items: [{ itemId: i.body.item.id, qty: 2 }] }, maria);
    expect(pedidoAcabou.body.code).toBe('item_indisponivel');
    expect((await api(ctx, 'DELETE', `/account/food/categories/${c.body.category.id}`, undefined, cozinha)).body.code).toBe('categoria_com_itens');
  });
});
