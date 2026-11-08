import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { api, centro, destino, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { pushOutbox } from '../src/lib/push.js';
import { smsOutbox } from '../src/lib/sms.js';
import { generateCommissionInvoices } from '../src/lib/commissions.js';
import { generateCashbackPayouts, runCashbackJobs } from '../src/lib/cashback.js';
import { generateStoreInvoices } from '../src/lib/stores.js';

let ctx: Ctx;
let admin: string, maria: string, joao: string, ana: string, loja: string;
let mariaId: string, joaoId: string, anaId: string, tenantId: string, lojaId: string;

beforeAll(async () => {
  ctx = await startServer();
  [admin, maria, joao, ana, loja] = await Promise.all([
    login(ctx, '14900000001'), login(ctx, '14900000010'), login(ctx, '14900000020'), login(ctx, '14900000021'), login(ctx, '14900000040'),
  ]);
  mariaId = (await one(`SELECT id FROM users WHERE phone = '14900000010'`)).id;
  joaoId = (await one(`SELECT id FROM users WHERE phone = '14900000020'`)).id;
  anaId = (await one(`SELECT id FROM users WHERE phone = '14900000021'`)).id;
  tenantId = (await one(`SELECT id FROM tenants WHERE slug = 'bauru'`)).id;
  lojaId = (await one(`SELECT id FROM accounts WHERE name = 'Farmácia Central'`)).id;
  await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[maria-cashback-001]', platform: 'android' }, maria);
  await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[ana-cashback-0001]', platform: 'android' }, ana);
});
afterAll(async () => stopServer(ctx));
beforeEach(() => { pushOutbox.length = 0; smsOutbox.length = 0; });

const saldo = async (token = maria) => (await api(ctx, 'GET', '/cashback', undefined, token)).body;
const pedir = (extra: Record<string, unknown> = {}) =>
  api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix', ...extra }, maria);

/** o motorista já está em viagem (o despacho é testado em outro arquivo) e finaliza pela API */
async function finalizar(rideId: string, driverId = joaoId, token = joao, body: Record<string, unknown> = {}) {
  await query(`UPDATE rides SET driver_id = $2, status = 'in_progress', accepted_at = now(), started_at = now() WHERE id = $1`, [rideId, driverId]);
  const r = await api(ctx, 'POST', `/rides/${rideId}/complete`, body, token);
  expect(r.status).toBe(200);
  return r.body;
}

describe('cashback do licenciado', () => {
  it('vem desligado; o licenciado liga e define as regras', async () => {
    let w = await saldo();
    expect(w).toMatchObject({ balanceCents: 0, rules: { enabled: false } });
    expect((await api(ctx, 'PATCH', '/admin/cashback', { pct: 40 }, admin)).status).toBe(400);
    const r = await api(ctx, 'PATCH', '/admin/cashback', { pct: 5, maxRideCents: 300, maxMonthCents: 2000, days: 60, usePct: 50 }, admin);
    expect(r.status).toBe(200);
    expect(r.body.rules).toEqual({ enabled: true, pct: 5, maxRideCents: 300, maxMonthCents: 2000, days: 60, usePct: 50 });
    // passageiro e motorista não mexem nas regras
    expect((await api(ctx, 'PATCH', '/admin/cashback', { pct: 30 }, maria)).status).toBe(403);
    w = await saldo();
    expect(w.rules.enabled).toBe(true);
  });

  it('a corrida finalizada devolve a % ao passageiro, com aviso e validade', async () => {
    const p = await pedir();
    expect(p.status).toBe(201);
    const price = p.body.ride.priceCents as number;
    const done = await finalizar(p.body.ride.id);
    const earned = Math.min(Math.floor(price * 0.05), 300);
    expect(earned).toBeGreaterThan(0);
    expect(done).toMatchObject({ collectCents: price, cashbackUsedCents: 0 });
    const w = await saldo();
    expect(w.balanceCents).toBe(earned);
    expect(w.entries[0]).toMatchObject({ kind: 'corrida', amountCents: earned });
    expect(w.entries[0].label).toContain('Corrida para');
    const days = (new Date(w.nextExpiry.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);
    const ride = (await api(ctx, 'GET', `/rides/${p.body.ride.id}`, undefined, maria)).body.ride;
    expect(ride.cashback).toEqual({ usedCents: 0, earnedCents: earned, payCents: price });
    await new Promise((r) => setTimeout(r, 30));
    expect(pushOutbox.find((m) => m.title === 'Você chegou!')?.body).toContain('ganhou');
  });

  it('usa o saldo ao pedir: paga menos ao motorista, que recebe o valor cheio no acerto', async () => {
    await query(`INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, expires_at) VALUES ($1, $2, 'ajuste', 5000, now() + interval '30 days')`, [tenantId, mariaId]);
    const before = (await saldo()).balanceCents as number;
    const p = await pedir({ useCashback: true });
    expect(p.status).toBe(201);
    const price = p.body.ride.priceCents as number;
    const used = Math.floor(price * 0.5); // até 50% da corrida
    expect(p.body.ride.cashback).toMatchObject({ usedCents: used, payCents: price - used });
    expect((await saldo()).balanceCents).toBe(before - used);
    // o motorista vê o mesmo valor a receber
    await query(`UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now() WHERE id = $1`, [p.body.ride.id, joaoId]);
    expect((await api(ctx, 'GET', `/rides/${p.body.ride.id}`, undefined, joao)).body.ride.cashback).toMatchObject({ usedCents: used, payCents: price - used, earnedCents: 0 });
    // cancelou: o saldo volta, uma vez só
    expect((await api(ctx, 'POST', `/rides/${p.body.ride.id}/cancel`, {}, maria)).status).toBe(200);
    expect((await saldo()).balanceCents).toBe(before);
    await runCashbackJobs();
    expect((await saldo()).balanceCents).toBe(before);
    expect((await saldo()).entries[0]).toMatchObject({ kind: 'devolucao', amountCents: used });

    // de novo, agora até o fim: o Pix mostra o valor com desconto e o ganho é sobre o que pagou
    const q = await pedir({ useCashback: true });
    await query(`UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now() WHERE id = $1`, [q.body.ride.id, joaoId]);
    expect((await api(ctx, 'GET', `/rides/${q.body.ride.id}/payment`, undefined, maria)).body.amountCents).toBe(price - used);
    const done = await finalizar(q.body.ride.id);
    expect(done).toMatchObject({ priceCents: price, collectCents: price - used, cashbackUsedCents: used });
    const r = await one(`SELECT cashback_earned_cents FROM rides WHERE id = $1`, [q.body.ride.id]);
    expect(r.cashback_earned_cents).toBe(Math.min(Math.floor((price - used) * 0.05), 300));
  });

  it('sem o pedido de usar, não usa; respeita o teto do mês', async () => {
    const p = await pedir();
    expect(p.body.ride.cashback.usedCents).toBe(0);
    await api(ctx, 'POST', `/rides/${p.body.ride.id}/cancel`, {}, maria);
    await api(ctx, 'PATCH', '/admin/cashback', { maxMonthCents: 1 }, admin); // já ganhou mais que isso no mês
    const q = await pedir();
    await finalizar(q.body.ride.id);
    expect((await one(`SELECT cashback_earned_cents FROM rides WHERE id = $1`, [q.body.ride.id])).cashback_earned_cents).toBe(0);
    await api(ctx, 'PATCH', '/admin/cashback', { maxMonthCents: 2000 }, admin);
  });

  it('vence pelo mais antigo primeiro', async () => {
    const outro = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true, tenant: 'bauru', name: 'Bia Vencida', phone: '14955556666', password: 'senha123', role: 'passenger' });
    const bia = outro.body.user.id as string;
    // 300 de um crédito velho (já vencido), dos quais usou 200; e 500 de um novo
    await query(
      `INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, expires_at, created_at) VALUES
         ($1, $2, 'corrida', 300, now() - interval '1 day', now() - interval '61 days'),
         ($1, $2, 'uso', -200, NULL, now() - interval '30 days'),
         ($1, $2, 'corrida', 500, now() + interval '20 days', now() - interval '40 days')`,
      [tenantId, bia],
    );
    const w = await saldo(outro.body.token);
    expect(w.balanceCents).toBe(500); // venceram só os 100 que sobraram do velho
    expect(w.entries[0]).toMatchObject({ kind: 'expirado', amountCents: -100 });
    expect(w.nextExpiry.amountCents).toBe(500);
    await runCashbackJobs();
    expect((await saldo(outro.body.token)).balanceCents).toBe(500);
  });

  it('corrida paga por loja ou Prefeitura não gera cashback do licenciado', async () => {
    const d = await api(ctx, 'POST', '/account/deliveries', {
      destination: { ...destino, name: 'Cliente' }, recipientName: 'Cliente X', recipientPhone: '14977778888', packageDesc: 'Caixa',
    }, loja);
    expect(d.status).toBe(201);
    await query(`UPDATE rides SET pickup_photo_path = 'x', dropoff_photo_path = 'x' WHERE id = $1`, [d.body.delivery.id]);
    await finalizar(d.body.delivery.id, joaoId, joao, { deliveryCode: d.body.delivery.deliveryCode });
    expect(await one(`SELECT 1 FROM cashback_ledger WHERE ride_id = $1`, [d.body.delivery.id])).toBeFalsy();
  });
});

describe('cashback das lojas', () => {
  const entregar = async (recipientPhone: string) => {
    const d = await api(ctx, 'POST', '/account/deliveries', {
      destination: { ...destino, name: 'Cliente' }, recipientName: 'Cliente da Farmácia', recipientPhone, packageDesc: 'Remédios',
    }, loja);
    expect(d.status).toBe(201);
    await query(`UPDATE rides SET pickup_photo_path = 'x', dropoff_photo_path = 'x' WHERE id = $1`, [d.body.delivery.id]);
    await finalizar(d.body.delivery.id, joaoId, joao, { deliveryCode: d.body.delivery.deliveryCode });
    return d.body.delivery.id as string;
  };
  const lojaSaldo = async () => (await one(`SELECT balance_cents FROM accounts WHERE id = $1`, [lojaId])).balance_cents as number;

  it('a loja define quanto dá por pedido', async () => {
    expect((await api(ctx, 'PUT', '/account/store/cashback', { amountCents: 20 }, loja)).body.code).toBe('cashback_minimo');
    expect((await api(ctx, 'PUT', '/account/store/cashback', { amountCents: 300 }, loja)).status).toBe(200);
    expect((await api(ctx, 'GET', '/account/store', undefined, loja)).body.store.cashbackPerOrderCents).toBe(300);
    expect((await api(ctx, 'PUT', '/account/store/cashback', { amountCents: 300 }, maria)).status).toBe(403);
  });

  it('cliente com o app ganha na hora; sai do saldo da loja', async () => {
    const before = (await saldo()).balanceCents as number;
    const store = await lojaSaldo();
    const id = await entregar('14900000010');
    expect((await saldo()).balanceCents).toBe(before + 300);
    expect((await saldo()).entries[0]).toMatchObject({ kind: 'loja', amountCents: 300, label: 'Presente de Farmácia Central' });
    const frete = (await one(`SELECT price_cents FROM rides WHERE id = $1`, [id])).price_cents;
    expect(await lojaSaldo()).toBe(store - frete - 300);
    expect(await one(`SELECT amount_cents FROM account_ledger WHERE ride_id = $1 AND kind = 'cashback'`, [id])).toMatchObject({ amount_cents: -300 });
    await new Promise((r) => setTimeout(r, 30));
    expect(pushOutbox.some((m) => m.title === 'Farmácia Central te deu R$ 3,00 de cashback')).toBe(true);
  });

  it('cliente sem o app: crédito guardado no celular, SMS uma vez por semana, entra no cadastro', async () => {
    await entregar('14933334444');
    await entregar('14933334444');
    expect(smsOutbox.filter((m) => m.to.endsWith('14933334444'))).toHaveLength(1);
    expect(smsOutbox[0].text).toContain('Farmácia Central te deu R$ 3,00 de crédito');
    const adm = (await api(ctx, 'GET', '/admin/cashback', undefined, admin)).body;
    expect(adm.summary.waiting_signup).toBe(600);
    expect(adm.stores[0]).toMatchObject({ name: 'Farmácia Central', orders_month: 3 });
    const novo = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true, tenant: 'bauru', name: 'Cliente Nova', phone: '14933334444', password: 'senha123', role: 'passenger' });
    expect((await saldo(novo.body.token)).balanceCents).toBe(600);
  });

  it('celular de motorista não ganha; loja sem saldo não dá', async () => {
    const id = await entregar('14900000021');
    expect(await one(`SELECT 1 FROM cashback_ledger WHERE ride_id = $1`, [id])).toBeFalsy();
    // o frete levou quase todo o saldo: o cashback não deixa a loja negativa
    const d = await api(ctx, 'POST', '/account/deliveries', {
      destination: { ...destino, name: 'Cliente' }, recipientName: 'Cliente', recipientPhone: '14900000010', packageDesc: 'Remédios',
    }, loja);
    await query(`UPDATE accounts SET balance_cents = 100 WHERE id = $1`, [lojaId]);
    await query(`UPDATE rides SET pickup_photo_path = 'x', dropoff_photo_path = 'x' WHERE id = $1`, [d.body.delivery.id]);
    await finalizar(d.body.delivery.id, joaoId, joao, { deliveryCode: d.body.delivery.deliveryCode });
    expect(await one(`SELECT 1 FROM cashback_ledger WHERE ride_id = $1`, [d.body.delivery.id])).toBeFalsy();
    expect(await lojaSaldo()).toBe(100);
    await query(`UPDATE accounts SET balance_cents = 10000 WHERE id = $1`, [lojaId]);
  });

  it('loja de fatura: o cashback entra na fatura da semana', async () => {
    const week = (await one(`SELECT (date_trunc('week', now()) - interval '7 days')::date::text AS d`)).d;
    await query(`UPDATE accounts SET billing_mode = 'fatura', credit_limit_cents = 50000 WHERE id = $1`, [lojaId]);
    await query(`DELETE FROM account_ledger WHERE account_id = $1`, [lojaId]);
    await query(
      `INSERT INTO account_ledger (account_id, kind, amount_cents, balance_after, created_at) VALUES
         ($1, 'entrega', -1200, -1200, $2::date + 1), ($1, 'cashback', -300, -1500, $2::date + 1)`,
      [lojaId, week],
    );
    const [inv] = await generateStoreInvoices(week);
    expect(inv).toMatchObject({ deliveries: 1, total_cents: 1500 });
    await query(`UPDATE accounts SET billing_mode = 'prepago', credit_limit_cents = 0, balance_cents = 10000 WHERE id = $1`, [lojaId]);
  });
});

describe('acerto do cashback com o motorista', () => {
  let week: string;
  async function ride(driverId: string, price: number, used: number, commission: number) {
    return (await one(
      `INSERT INTO rides (tenant_id, passenger_id, driver_id, category_code, status, origin_lat, origin_lng, origin_address,
                          dest_lat, dest_lng, dest_address, distance_km, duration_min, price_cents, payment_method,
                          boarding_code, share_token, commission_cents, cashback_used_cents, completed_at)
       VALUES ($1,$2,$3,'carro','completed',-22.32,-49.08,'Centro',-22.34,-49.05,'Bairro',5,12,$4,'pix','1234',$5,$6,$7,$8::date + interval '1 day 15 hours')
       RETURNING id`,
      [tenantId, mariaId, driverId, price, randomBytes(9).toString('base64url'), commission, used, week],
    )).id as string;
  }

  beforeAll(async () => {
    week = (await one(`SELECT (date_trunc('week', now()) - interval '7 days')::date::text AS d`)).d;
    // as corridas dos testes anteriores (semana atual) ficam para a próxima semana
    await query(`UPDATE rides SET cashback_used_cents = 0 WHERE completed_at >= date_trunc('week', now())`);
  });

  it('plano Livre: abate da comissão da mesma semana; o que sobra a central paga', async () => {
    await ride(anaId, 3000, 0, 300);
    await ride(anaId, 2000, 500, 200); // comissão 500, cashback 500: zera
    await generateCommissionInvoices(week);
    const [p] = await generateCashbackPayouts(week);
    expect(p).toMatchObject({ driver_id: anaId, cashback_cents: 500, offset_cents: 500, amount_cents: 0, status: 'abatido' });
    const inv = await one(`SELECT * FROM commission_invoices WHERE driver_id = $1 AND period_start = $2::date`, [anaId, week]);
    expect(inv).toMatchObject({ amount_cents: 0, cashback_offset_cents: 500, status: 'paid', paid_by: 'cashback' });
    // rodar de novo não duplica
    expect(await generateCashbackPayouts(week)).toHaveLength(0);
    expect(pushOutbox.some((m) => m.title === 'Cashback da semana' && m.body.includes('abatidos da sua comissão'))).toBe(true);
  });

  it('plano mensal: a central paga por Pix e dá baixa', async () => {
    const lastWeek = (await one(`SELECT ($1::date - 7)::text AS d`, [week])).d;
    week = lastWeek; // outra semana, para não misturar com o teste anterior
    await ride(joaoId, 2500, 800, 0);
    await ride(joaoId, 1800, 400, 0);
    const [p] = await generateCashbackPayouts(week);
    expect(p).toMatchObject({ driver_id: joaoId, rides: 2, cashback_cents: 1200, offset_cents: 0, amount_cents: 1200, status: 'open' });
    let d = (await api(ctx, 'GET', '/driver/cashback', undefined, joao)).body;
    expect(d.payouts[0]).toMatchObject({ amount_cents: 1200, status: 'open' });
    const adm = (await api(ctx, 'GET', '/admin/cashback', undefined, admin)).body;
    expect(adm.summary.open_cents).toBe(1200);
    expect(adm.payouts.find((x: any) => x.id === p.id)).toMatchObject({ driver_name: 'João Motorista', pix_validated: true });
    expect((await api(ctx, 'POST', `/admin/cashback/payouts/${p.id}/mark-paid`, { note: 'Pix enviado' }, admin)).status).toBe(200);
    expect((await api(ctx, 'POST', `/admin/cashback/payouts/${p.id}/mark-paid`, {}, admin)).status).toBe(404);
    d = (await api(ctx, 'GET', '/driver/cashback', undefined, joao)).body;
    expect(d.payouts[0].status).toBe('paid');
    // outro motorista não vê
    expect((await api(ctx, 'GET', '/driver/cashback', undefined, ana)).body.payouts.some((x: any) => x.id === p.id)).toBe(false);
  });
});

describe('ajuste da central e dados do titular', () => {
  it('a central dá cortesia pelo celular e não deixa o saldo negativo', async () => {
    const before = (await saldo()).balanceCents as number;
    let r = await api(ctx, 'POST', '/admin/cashback/adjust', { phone: '(14) 90000-0010', amountCents: 1000, note: 'Desculpe a demora' }, admin);
    expect(r.status).toBe(200);
    expect(r.body.balanceCents).toBe(before + 1000);
    expect((await saldo()).entries[0]).toMatchObject({ kind: 'ajuste', label: 'Desculpe a demora' });
    r = await api(ctx, 'POST', '/admin/cashback/adjust', { phone: '14900000010', amountCents: -(before + 5000), note: 'teste' }, admin);
    expect(r.body.code).toBe('saldo_insuficiente');
    expect((await api(ctx, 'POST', '/admin/cashback/adjust', { phone: '14900000020', amountCents: 100, note: 'motorista' }, admin)).status).toBe(404);
  });

  it('o extrato vai na cópia dos dados do passageiro', async () => {
    const me = (await api(ctx, 'GET', '/me/export', undefined, maria)).body;
    expect(me.cashback.length).toBeGreaterThan(3);
  });
});
