import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, place, uuid } from '../lib/validate.js';
import { saveImage, sendImage } from '../lib/images.js';
import { sqlDistanceKm } from '../lib/geo.js';
import { CHANNEL_UPDATES, pushTo } from '../lib/push.js';
import { emitTo } from '../lib/realtime.js';
import { addLedger, reserveDelivery } from '../lib/stores.js';
import {
  callCourier, cancelOrder, cancelShift, checkFoodPix, createFoodPix, emitOrder, foodRulesOf, orderView,
  restaurantOpen, restaurantView, SHIFT_SELECT, shiftPrice, shiftView,
} from '../lib/food.js';
import { computeQuote } from './rides.js';

type Params = { Params: { id: string } };

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'horário no formato 18:30');
const hoursSchema = z.array(z.array(z.tuple([hhmm, hhmm]).refine(([a, b]) => a !== b, 'abre e fecha no mesmo horário')).max(4)).length(7);

const itemsSchema = z.array(z.object({
  itemId: uuid,
  qty: z.number().int().min(1).max(50),
  notes: z.string().trim().max(140).optional(),
})).min(1).max(40);

const orderSchema = z.object({
  restaurantId: uuid,
  destination: place,
  items: itemsSchema,
  notes: z.string().trim().max(300).optional(),
});

/** desconto da loja no frete, arredondado de 10 em 10 centavos (igual ao Daqui Entrega para lojas) */
const withDiscount = (cents: number, pct: number) => Math.max(100, Math.round((cents * (1 - pct / 100)) / 10) * 10);

function menuItemView(i: any) {
  return {
    id: i.id, categoryId: i.category_id, name: i.name, description: i.description, priceCents: i.price_cents,
    hasPhoto: !!i.photo_path, available: i.available, sort: i.sort,
  };
}

async function menuOf(accountId: string, onlyAvailable: boolean) {
  const cats = await query(`SELECT * FROM menu_categories WHERE account_id = $1 ORDER BY sort, name`, [accountId]);
  const items = await query(
    `SELECT * FROM menu_items WHERE account_id = $1 ${onlyAvailable ? 'AND available' : ''} ORDER BY sort, name`, [accountId],
  );
  const sections = cats.map((c) => ({ id: c.id, name: c.name, sort: c.sort, items: items.filter((i) => i.category_id === c.id).map(menuItemView) }));
  const loose = items.filter((i) => !i.category_id || !cats.some((c) => c.id === i.category_id));
  if (loose.length) sections.push({ id: null, name: 'Outros', sort: 9999, items: loose.map(menuItemView) });
  return onlyAvailable ? sections.filter((s) => s.items.length) : sections;
}

export async function foodRoutes(app: FastifyInstance) {
  const passenger = { preHandler: requireAuth('passenger') };
  const operator = { preHandler: requireAuth('account_operator') };
  const admin = { preHandler: requireAuth('tenant_admin') };
  const driver = { preHandler: requireAuth('driver') };
  const viewers = { preHandler: requireAuth('passenger', 'account_operator', 'tenant_admin') };

  const tenantOf = (id: string) => one(`SELECT * FROM tenants WHERE id = $1`, [id]);

  async function restaurantFor(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const a = await one(`SELECT * FROM accounts WHERE id = $1 AND tenant_id = $2 AND kind = 'loja' AND food_enabled`, [id, req.auth.tenantId]);
    if (!a) throw notFound('Restaurante não encontrado');
    return a;
  }

  /** Confere os itens no cardápio de hoje e calcula comida, frete e total */
  async function priceOrder(req: FastifyRequest, b: z.infer<typeof orderSchema>) {
    const t = await tenantOf(req.auth.tenantId!);
    if (!t.food_enabled) throw badRequest('O Daqui Food ainda não está disponível nesta cidade', 'food_desligado');
    const a = await restaurantFor(req, b.restaurantId);
    if (!a.address || a.lat == null) throw badRequest('Restaurante sem endereço cadastrado', 'sem_endereco');
    const ids = [...new Set(b.items.map((i) => i.itemId))];
    const rows = await query(`SELECT * FROM menu_items WHERE account_id = $1 AND id = ANY($2::uuid[])`, [a.id, ids]);
    const items = b.items.map((i) => {
      const m = rows.find((r) => r.id === i.itemId);
      if (!m) throw badRequest('Um dos itens não está mais no cardápio. Atualize o carrinho.', 'item_inexistente');
      if (!m.available) throw badRequest(`${m.name} acabou por hoje. Tire do carrinho para continuar.`, 'item_indisponivel');
      return { itemId: m.id, name: m.name, qty: i.qty, priceCents: m.price_cents, notes: i.notes || null };
    });
    const subtotal = items.reduce((s, i) => s + i.qty * i.priceCents, 0);
    const q = await computeQuote(req.auth.tenantId!, {
      origin: { lat: a.lat, lng: a.lng, address: a.address }, destination: b.destination, category: 'entrega',
    } as any, ['entrega']);
    const freight = withDiscount(q.priceCents, Number(a.discount_pct));
    const fee = a.food_free_delivery ? 0 : freight;
    return {
      a, t, items, subtotal, freight, fee, total: subtotal + fee, distanceKm: q.distanceKm, durationMin: q.durationMin,
      open: restaurantOpen(a), minOk: subtotal >= a.food_min_order_cents,
      pay: { app: !!(a.food_pay_app && a.mp_access_token_enc), delivery: !!a.food_pay_delivery },
    };
  }

  async function orderOfCustomer(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const o = await one(`SELECT * FROM food_orders WHERE id = $1 AND customer_id = $2`, [id, req.auth.id]);
    if (!o) throw notFound('Pedido não encontrado');
    return o;
  }

  // ======================= cliente (app do passageiro) =======================

  app.get<{ Querystring: { lat?: string; lng?: string } }>('/food/restaurants', passenger, async (req) => {
    const t = await tenantOf(req.auth.tenantId!);
    if (!t.food_enabled) return { enabled: false, restaurants: [] };
    const q = parse(z.object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() }), req.query);
    const dist = q.lat != null && q.lng != null ? sqlDistanceKm('a.lat', 'a.lng', '$2', '$3') : 'NULL';
    const rows = await query(
      `SELECT a.*, ${dist} AS dist FROM accounts a
        WHERE a.tenant_id = $1 AND a.kind = 'loja' AND a.food_enabled AND a.active AND a.lat IS NOT NULL
          AND EXISTS (SELECT 1 FROM menu_items i WHERE i.account_id = a.id AND i.available)`,
      q.lat != null && q.lng != null ? [t.id, q.lat, q.lng] : [t.id],
    );
    const list = rows.map((a) => restaurantView(a, { distanceKm: a.dist ?? undefined }));
    list.sort((x, y) => Number(y.open) - Number(x.open) || (x.distanceKm ?? 0) - (y.distanceKm ?? 0) || x.name.localeCompare(y.name));
    return { enabled: true, restaurants: list };
  });

  app.get<Params>('/food/restaurants/:id', passenger, async (req) => {
    const a = await restaurantFor(req, req.params.id);
    return { restaurant: restaurantView(a), menu: await menuOf(a.id, true) };
  });

  app.get<Params>('/food/restaurants/:id/logo', viewers, async (req, reply) => sendImage(reply, (await restaurantFor(req, req.params.id)).logo_path, 'Logo'));

  app.get<Params>('/food/items/:id/photo', viewers, async (req, reply) => {
    parse(uuid, req.params.id);
    const i = await one(
      `SELECT i.photo_path FROM menu_items i JOIN accounts a ON a.id = i.account_id WHERE i.id = $1 AND a.tenant_id = $2`,
      [req.params.id, req.auth.tenantId],
    );
    return sendImage(reply, i?.photo_path, 'Foto');
  });

  app.post('/food/quote', passenger, async (req) => {
    const b = parse(orderSchema, req.body);
    const p = await priceOrder(req, b);
    return {
      items: p.items, subtotalCents: p.subtotal, deliveryFeeCents: p.fee, totalCents: p.total,
      distanceKm: p.distanceKm, prepMin: p.a.food_prep_min, open: p.open,
      minOrderCents: p.a.food_min_order_cents, minOrderOk: p.minOk, pay: p.pay,
    };
  });

  app.post('/food/orders', passenger, async (req, reply) => {
    const b = parse(orderSchema.extend({ payment: z.enum(['app', 'entrega']) }), req.body);
    const p = await priceOrder(req, b);
    if (!p.open) throw conflict('O restaurante está fechado agora', 'restaurante_fechado');
    if (!p.minOk) throw badRequest(`Pedido mínimo deste restaurante: R$ ${(p.a.food_min_order_cents / 100).toFixed(2).replace('.', ',')}`, 'pedido_minimo');
    if (!(b.payment === 'app' ? p.pay.app : p.pay.delivery)) throw badRequest(b.payment === 'app' ? 'Este restaurante não recebe pelo app. Pague na entrega.' : 'Este restaurante só recebe pelo app.', 'pagamento_indisponivel');
    const me = await one(`SELECT name, phone FROM users WHERE id = $1`, [req.auth.id]);
    const o = await tx(async (db) => {
      // o restaurante precisa ter como pagar o frete (créditos ou fatura em dia) para receber pedidos
      try { await reserveDelivery(db, p.a.id, p.freight); } catch { throw conflict('O restaurante não está recebendo pedidos agora. Tente mais tarde.', 'restaurante_indisponivel'); }
      return one(
        `INSERT INTO food_orders (tenant_id, account_id, customer_id, customer_name, customer_phone, items, subtotal_cents,
            delivery_fee_cents, freight_cents, total_cents, payment, pay_status, status, dest_lat, dest_lng, dest_address, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [req.auth.tenantId, p.a.id, req.auth.id, me.name, me.phone, JSON.stringify(p.items), p.subtotal, p.fee, p.freight, p.total,
         b.payment, b.payment === 'app' ? 'pendente' : 'na_entrega', b.payment === 'app' ? 'aguardando_pagamento' : 'novo',
         b.destination.lat, b.destination.lng, b.destination.address, b.notes ?? null], db,
      );
    });
    if (b.payment === 'app') {
      try {
        await createFoodPix(o, p.a.name);
      } catch (e: any) {
        await query(`UPDATE food_orders SET status = 'cancelado', cancelled_by = 'sistema', cancelled_at = now(), refuse_reason = 'Pix indisponível' WHERE id = $1`, [o.id]);
        if (e.status) throw e;
        throw badRequest('Não foi possível gerar o Pix do restaurante agora. Tente de novo ou pague na entrega.', 'pix_indisponivel');
      }
    } else {
      emitTo(`account:${o.account_id}`, 'food:new', { orderId: o.id, number: Number(o.number) });
    }
    await emitOrder(o.id);
    reply.code(201);
    return { order: await orderView(await one(`SELECT * FROM food_orders WHERE id = $1`, [o.id]), 'customer') };
  });

  app.get('/food/orders', passenger, async (req) => {
    const rows = await query(`SELECT * FROM food_orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30`, [req.auth.id]);
    const orders = [];
    for (const o of rows) orders.push(await orderView(o, 'customer'));
    return { orders };
  });

  app.get<Params>('/food/orders/:id', passenger, async (req) => {
    let o = await orderOfCustomer(req, req.params.id);
    if (o.payment === 'app' && o.pay_status === 'pendente' && o.mp_payment_id) {
      try { await checkFoodPix(o.id); } catch { /* confere de novo na próxima vez */ }
      o = await one(`SELECT * FROM food_orders WHERE id = $1`, [o.id]);
    }
    return { order: await orderView(o, 'customer') };
  });

  app.post<Params>('/food/orders/:id/cancel', passenger, async (req) => {
    const o = await orderOfCustomer(req, req.params.id);
    if (!['aguardando_pagamento', 'novo'].includes(o.status)) {
      throw conflict('O restaurante já aceitou o pedido. Para cancelar, fale com o restaurante.', 'ja_aceito');
    }
    const r = await cancelOrder(o, 'cliente', 'cancelado pelo cliente');
    if (o.status === 'novo') emitTo(`account:${o.account_id}`, 'food:cancelled', { orderId: o.id, number: Number(o.number) });
    return { ok: true, refunded: r.refunded };
  });

  // ======================= restaurante (painel da loja) =======================

  async function myRestaurant(req: FastifyRequest) {
    const a = await one(`SELECT a.* FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [req.auth.id]);
    if (!a || a.kind !== 'loja') throw notFound('Loja não encontrada');
    if (!a.food_enabled) throw notFound('O Daqui Food não está ligado para esta loja. Fale com a central.');
    return a;
  }

  async function orderOfStore(req: FastifyRequest, accountId: string, id: string) {
    parse(uuid, id);
    const o = await one(`SELECT * FROM food_orders WHERE id = $1 AND account_id = $2`, [id, accountId]);
    if (!o) throw notFound('Pedido não encontrado');
    return o;
  }

  app.get('/account/food', operator, async (req) => {
    const a = await one(`SELECT a.* FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [req.auth.id]);
    if (!a || a.kind !== 'loja') throw notFound('Loja não encontrada');
    if (!a.food_enabled) return { enabled: false };
    const t = await tenantOf(a.tenant_id);
    const today = await one(
      `SELECT count(*) FILTER (WHERE status = 'entregue')::int AS delivered,
              coalesce(sum(subtotal_cents) FILTER (WHERE status = 'entregue'), 0)::int AS sales_cents,
              count(*) FILTER (WHERE status IN ('novo','aceito','pronto','em_entrega'))::int AS open
         FROM food_orders WHERE account_id = $1 AND created_at >= (now() AT TIME ZONE 'America/Sao_Paulo')::date AT TIME ZONE 'America/Sao_Paulo'`,
      [a.id],
    );
    return {
      enabled: true,
      restaurant: { ...restaurantView(a), mercadopagoConnected: !!a.mp_access_token_enc, payAppSetting: a.food_pay_app },
      rules: { commissionPct: Number(a.food_commission_pct ?? t.food_commission_pct), shiftHourCents: t.food_shift_hour_cents, cityEnabled: !!t.food_enabled },
      today: { delivered: today.delivered, salesCents: today.sales_cents, open: today.open },
    };
  });

  app.put('/account/food/settings', operator, async (req) => {
    const a = await myRestaurant(req);
    const b = parse(z.object({
      open: z.boolean().optional(),
      category: z.string().trim().min(2).max(40).optional(),
      description: z.string().trim().max(200).optional(),
      hours: hoursSchema.optional(),
      prepMin: z.number().int().min(5).max(180).optional(),
      minOrderCents: z.number().int().min(0).max(100_000).optional(),
      freeDelivery: z.boolean().optional(),
      payApp: z.boolean().optional(),
      payDelivery: z.boolean().optional(),
    }), req.body);
    const payApp = b.payApp ?? a.food_pay_app;
    const payDelivery = b.payDelivery ?? a.food_pay_delivery;
    if (!payApp && !payDelivery) throw badRequest('Deixe pelo menos uma forma de pagamento', 'sem_pagamento');
    const u = await one(
      `UPDATE accounts SET food_open = coalesce($2, food_open), food_category = coalesce($3, food_category),
              food_description = coalesce($4, food_description), food_hours = coalesce($5::jsonb, food_hours),
              food_prep_min = coalesce($6, food_prep_min), food_min_order_cents = coalesce($7, food_min_order_cents),
              food_free_delivery = coalesce($8, food_free_delivery), food_pay_app = $9, food_pay_delivery = $10
        WHERE id = $1 RETURNING *`,
      [a.id, b.open ?? null, b.category ?? null, b.description ?? null, b.hours ? JSON.stringify(b.hours) : null,
       b.prepMin ?? null, b.minOrderCents ?? null, b.freeDelivery ?? null, payApp, payDelivery],
    );
    return { restaurant: { ...restaurantView(u), mercadopagoConnected: !!u.mp_access_token_enc, payAppSetting: u.food_pay_app } };
  });

  // ---------- cardápio ----------

  app.get('/account/food/menu', operator, async (req) => ({ menu: await menuOf((await myRestaurant(req)).id, false) }));

  app.post('/account/food/categories', operator, async (req, reply) => {
    const a = await myRestaurant(req);
    const b = parse(z.object({ name: z.string().trim().min(2).max(40), sort: z.number().int().min(0).max(9999).default(100) }), req.body);
    reply.code(201);
    return { category: await one(`INSERT INTO menu_categories (account_id, name, sort) VALUES ($1,$2,$3) RETURNING id, name, sort`, [a.id, b.name, b.sort]) };
  });

  app.put<Params>('/account/food/categories/:id', operator, async (req) => {
    const a = await myRestaurant(req);
    parse(uuid, req.params.id);
    const b = parse(z.object({ name: z.string().trim().min(2).max(40).optional(), sort: z.number().int().min(0).max(9999).optional() }), req.body);
    const c = await one(
      `UPDATE menu_categories SET name = coalesce($3, name), sort = coalesce($4, sort) WHERE id = $1 AND account_id = $2 RETURNING id, name, sort`,
      [req.params.id, a.id, b.name ?? null, b.sort ?? null],
    );
    if (!c) throw notFound('Categoria não encontrada');
    return { category: c };
  });

  app.delete<Params>('/account/food/categories/:id', operator, async (req) => {
    const a = await myRestaurant(req);
    parse(uuid, req.params.id);
    const n = await one(`SELECT count(*)::int AS n FROM menu_items WHERE category_id = $1`, [req.params.id]);
    if (n?.n) throw conflict('Mova ou apague os itens desta categoria antes', 'categoria_com_itens');
    await query(`DELETE FROM menu_categories WHERE id = $1 AND account_id = $2`, [req.params.id, a.id]);
    return { ok: true };
  });

  const itemSchema = z.object({
    categoryId: uuid.nullable().optional(),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).optional(),
    priceCents: z.number().int().min(50).max(1_000_000),
    available: z.boolean().default(true),
    sort: z.number().int().min(0).max(9999).default(100),
  });

  async function checkCategory(accountId: string, categoryId: string | null | undefined) {
    if (!categoryId) return;
    const c = await one(`SELECT 1 FROM menu_categories WHERE id = $1 AND account_id = $2`, [categoryId, accountId]);
    if (!c) throw badRequest('Categoria não encontrada', 'categoria_invalida');
  }

  app.post('/account/food/items', operator, async (req, reply) => {
    const a = await myRestaurant(req);
    const b = parse(itemSchema, req.body);
    await checkCategory(a.id, b.categoryId);
    const i = await one(
      `INSERT INTO menu_items (account_id, category_id, name, description, price_cents, available, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a.id, b.categoryId ?? null, b.name, b.description ?? null, b.priceCents, b.available, b.sort],
    );
    reply.code(201);
    return { item: menuItemView(i) };
  });

  app.put<Params>('/account/food/items/:id', operator, async (req) => {
    const a = await myRestaurant(req);
    parse(uuid, req.params.id);
    const b = parse(itemSchema.partial(), req.body);
    if (b.categoryId !== undefined) await checkCategory(a.id, b.categoryId);
    const i = await one(
      `UPDATE menu_items SET
          category_id = CASE WHEN $3 THEN $4::uuid ELSE category_id END,
          name = coalesce($5, name), description = CASE WHEN $6 THEN $7 ELSE description END,
          price_cents = coalesce($8, price_cents), available = coalesce($9, available), sort = coalesce($10, sort)
        WHERE id = $1 AND account_id = $2 RETURNING *`,
      [req.params.id, a.id, b.categoryId !== undefined, b.categoryId ?? null, b.name ?? null,
       b.description !== undefined, b.description || null, b.priceCents ?? null, b.available ?? null, b.sort ?? null],
    );
    if (!i) throw notFound('Item não encontrado');
    return { item: menuItemView(i) };
  });

  app.delete<Params>('/account/food/items/:id', operator, async (req) => {
    const a = await myRestaurant(req);
    parse(uuid, req.params.id);
    await query(`DELETE FROM menu_items WHERE id = $1 AND account_id = $2`, [req.params.id, a.id]);
    return { ok: true };
  });

  app.put<Params>('/account/food/items/:id/photo', { ...operator, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const a = await myRestaurant(req);
    parse(uuid, req.params.id);
    const { image } = parse(z.object({ image: z.string().min(100) }), req.body);
    const exists = await one(`SELECT 1 FROM menu_items WHERE id = $1 AND account_id = $2`, [req.params.id, a.id]);
    if (!exists) throw notFound('Item não encontrado');
    const path = await saveImage('cardapio', req.params.id, image);
    await query(`UPDATE menu_items SET photo_path = $2 WHERE id = $1`, [req.params.id, path]);
    return { ok: true };
  });

  // ---------- pedidos ----------

  app.get<{ Querystring: { view?: string; day?: string } }>('/account/food/orders', operator, async (req) => {
    const a = await myRestaurant(req);
    const { view, day } = parse(z.object({
      view: z.enum(['ativos', 'dia']).default('ativos'),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.query);
    const rows = view === 'ativos'
      ? await query(`SELECT * FROM food_orders WHERE account_id = $1 AND status IN ('novo','aceito','pronto','em_entrega') ORDER BY created_at`, [a.id])
      : await query(
        `SELECT * FROM food_orders WHERE account_id = $1 AND status <> 'aguardando_pagamento'
            AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = $2::date ORDER BY created_at DESC`,
        [a.id, day ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })],
      );
    const orders = [];
    for (const o of rows) orders.push(await orderView(o, 'store'));
    return { orders };
  });

  app.post<Params>('/account/food/orders/:id/accept', operator, async (req) => {
    const a = await myRestaurant(req);
    const o = await orderOfStore(req, a.id, req.params.id);
    const { prepMin } = parse(z.object({ prepMin: z.number().int().min(5).max(180).optional() }), req.body ?? {});
    if (o.status !== 'novo') throw conflict('Este pedido não está esperando aceite');
    const minutes = prepMin ?? a.food_prep_min;
    await query(`UPDATE food_orders SET status = 'aceito', accepted_at = now(), prep_min = $2 WHERE id = $1`, [o.id, minutes]);
    if (o.customer_id) {
      await pushTo(o.customer_id, {
        title: `${a.name} aceitou seu pedido`, body: `Fica pronto em cerca de ${minutes} min. Avisamos quando sair para entrega.`,
        data: { type: 'food', orderId: o.id }, channelId: CHANNEL_UPDATES,
      }).catch(() => {});
    }
    await emitOrder(o.id);
    return { order: await orderView(await one(`SELECT * FROM food_orders WHERE id = $1`, [o.id]), 'store') };
  });

  app.post<Params>('/account/food/orders/:id/refuse', operator, async (req) => {
    const a = await myRestaurant(req);
    const o = await orderOfStore(req, a.id, req.params.id);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    if (o.status !== 'novo') throw conflict('Só dá para recusar um pedido novo. Use cancelar.');
    const r = await cancelOrder(o, 'restaurante', reason);
    return { ok: true, refunded: r.refunded };
  });

  app.post<Params>('/account/food/orders/:id/call-courier', operator, async (req) => {
    const a = await myRestaurant(req);
    const o = await orderOfStore(req, a.id, req.params.id);
    await callCourier(o.id, req.auth.id);
    return { order: await orderView(await one(`SELECT * FROM food_orders WHERE id = $1`, [o.id]), 'store') };
  });

  // pronto para retirar: chama o entregador, se ainda não chamou
  app.post<Params>('/account/food/orders/:id/ready', operator, async (req) => {
    const a = await myRestaurant(req);
    const o = await orderOfStore(req, a.id, req.params.id);
    if (o.status !== 'aceito') throw conflict('Só um pedido aceito pode ficar pronto');
    await query(`UPDATE food_orders SET status = 'pronto', ready_at = now() WHERE id = $1`, [o.id]);
    await callCourier(o.id, req.auth.id);
    return { order: await orderView(await one(`SELECT * FROM food_orders WHERE id = $1`, [o.id]), 'store') };
  });

  app.post<Params>('/account/food/orders/:id/cancel', operator, async (req) => {
    const a = await myRestaurant(req);
    const o = await orderOfStore(req, a.id, req.params.id);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    const r = await cancelOrder(o, 'restaurante', reason);
    return { ok: true, refunded: r.refunded };
  });

  // ---------- entregador fixo por turno ----------

  app.get('/account/food/shifts', operator, async (req) => {
    const a = await myRestaurant(req);
    const rows = await query(`${SHIFT_SELECT} WHERE s.account_id = $1 AND s.starts_at > now() - interval '30 days' ORDER BY s.starts_at DESC LIMIT 60`, [a.id]);
    const t = await tenantOf(a.tenant_id);
    return { shifts: rows.map(shiftView), hourCents: t.food_shift_hour_cents };
  });

  app.post('/account/food/shifts', operator, async (req, reply) => {
    const a = await myRestaurant(req);
    const b = parse(z.object({
      startsAt: z.string().datetime({ offset: true }),
      hours: z.number().int().min(2).max(12),
      notes: z.string().trim().max(200).optional(),
    }), req.body);
    const start = new Date(b.startsAt);
    if (start.getTime() < Date.now() + 30 * 60_000) throw badRequest('Peça o turno com pelo menos 30 minutos de antecedência', 'turno_em_cima');
    if (start.getTime() > Date.now() + 30 * 86_400_000) throw badRequest('Peça turnos para os próximos 30 dias', 'turno_longe');
    const t = await tenantOf(a.tenant_id);
    const { priceCents, driverCents } = shiftPrice(t, b.hours);
    const s = await tx(async (db) => {
      await reserveDelivery(db, a.id, priceCents);
      const s = await one(
        `INSERT INTO food_shifts (tenant_id, account_id, starts_at, ends_at, hours, price_cents, driver_cents, notes)
         VALUES ($1,$2,$3,$3::timestamptz + make_interval(hours => $4),$4,$5,$6,$7) RETURNING *`,
        [a.tenant_id, a.id, start.toISOString(), b.hours, priceCents, driverCents, b.notes ?? null], db,
      );
      await addLedger(db, a.id, 'turno', -priceCents, { shiftId: s.id, note: `turno de entregador fixo (${b.hours} h)`, by: req.auth.id });
      return s;
    });
    emitTo(`admin:${a.tenant_id}`, 'food:shift', { shiftId: s.id, restaurant: a.name });
    reply.code(201);
    return { shift: shiftView(s) };
  });

  app.post<Params>('/account/food/shifts/:id/cancel', operator, async (req) => {
    const a = await myRestaurant(req);
    parse(uuid, req.params.id);
    const s = await one(`SELECT * FROM food_shifts WHERE id = $1 AND account_id = $2`, [req.params.id, a.id]);
    if (!s) throw notFound('Turno não encontrado');
    if (new Date(s.starts_at).getTime() < Date.now() + 60 * 60_000 && s.status === 'confirmado') {
      throw conflict('Turno confirmado só pode ser cancelado até 1 hora antes. Fale com a central.', 'turno_em_cima');
    }
    await cancelShift(s.id, req.auth.id);
    return { ok: true };
  });

  // ======================= central (painel do licenciado) =======================

  app.get('/admin/food', admin, async (req) => {
    const t = await tenantOf(req.auth.tenantId!);
    const restaurants = await query(
      `SELECT a.*, (SELECT count(*) FROM menu_items i WHERE i.account_id = a.id)::int AS items,
              (SELECT count(*) FROM food_orders o WHERE o.account_id = a.id AND o.status = 'entregue'
                  AND o.delivered_at > date_trunc('month', now()))::int AS month_orders,
              (SELECT coalesce(sum(commission_cents), 0) FROM food_orders o WHERE o.account_id = a.id AND o.status = 'entregue'
                  AND o.delivered_at > date_trunc('month', now()))::int AS month_commission
         FROM accounts a WHERE a.tenant_id = $1 AND a.kind = 'loja' ORDER BY a.food_enabled DESC, a.name`,
      [t.id],
    );
    const month = await one(
      `SELECT count(*) FILTER (WHERE status = 'entregue')::int AS delivered,
              count(*) FILTER (WHERE status IN ('recusado','cancelado'))::int AS cancelled,
              coalesce(sum(subtotal_cents) FILTER (WHERE status = 'entregue'), 0)::int AS sales_cents,
              coalesce(sum(commission_cents) FILTER (WHERE status = 'entregue'), 0)::int AS commission_cents,
              coalesce(sum(freight_cents) FILTER (WHERE status = 'entregue'), 0)::int AS freight_cents
         FROM food_orders WHERE tenant_id = $1 AND created_at > date_trunc('month', now())`,
      [t.id],
    );
    const shifts = await one(
      `SELECT coalesce(sum(price_cents - driver_cents), 0)::int AS margin_cents, count(*)::int AS n
         FROM food_shifts WHERE tenant_id = $1 AND status = 'concluido' AND ends_at > date_trunc('month', now())`, [t.id],
    );
    return {
      rules: foodRulesOf(t),
      month: {
        delivered: month.delivered, cancelled: month.cancelled, salesCents: month.sales_cents,
        commissionCents: month.commission_cents, freightCents: month.freight_cents,
        shiftMarginCents: shifts.margin_cents, shifts: shifts.n,
      },
      restaurants: restaurants.map((a) => ({
        id: a.id, name: a.name, active: a.active, foodEnabled: a.food_enabled, category: a.food_category,
        open: restaurantOpen(a), items: a.items, hasAddress: a.lat != null,
        commissionPct: a.food_commission_pct == null ? null : Number(a.food_commission_pct),
        mercadopagoConnected: !!a.mp_access_token_enc, monthOrders: a.month_orders, monthCommissionCents: a.month_commission,
      })),
    };
  });

  app.patch('/admin/food', admin, async (req) => {
    const b = parse(z.object({
      enabled: z.boolean().optional(),
      commissionPct: z.number().min(0).max(50).optional(),
      shiftHourCents: z.number().int().min(0).max(100_000).optional(),
      shiftCommissionPct: z.number().min(0).max(50).optional(),
    }), req.body);
    const t = await one(
      `UPDATE tenants SET food_enabled = coalesce($2, food_enabled), food_commission_pct = coalesce($3, food_commission_pct),
              food_shift_hour_cents = coalesce($4, food_shift_hour_cents), food_shift_commission_pct = coalesce($5, food_shift_commission_pct)
        WHERE id = $1 RETURNING *`,
      [req.auth.tenantId, b.enabled ?? null, b.commissionPct ?? null, b.shiftHourCents ?? null, b.shiftCommissionPct ?? null],
    );
    return { rules: foodRulesOf(t) };
  });

  app.patch<Params>('/admin/food/restaurants/:id', admin, async (req) => {
    parse(uuid, req.params.id);
    const b = parse(z.object({
      foodEnabled: z.boolean().optional(),
      category: z.string().trim().min(2).max(40).optional(),
      commissionPct: z.number().min(0).max(50).nullable().optional(),
    }), req.body);
    const a = await one(
      `UPDATE accounts SET food_enabled = coalesce($3, food_enabled), food_category = coalesce($4, food_category),
              food_commission_pct = CASE WHEN $5 THEN $6::numeric ELSE food_commission_pct END
        WHERE id = $1 AND tenant_id = $2 AND kind = 'loja' RETURNING id, name, food_enabled, food_category, food_commission_pct`,
      [req.params.id, req.auth.tenantId, b.foodEnabled ?? null, b.category ?? null, b.commissionPct !== undefined, b.commissionPct ?? null],
    );
    if (!a) throw notFound('Loja não encontrada');
    return { restaurant: { id: a.id, name: a.name, foodEnabled: a.food_enabled, category: a.food_category,
      commissionPct: a.food_commission_pct == null ? null : Number(a.food_commission_pct) } };
  });

  app.get<{ Querystring: { day?: string } }>('/admin/food/orders', admin, async (req) => {
    const { day } = parse(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    const rows = await query(
      `SELECT * FROM food_orders WHERE tenant_id = $1 AND status <> 'aguardando_pagamento'
          AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = $2::date ORDER BY created_at DESC LIMIT 300`,
      [req.auth.tenantId, day ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })],
    );
    const orders = [];
    for (const o of rows) orders.push(await orderView(o, 'admin'));
    return { orders };
  });

  app.post<Params>('/admin/food/orders/:id/cancel', admin, async (req) => {
    parse(uuid, req.params.id);
    const o = await one(`SELECT * FROM food_orders WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth.tenantId]);
    if (!o) throw notFound('Pedido não encontrado');
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    return { ok: true, ...(await cancelOrder(o, 'central', reason)) };
  });

  app.get<{ Querystring: { view?: string } }>('/admin/food/shifts', admin, async (req) => {
    const { view } = parse(z.object({ view: z.enum(['proximos', 'concluidos']).default('proximos') }), req.query);
    const rows = view === 'proximos'
      ? await query(`${SHIFT_SELECT} WHERE s.tenant_id = $1 AND s.status IN ('solicitado','confirmado') ORDER BY s.starts_at`, [req.auth.tenantId])
      : await query(`${SHIFT_SELECT} WHERE s.tenant_id = $1 AND s.status = 'concluido' ORDER BY s.driver_paid_at NULLS FIRST, s.starts_at DESC LIMIT 200`, [req.auth.tenantId]);
    // entregadores que podem pegar turno: moto ou carro, com entregas marcadas
    const couriers = await query(
      `SELECT u.id, u.name, d.vehicle_type, d.vehicle_model, d.vehicle_plate FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE u.tenant_id = $1 AND d.status = 'approved' AND NOT u.blocked AND 'entrega' = ANY(d.services_opt_in)
          AND d.vehicle_type IN ('moto','carro') ORDER BY d.vehicle_type DESC, u.name`,
      [req.auth.tenantId],
    );
    return { shifts: rows.map(shiftView), couriers: couriers.map((c) => ({ id: c.id, name: c.name, vehicle: `${c.vehicle_model} · ${c.vehicle_plate}`, vehicleType: c.vehicle_type })) };
  });

  app.post<Params>('/admin/food/shifts/:id/assign', admin, async (req) => {
    parse(uuid, req.params.id);
    const { driverId } = parse(z.object({ driverId: uuid }), req.body);
    const d = await one(
      `SELECT u.id, u.name FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE u.id = $1 AND u.tenant_id = $2 AND d.status = 'approved' AND NOT u.blocked AND 'entrega' = ANY(d.services_opt_in)
          AND d.vehicle_type IN ('moto','carro')`,
      [driverId, req.auth.tenantId],
    );
    if (!d) throw badRequest('Escolha um entregador aprovado que faz entregas', 'entregador_invalido');
    const s = await one(
      `UPDATE food_shifts SET driver_id = $3, status = 'confirmado'
        WHERE id = $1 AND tenant_id = $2 AND status IN ('solicitado','confirmado') AND ends_at > now() RETURNING *`,
      [req.params.id, req.auth.tenantId, driverId],
    );
    if (!s) throw conflict('Este turno não está aberto');
    const clash = await one(
      `SELECT 1 FROM food_shifts WHERE driver_id = $1 AND id <> $2 AND status = 'confirmado' AND starts_at < $4 AND ends_at > $3`,
      [driverId, s.id, s.starts_at, s.ends_at],
    );
    if (clash) {
      await query(`UPDATE food_shifts SET driver_id = NULL, status = 'solicitado' WHERE id = $1`, [s.id]);
      throw conflict('Este entregador já tem outro turno nesse horário', 'turno_conflito');
    }
    const a = await one(`SELECT name, address FROM accounts WHERE id = $1`, [s.account_id]);
    const when = new Date(s.starts_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    await pushTo(driverId, {
      title: 'Turno fixo confirmado', body: `${a.name}, ${when}, ${s.hours} h. Fique online perto do restaurante.`,
      data: { type: 'food_shift' }, channelId: CHANNEL_UPDATES,
    }).catch(() => {});
    emitTo(`account:${s.account_id}`, 'food:shift', { shiftId: s.id, status: 'confirmado' });
    return { shift: shiftView((await one(`${SHIFT_SELECT} WHERE s.id = $1`, [s.id]))) };
  });

  app.post<Params>('/admin/food/shifts/:id/cancel', admin, async (req) => {
    parse(uuid, req.params.id);
    const s = await one(`SELECT id, account_id FROM food_shifts WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth.tenantId]);
    if (!s) throw notFound('Turno não encontrado');
    await cancelShift(s.id, req.auth.id);
    emitTo(`account:${s.account_id}`, 'food:shift', { shiftId: s.id, status: 'cancelado' });
    return { ok: true };
  });

  // repasse ao entregador fixo (a central paga por Pix e dá baixa)
  app.post<Params>('/admin/food/shifts/:id/paid', admin, async (req) => {
    parse(uuid, req.params.id);
    const s = await one(
      `UPDATE food_shifts SET driver_paid_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'concluido' AND driver_paid_at IS NULL RETURNING *`,
      [req.params.id, req.auth.tenantId],
    );
    if (!s) throw conflict('Turno não concluído ou já pago');
    return { ok: true };
  });

  // ======================= entregador =======================

  app.get('/driver/food/shifts', driver, async (req) => {
    const rows = await query(
      `${SHIFT_SELECT} WHERE s.driver_id = $1 AND (s.status = 'confirmado' OR (s.status = 'concluido' AND s.ends_at > now() - interval '7 days'))
        ORDER BY s.starts_at LIMIT 30`,
      [req.auth.id],
    );
    return { shifts: rows.map(shiftView), now: new Date().toISOString() };
  });

}
