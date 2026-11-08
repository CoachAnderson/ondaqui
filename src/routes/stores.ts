import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, phone, place, uuid } from '../lib/validate.js';
import { encrypt, mask } from '../lib/crypto.js';
import { mp, validSignature } from '../lib/mercadopago.js';
import { saveImage, sendImage } from '../lib/images.js';
import { dispatchRide, loadRide, newBoardingCode, newDeliveryCode, newShareToken, notifyRide, rideView } from '../lib/rides.js';
import { emitTo } from '../lib/realtime.js';
import {
  adjustBalance, checkCodPix, createRecharge, createStoreInvoiceCharge, debitDelivery, markStoreInvoicePaid,
  refundDelivery, reserveDelivery, startCodPix, storeMp,
} from '../lib/stores.js';
import { computeQuote } from './rides.js';
import { checkFoodPix } from '../lib/food.js';
import { later } from './billing.js';

type Params = { Params: { id: string } };

const namedPlace = place.extend({ name: z.string().trim().max(80).optional() })
  .transform(({ name, ...p }) => ({ ...p, address: name && !p.address.startsWith(name) ? `${name} — ${p.address}`.slice(0, 200) : p.address }));

const deliverySchema = z.object({
  origin: namedPlace.optional(),                     // padrão: endereço da loja
  destination: namedPlace,
  size: z.enum(['p', 'g']).default('p'),             // p = cabe na moto; g = carro
  recipientName: z.string().trim().min(2).max(80),
  recipientPhone: phone,
  packageDesc: z.string().trim().min(2).max(200),
  codAmountCents: z.number().int().min(100).max(1_000_000).optional(), // cobrar o produto na entrega
  notes: z.string().trim().max(300).optional(),
  scheduledFor: z.string().datetime({ offset: true }).optional(),
});

/** desconto da loja no frete, arredondado de 10 em 10 centavos */
const withDiscount = (cents: number, pct: number) => Math.max(100, Math.round((cents * (1 - pct / 100)) / 10) * 10);

function storeView(a: any) {
  return {
    id: a.id, name: a.name, active: a.active,
    address: a.address ? { address: a.address, lat: a.lat, lng: a.lng } : null,
    billingMode: a.billing_mode, balanceCents: a.balance_cents, creditLimitCents: a.credit_limit_cents,
    discountPct: Number(a.discount_pct),
    cashbackPerOrderCents: a.cashback_per_order_cents ?? 0,
    pix: { key: a.pix_key, holderName: a.pix_holder_name, validated: a.pix_validated },
    mercadopago: { connected: !!a.mp_access_token_enc, account: a.mp_account_label, webhookSecretSet: !!a.mp_webhook_secret_enc },
    hasLogo: !!a.logo_path,
  };
}

function codView(r: any) {
  if (!r.cod_amount_cents) return null;
  return {
    amountCents: r.cod_amount_cents, method: r.cod_method, status: r.cod_status,
    qrCode: r.cod_method === 'pix_mp' ? r.cod_qr_code : null,
    qrCodeBase64: r.cod_method === 'pix_mp' ? r.cod_qr_base64 : null,
  };
}

export async function storeRoutes(app: FastifyInstance) {
  const operator = { preHandler: requireAuth('account_operator') };
  const admin = { preHandler: requireAuth('tenant_admin') };
  const driver = { preHandler: requireAuth('driver') };

  async function myStore(req: FastifyRequest) {
    const a = await one(`SELECT a.* FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [req.auth.id]);
    if (!a || a.kind !== 'loja') throw notFound('Loja não encontrada');
    return a;
  }

  async function deliveryOf(req: FastifyRequest, accountId: string, id: string) {
    parse(uuid, id);
    const r = await loadRide(id);
    if (!r || r.account_id !== accountId || r.tenant_id !== req.auth.tenantId) throw notFound('Entrega não encontrada');
    return r;
  }

  // ================= loja: dados, Pix, logo e Mercado Pago =================

  app.get('/account/store', operator, async (req) => {
    const a = await myStore(req);
    const invoices = await query(
      `SELECT *, (status = 'open' AND due_date < current_date) AS overdue FROM store_invoices WHERE account_id = $1 ORDER BY period_start DESC LIMIT 12`,
      [a.id],
    );
    return { store: storeView(a), invoices };
  });

  app.put('/account/store/settings', operator, async (req) => {
    const a = await myStore(req);
    const b = parse(z.object({
      address: place.optional(),
      pixKey: z.string().trim().min(3).max(120).optional(),
      pixHolderName: z.string().trim().min(3).max(120).optional(),
    }), req.body);
    const pixChanged = (b.pixKey !== undefined && b.pixKey !== a.pix_key) || (b.pixHolderName !== undefined && b.pixHolderName !== a.pix_holder_name);
    const u = await one(
      `UPDATE accounts SET address = coalesce($2, address), lat = coalesce($3, lat), lng = coalesce($4, lng),
              pix_key = coalesce($5, pix_key), pix_holder_name = coalesce($6, pix_holder_name),
              pix_validated = CASE WHEN $7 THEN false ELSE pix_validated END
        WHERE id = $1 RETURNING *`,
      [a.id, b.address?.address ?? null, b.address?.lat ?? null, b.address?.lng ?? null, b.pixKey ?? null, b.pixHolderName ?? null, pixChanged],
    );
    // chave nova precisa ser conferida de novo pela central (antigolpe)
    if (pixChanged) emitTo(`admin:${req.auth.tenantId}`, 'store:pix', { accountId: a.id });
    return { store: storeView(u) };
  });

  app.put('/account/store/logo', { ...operator, bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const a = await myStore(req);
    const { image } = parse(z.object({ image: z.string().min(100) }), req.body);
    const path = await saveImage('logos', a.id, image);
    await query(`UPDATE accounts SET logo_path = $2 WHERE id = $1`, [a.id, path]);
    return { ok: true };
  });

  app.get('/account/store/logo', operator, async (req, reply) => sendImage(reply, (await myStore(req)).logo_path, 'Logo'));

  app.put('/account/store/mercadopago', operator, async (req) => {
    const a = await myStore(req);
    const b = parse(z.object({
      accessToken: z.string().trim().regex(/^(APP_USR|TEST)-[A-Za-z0-9-]{20,}$/, 'Access Token inválido (começa com APP_USR- ou TEST-)'),
      webhookSecret: z.string().trim().min(16).max(200).optional().or(z.literal('')),
    }), req.body);
    let acc;
    try { acc = await mp().getAccount(b.accessToken); } catch { throw badRequest('O Mercado Pago não aceitou este Access Token.', 'token_recusado'); }
    if (acc.site_id !== 'MLB') throw badRequest('A conta precisa ser do Mercado Pago Brasil', 'conta_fora_do_brasil');
    const label = `${acc.nickname} (${acc.id})`;
    await query(
      `UPDATE accounts SET mp_access_token_enc = $2, mp_account_label = $3, mp_webhook_secret_enc = $4 WHERE id = $1`,
      [a.id, encrypt(b.accessToken), label, b.webhookSecret ? encrypt(b.webhookSecret) : null],
    );
    return { connected: true, account: label, token: mask(b.accessToken) };
  });

  app.delete('/account/store/mercadopago', operator, async (req) => {
    const a = await myStore(req);
    await query(`UPDATE accounts SET mp_access_token_enc = NULL, mp_webhook_secret_enc = NULL, mp_account_label = NULL WHERE id = $1`, [a.id]);
    return { connected: false };
  });

  // ================= loja: créditos, extrato e faturas =================

  app.get('/account/store/ledger', operator, async (req) => {
    const a = await myStore(req);
    const rows = await query(
      `SELECT l.id, l.kind, l.amount_cents, l.balance_after, l.note, l.created_at, l.ride_id, r.recipient_name, r.dest_address
         FROM account_ledger l LEFT JOIN rides r ON r.id = l.ride_id
        WHERE l.account_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 100`,
      [a.id],
    );
    return { balanceCents: a.balance_cents, ledger: rows };
  });

  app.post('/account/store/recharge', operator, async (req, reply) => {
    const a = await myStore(req);
    const { amountCents } = parse(z.object({ amountCents: z.number().int().min(2000).max(500_000) }), req.body);
    reply.code(201);
    return createRecharge(a.id, req.auth.tenantId!, amountCents);
  });

  app.post<Params>('/account/store/invoices/:id/checkout', operator, async (req, reply) => {
    const a = await myStore(req);
    parse(uuid, req.params.id);
    reply.code(201);
    return createStoreInvoiceCharge(req.params.id, a.id, req.auth.tenantId!);
  });

  // ================= loja: entregas =================

  async function quoteFor(req: FastifyRequest, a: any, b: { origin?: any; destination: any; size: 'p' | 'g'; scheduledFor?: string }) {
    const origin = b.origin ?? (a.address ? { lat: a.lat, lng: a.lng, address: a.address } : null);
    if (!origin) throw badRequest('Cadastre o endereço de coleta da loja em Configurações', 'sem_endereco');
    const q = await computeQuote(req.auth.tenantId!, {
      origin, destination: b.destination, category: b.size === 'g' ? 'entrega-carro' : 'entrega', scheduledFor: b.scheduledFor,
    }, ['entrega']);
    return { origin, q, priceCents: withDiscount(q.priceCents, Number(a.discount_pct)) };
  }

  app.post('/account/deliveries/quote', operator, async (req) => {
    const a = await myStore(req);
    const b = parse(deliverySchema.pick({ origin: true, destination: true, size: true }), req.body);
    const { q, priceCents } = await quoteFor(req, a, b);
    return { priceCents, fullPriceCents: q.priceCents, discountPct: Number(a.discount_pct), distanceKm: q.distanceKm, durationMin: q.durationMin };
  });

  app.post('/account/deliveries', operator, async (req, reply) => {
    const a = await myStore(req);
    const b = parse(deliverySchema, req.body);
    const { origin, q, priceCents } = await quoteFor(req, a, b);
    const ride = await tx(async (db) => {
      await reserveDelivery(db, a.id, priceCents);
      const r = await one<{ id: string }>(
        `INSERT INTO rides (tenant_id, passenger_id, account_id, created_by, category_code, kind, vehicle_type, requires, status, scheduled_for,
            origin_lat, origin_lng, origin_address, dest_lat, dest_lng, dest_address, distance_km, duration_min, price_cents, surge,
            payment_method, boarding_code, share_token, license_fee_cents, recipient_name, recipient_phone, package_desc, delivery_code,
            notes, cod_amount_cents, cod_status, route_source, route_polyline)
         VALUES ($1,NULL,$2,$3,$4,'entrega',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'conta_loja',$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
         RETURNING id`,
        [req.auth.tenantId, a.id, req.auth.id, q.category, q.vehicleType, q.requires, q.scheduledFor ? 'scheduled' : 'requested', q.scheduledFor,
         origin.lat, origin.lng, origin.address, b.destination.lat, b.destination.lng, b.destination.address,
         q.distanceKm, q.durationMin, priceCents, q.surge, newBoardingCode(), newShareToken(), q.licenseFeeCents,
         b.recipientName, b.recipientPhone, b.packageDesc, newDeliveryCode(), b.notes ?? null,
         b.codAmountCents ?? null, b.codAmountCents ? 'pendente' : null, q.routeSource, q.routePolyline], db,
      );
      await debitDelivery(db, a.id, r!.id, priceCents, req.auth.id);
      return r!;
    });
    if (!q.scheduledFor) await dispatchRide(ride.id);
    const full = await loadRide(ride.id);
    emitTo(`admin:${req.auth.tenantId}`, 'ride:updated', rideView(full, 'admin'));
    emitTo(`account:${a.id}`, 'ride:updated', rideView(full, 'account'));
    reply.code(201);
    return { delivery: rideView(full, 'account') };
  });

  app.get<{ Querystring: { view?: string; day?: string } }>('/account/deliveries', operator, async (req) => {
    const a = await myStore(req);
    const { view, day } = parse(z.object({
      view: z.enum(['ativas', 'agendadas', 'dia']).default('ativas'),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.query);
    // "ativas" também traz as entregas já feitas com cobrança para a loja conferir (senão ela não vê o prazo correr)
    const where = view === 'ativas' ? `(status IN ('requested','accepted','arrived','in_progress') OR cod_status = 'aguardando_loja')`
      : view === 'agendadas' ? `status = 'scheduled'`
      : `coalesce(scheduled_for, requested_at) >= $2::date AND coalesce(scheduled_for, requested_at) < $2::date + 1`;
    const params: unknown[] = [a.id];
    if (view === 'dia') params.push(day ?? new Date().toISOString().slice(0, 10));
    const rows = await query(`SELECT id FROM rides WHERE account_id = $1 AND ${where} ORDER BY coalesce(scheduled_for, requested_at) DESC LIMIT 300`, params);
    const deliveries = [];
    for (const r of rows) deliveries.push(rideView(await loadRide(r.id), 'account'));
    return { deliveries };
  });

  app.post<Params>('/account/deliveries/:id/cancel', operator, async (req) => {
    const a = await myStore(req);
    const r = await deliveryOf(req, a.id, req.params.id);
    if (!['scheduled', 'requested', 'accepted', 'arrived'].includes(r.status)) throw conflict('O pacote já foi coletado: não dá mais para cancelar');
    await query(
      `UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'loja', cancel_reason = 'cancelada_pela_loja' WHERE id = $1`, [r.id],
    );
    await query(`UPDATE ride_offers SET status = 'closed' WHERE ride_id = $1 AND status = 'sent'`, [r.id]);
    const refunded = await refundDelivery(r.id);
    await notifyRide(r.id);
    return { ok: true, refunded };
  });

  // a loja confere se o dinheiro do produto caiu (Pix pela chave ou maquininha)
  app.post<Params>('/account/deliveries/:id/cod-confirm', operator, async (req) => {
    const a = await myStore(req);
    const r = await deliveryOf(req, a.id, req.params.id);
    const { received } = parse(z.object({ received: z.boolean() }), req.body);
    if (!r.cod_amount_cents || !['aguardando_loja', 'pago'].includes(r.cod_status)) throw conflict('Nada para conferir nesta entrega');
    const status = received ? 'confirmado' : 'contestado';
    await query(`UPDATE rides SET cod_status = $2, cod_settled_by = 'loja', cod_settled_at = now() WHERE id = $1`, [r.id, status]);
    if (!received) emitTo(`admin:${req.auth.tenantId}`, 'store:cod-dispute', { rideId: r.id, store: a.name });
    await notifyRide(r.id);
    return { codStatus: status };
  });

  // ================= motoboy: cobrar o produto na entrega =================

  async function driverRide(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const r = await loadRide(id);
    if (!r || r.driver_id !== req.auth.id) throw notFound('Entrega não encontrada');
    if (!r.cod_amount_cents) throw conflict('Esta entrega não tem cobrança');
    return r;
  }

  async function codFor(rideId: string) {
    const r = await loadRide(rideId);
    const v = codView(r)!;
    if (r.cod_method === 'pix_chave') {
      const s = await one(`SELECT pix_key, pix_holder_name FROM accounts WHERE id = $1`, [r.account_id]);
      return { ...v, pixKey: s?.pix_key, holderName: s?.pix_holder_name,
        warning: `Confira com o cliente: o recebedor do Pix tem que aparecer como ${s?.pix_holder_name}.` };
    }
    return v;
  }

  app.get<Params>('/rides/:id/cod', driver, async (req) => {
    const r = await driverRide(req, req.params.id);
    if (r.cod_method === 'pix_mp' && r.cod_status === 'pendente') {
      try { await checkCodPix(r.id); } catch { /* confere de novo na próxima vez */ }
    }
    return codFor(r.id);
  });

  app.post<Params>('/rides/:id/cod/pix', driver, async (req) => {
    const r = await driverRide(req, req.params.id);
    if (r.status !== 'in_progress') throw conflict('A cobrança acontece na entrega');
    if (r.cod_status !== 'pendente') return codFor(r.id);
    try {
      await startCodPix(r);
    } catch (e: any) {
      if (e.status) throw e;
      throw badRequest('Não foi possível gerar o Pix da loja agora. Use a maquininha ou tente de novo.', 'pix_indisponivel');
    }
    return codFor(r.id);
  });

  // Pix pela chave ou maquininha: o motoboy confirma, a loja confere no painel
  app.post<Params>('/rides/:id/cod/confirm', driver, async (req) => {
    const r = await driverRide(req, req.params.id);
    const { method } = parse(z.object({ method: z.enum(['pix_chave', 'maquininha']) }), req.body);
    if (r.status !== 'in_progress' || r.cod_status !== 'pendente') throw conflict('Ação indisponível nesta etapa');
    if (method === 'pix_chave' && r.cod_method === 'pix_mp') throw conflict('Use o QR do Pix: a confirmação é automática');
    await query(`UPDATE rides SET cod_method = $2, cod_status = 'aguardando_loja', cod_paid_at = now() WHERE id = $1`, [r.id, method]);
    emitTo(`account:${r.account_id}`, 'ride:cod', { rideId: r.id, codStatus: 'aguardando_loja' });
    return codFor(r.id);
  });

  // Mercado Pago da loja avisa que o Pix caiu
  app.post<Params>('/webhooks/mercadopago/loja/:id', async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ ok: false });
    const store = await storeMp(req.params.id);
    if (!store) return reply.code(200).send({ ok: true });
    const q = (req.query ?? {}) as Record<string, string>;
    const body = (req.body ?? {}) as { type?: string; data?: { id?: string | number } };
    const dataId = String(q['data.id'] ?? body.data?.id ?? '');
    if (store.webhookSecret && !validSignature(store.webhookSecret, req.headers['x-signature'] as string, req.headers['x-request-id'] as string, dataId)) {
      return reply.code(401).send({ ok: false });
    }
    reply.code(200).send({ ok: true });
    if (!/^\d{1,20}$/.test(dataId)) return reply;
    later(async () => {
      const r = await one(`SELECT id FROM rides WHERE account_id = $1 AND cod_mp_payment_id = $2`, [req.params.id, dataId]);
      if (r) await checkCodPix(r.id);
      // Daqui Food: Pix do pedido pago pelo app
      const f = await one(`SELECT id FROM food_orders WHERE account_id = $1 AND mp_payment_id = $2`, [req.params.id, dataId]);
      if (f) await checkFoodPix(f.id);
    });
    return reply;
  });

  // ================= licenciado: lojas =================

  async function storeOfTenant(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const a = await one(`SELECT * FROM accounts WHERE id = $1 AND tenant_id = $2 AND kind = 'loja'`, [id, req.auth.tenantId]);
    if (!a) throw notFound('Loja não encontrada');
    return a;
  }

  app.get<Params>('/admin/accounts/:id/ledger', admin, async (req) => {
    const a = await storeOfTenant(req, req.params.id);
    const ledger = await query(
      `SELECT l.*, r.recipient_name FROM account_ledger l LEFT JOIN rides r ON r.id = l.ride_id
        WHERE l.account_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 100`, [a.id],
    );
    const invoices = await query(
      `SELECT *, (status = 'open' AND due_date < current_date) AS overdue FROM store_invoices WHERE account_id = $1 ORDER BY period_start DESC LIMIT 24`, [a.id],
    );
    return { store: storeView(a), ledger, invoices };
  });

  app.post<Params>('/admin/accounts/:id/adjust', admin, async (req) => {
    const a = await storeOfTenant(req, req.params.id);
    const b = parse(z.object({ amountCents: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0), note: z.string().trim().min(3).max(200) }), req.body);
    return { balanceCents: await adjustBalance(a.id, b.amountCents, b.note, req.auth.id) };
  });

  app.post<Params>('/admin/store-invoices/:id/mark-paid', admin, async (req) => {
    parse(uuid, req.params.id);
    return { invoice: await markStoreInvoicePaid(req.params.id, req.auth.tenantId!, req.auth.id) };
  });

  app.get<Params>('/admin/accounts/:id/logo', admin, async (req, reply) => sendImage(reply, (await storeOfTenant(req, req.params.id)).logo_path, 'Logo'));

}

export { codView };
