import { config } from './config.js';
import { one, pool, query, tx, type Db } from './db.js';
import { badRequest, conflict } from './errors.js';
import { mp } from './mercadopago.js';
import { CHANNEL_UPDATES, pushTo } from './push.js';
import { emitTo } from './realtime.js';
import { dispatchRide, loadRide, newBoardingCode, newDeliveryCode, newShareToken, rideView } from './rides.js';
import { addLedger, debitDelivery, refundDelivery, reserveDelivery, storeMp } from './stores.js';
import { computeQuote } from '../routes/rides.js';

/**
 * Daqui Food: o cliente escolhe o restaurante e os pratos no app e paga DIRETO ao restaurante
 * (Pix do Mercado Pago do restaurante pelo app, ou na entrega: Pix ou maquininha do restaurante).
 * A central entrega com os motoboys da cidade e cobra do restaurante o frete e uma comissão por pedido entregue
 * (créditos ou fatura semanal, como no Daqui Entrega para lojas).
 * Entregador: rotativo (o mais próximo) ou fixo por turno; se o fixo estiver ocupado, o pedido vai para o rotativo.
 */

/** Pix do pedido pelo app: vale por este tempo; depois o pedido é cancelado */
export const PAY_TIMEOUT_MIN = 30;
/** Restaurante que não responde a um pedido novo neste tempo: o pedido é cancelado (e o Pix devolvido) */
export const ACCEPT_TIMEOUT_MIN = 15;
/** Quanto tempo a entrega espera o entregador fixo aceitar antes de ir para o rotativo */
export const SHIFT_OFFER_SEC = 60;

const TZ = 'America/Sao_Paulo';
const money = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
const firstName = (n: string | null) => (n ? n.trim().split(/\s+/)[0] : null);
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export type Hours = [string, string][][];

/** Dia da semana (0 = domingo) e minuto do dia no horário de Brasília */
function localNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { wd, min: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Aberto agora pelos horários? Faixa que passa da meia-noite (18:00–02:00) vale até o começo do dia seguinte. */
export function isOpenAt(hours: Hours, d = new Date()) {
  const { wd, min } = localNow(d);
  const today = hours?.[wd] ?? [];
  for (const [a, b] of today) {
    const s = toMin(a), e = toMin(b);
    if (e > s ? min >= s && min < e : min >= s) return true;
  }
  const yesterday = hours?.[(wd + 6) % 7] ?? [];
  for (const [a, b] of yesterday) {
    const s = toMin(a), e = toMin(b);
    if (e <= s && min < e) return true;
  }
  return false;
}

export const restaurantOpen = (a: any) => !!(a.active && a.food_enabled && a.food_open && isOpenAt(a.food_hours));
export const commissionPctOf = (a: any, t: any) => Number(a.food_commission_pct ?? t.food_commission_pct);

export function foodRulesOf(t: any) {
  return {
    enabled: !!t.food_enabled, commissionPct: Number(t.food_commission_pct),
    shiftHourCents: t.food_shift_hour_cents, shiftCommissionPct: Number(t.food_shift_commission_pct),
  };
}

export function restaurantView(a: any, extra: { distanceKm?: number } = {}) {
  return {
    id: a.id, name: a.name, category: a.food_category, description: a.food_description,
    address: a.address, lat: a.lat, lng: a.lng, hasLogo: !!a.logo_path,
    open: restaurantOpen(a), paused: !a.food_open, hours: a.food_hours as Hours,
    prepMin: a.food_prep_min, minOrderCents: a.food_min_order_cents, freeDelivery: a.food_free_delivery,
    pay: { app: !!(a.food_pay_app && a.mp_access_token_enc), delivery: !!a.food_pay_delivery },
    ...(extra.distanceKm != null ? { distanceKm: Math.round(extra.distanceKm * 10) / 10 } : {}),
  };
}

export type FoodViewer = 'customer' | 'store' | 'admin';

/** Pedido com a entrega. O código de entrega só o cliente vê; o de coleta, só o restaurante. */
export async function orderView(o: any, viewer: FoodViewer) {
  const r = o.ride_id ? await loadRide(o.ride_id) : null;
  const store = await one(`SELECT name, logo_path, address, food_prep_min FROM accounts WHERE id = $1`, [o.account_id]);
  const base = {
    id: o.id, number: Number(o.number), status: o.status,
    restaurant: { id: o.account_id, name: store?.name, hasLogo: !!store?.logo_path, address: store?.address },
    items: o.items, subtotalCents: o.subtotal_cents, deliveryFeeCents: o.delivery_fee_cents, totalCents: o.total_cents,
    payment: o.payment, payStatus: o.pay_status,
    pix: o.payment === 'app' && o.pay_status === 'pendente' && o.status === 'aguardando_pagamento' && viewer === 'customer' ? { qrCode: o.pix_qr_code, qrCodeBase64: o.pix_qr_base64 } : null,
    prepMin: o.prep_min,
    readyBy: o.accepted_at && o.prep_min ? new Date(new Date(o.accepted_at).getTime() + o.prep_min * 60_000).toISOString() : null,
    destination: { lat: o.dest_lat, lng: o.dest_lng, address: o.dest_address },
    notes: o.notes, refuseReason: o.refuse_reason, cancelledBy: o.cancelled_by,
    createdAt: o.created_at, paidAt: o.paid_at, acceptedAt: o.accepted_at, readyAt: o.ready_at,
    deliveredAt: o.delivered_at, cancelledAt: o.cancelled_at,
  };
  const courier = r && r.driver_id
    ? { name: viewer === 'customer' ? firstName(r.driver_name) : r.driver_name,
        vehicle: { plate: r.vehicle_plate, model: r.vehicle_model, color: r.vehicle_color },
        location: r.driver_lat != null ? { lat: r.driver_lat, lng: r.driver_lng } : null,
        phone: viewer === 'customer' ? undefined : r.driver_phone }
    : null;
  if (viewer === 'customer') {
    return { ...base, delivery: r ? { status: r.status, courier, deliveryCode: r.delivery_code, shareToken: r.share_token, cod: rideView(r, 'passenger').cod } : null };
  }
  return {
    ...base,
    customer: { name: o.customer_name, phone: o.customer_phone },
    freightCents: o.freight_cents, commissionCents: o.commission_cents,
    delivery: r ? { ...rideView(r, 'account'), courier, shift: !!r.shift_id } : null,
  };
}

/** Avisa o cliente, o restaurante e a central de que o pedido mudou */
export async function emitOrder(orderId: string, db: Db = pool) {
  const o = await one(`SELECT * FROM food_orders WHERE id = $1`, [orderId], db);
  if (!o) return;
  if (o.customer_id) emitTo(`user:${o.customer_id}`, 'food:order', await orderView(o, 'customer'));
  const store = await orderView(o, 'store');
  emitTo(`account:${o.account_id}`, 'food:order', store);
  emitTo(`admin:${o.tenant_id}`, 'food:order', store);
}

async function pushCustomer(o: any, title: string, body: string) {
  if (!o.customer_id) return;
  await pushTo(o.customer_id, { title, body, data: { type: 'food', orderId: o.id }, channelId: CHANNEL_UPDATES }).catch(() => {});
}

// ---------- pagamento pelo app: Pix no Mercado Pago do restaurante ----------

const payerEmail = (id: string) => {
  const host = (() => { try { return new URL(config.publicApiUrl).hostname; } catch { return 'ondaqui.com.br'; } })();
  const domain = /^(localhost|127\.|\d+\.\d+\.\d+\.\d+$)/.test(host) ? 'ondaqui.com.br' : host.replace(/^api\./, '');
  return `pedido-${id.slice(0, 8)}@${domain}`;
};

export async function createFoodPix(o: any, storeName: string) {
  const store = await storeMp(o.account_id);
  if (!store) throw badRequest('Este restaurante não recebe pelo app. Escolha pagar na entrega.', 'sem_pagamento_app');
  const pix = await mp().createPixPayment(store.token, {
    amountCents: o.total_cents,
    description: `Pedido ${o.number} — ${storeName} (OnDaqui)`,
    externalReference: `food:${o.id}`,
    notificationUrl: `${config.publicApiUrl}/webhooks/mercadopago/loja/${o.account_id}`,
    payerEmail: payerEmail(o.id),
    expiresInMinutes: PAY_TIMEOUT_MIN,
  }, `food-${o.id}`);
  await query(`UPDATE food_orders SET mp_payment_id = $2, pix_qr_code = $3, pix_qr_base64 = $4 WHERE id = $1`, [o.id, pix.id, pix.qrCode, pix.qrCodeBase64]);
}

/** Confere o Pix direto no Mercado Pago do restaurante (não confia em quem avisa) */
export async function checkFoodPix(orderId: string) {
  const o = await one(`SELECT * FROM food_orders WHERE id = $1`, [orderId]);
  if (!o || o.payment !== 'app' || o.pay_status !== 'pendente' || !o.mp_payment_id) return o?.pay_status ?? null;
  const store = await storeMp(o.account_id);
  if (!store) return o.pay_status;
  const p = await mp().getPayment(store.token, o.mp_payment_id);
  if (p.status !== 'approved' || p.external_reference !== `food:${o.id}` || Math.round(p.transaction_amount * 100) !== o.total_cents) return o.pay_status;
  const up = await one(
    `UPDATE food_orders SET pay_status = 'pago', paid_at = now(),
            status = CASE WHEN status = 'aguardando_pagamento' THEN 'novo' ELSE status END
      WHERE id = $1 AND pay_status = 'pendente' RETURNING *`, [o.id],
  );
  if (!up) return 'pago';
  if (up.status === 'cancelado') {
    // pagou depois de o pedido expirar: devolve na hora
    await refundFoodPayment(up).catch((e) => console.error('[food] estorno de Pix atrasado falhou', e));
  } else {
    emitTo(`account:${up.account_id}`, 'food:new', { orderId: up.id, number: Number(up.number) });
  }
  await emitOrder(up.id);
  return 'pago';
}

/** Devolve o Pix do pedido pago pelo app (recusado ou cancelado) */
export async function refundFoodPayment(o: any) {
  if (o.payment !== 'app' || o.pay_status !== 'pago' || !o.mp_payment_id) return false;
  const store = await storeMp(o.account_id);
  if (!store) throw conflict('O restaurante desconectou o Mercado Pago: devolva o Pix ao cliente pelo app do banco.', 'sem_mercadopago');
  await mp().refundPayment(store.token, o.mp_payment_id, `food-refund-${o.id}`);
  await query(`UPDATE food_orders SET pay_status = 'estornado' WHERE id = $1`, [o.id]);
  return true;
}

// ---------- entrega ----------

/** Turno de entregador fixo valendo agora para o restaurante */
export const activeShift = (accountId: string, db: Db = pool) => one(
  `SELECT * FROM food_shifts WHERE account_id = $1 AND status = 'confirmado' AND driver_id IS NOT NULL
      AND starts_at <= now() AND ends_at > now() ORDER BY starts_at LIMIT 1`, [accountId], db,
);

/**
 * Chama o entregador do pedido. Com turno fixo valendo, a entrega vai primeiro para o fixo (sem frete:
 * está no turno). Sem fixo, ou com ele ocupado, vai para o rotativo e o frete sai dos créditos (ou entra na fatura).
 */
export async function callCourier(orderId: string, by: string | null) {
  const o = await one(`SELECT * FROM food_orders WHERE id = $1`, [orderId]);
  if (!o) throw badRequest('Pedido não encontrado');
  if (!['aceito', 'pronto'].includes(o.status)) throw conflict('Aceite o pedido antes de chamar o entregador', 'pedido_nao_aceito');
  if (o.ride_id) {
    const cur = await one(`SELECT status FROM rides WHERE id = $1`, [o.ride_id]);
    if (cur && cur.status !== 'cancelled') return o.ride_id as string;
  }
  const a = await one(`SELECT * FROM accounts WHERE id = $1`, [o.account_id]);
  const origin = { lat: a.lat, lng: a.lng, address: a.address };
  const q = await computeQuote(o.tenant_id, {
    origin, destination: { lat: o.dest_lat, lng: o.dest_lng, address: o.dest_address }, category: 'entrega',
  } as any, ['entrega']);
  const rideId = await tx(async (db) => {
    const shift = await activeShift(o.account_id, db);
    if (!shift) await reserveDelivery(db, o.account_id, o.freight_cents);
    const r = await one<{ id: string }>(
      `INSERT INTO rides (tenant_id, passenger_id, account_id, created_by, category_code, kind, vehicle_type, requires, status,
          origin_lat, origin_lng, origin_address, dest_lat, dest_lng, dest_address, distance_km, duration_min, price_cents, surge,
          payment_method, boarding_code, share_token, license_fee_cents, recipient_name, recipient_phone, package_desc, delivery_code,
          notes, cod_amount_cents, cod_status, route_source, route_polyline, food_order_id, shift_id)
       VALUES ($1,NULL,$2,$3,$4,'entrega',$5,$6,'requested',$7,$8,$9,$10,$11,$12,$13,$14,$15,1,'conta_loja',$16,$17,$18,$19,$20,$21,$22,
               $23,$24,$25,$26,$27,$28,$29)
       RETURNING id`,
      [o.tenant_id, o.account_id, by, q.category, q.vehicleType, q.requires,
       origin.lat, origin.lng, origin.address, o.dest_lat, o.dest_lng, o.dest_address,
       q.distanceKm, q.durationMin, o.freight_cents, newBoardingCode(), newShareToken(), q.licenseFeeCents,
       o.customer_name ?? 'Cliente', o.customer_phone, `Pedido ${o.number} · ${a.name}`, newDeliveryCode(), o.notes,
       o.payment === 'entrega' ? o.total_cents : null, o.payment === 'entrega' ? 'pendente' : null,
       q.routeSource, q.routePolyline, o.id, shift?.id ?? null], db,
    );
    if (!shift) await debitDelivery(db, o.account_id, r!.id, o.freight_cents, by);
    await query(`UPDATE food_orders SET ride_id = $2 WHERE id = $1`, [o.id, r!.id], db);
    return r!.id;
  });
  await dispatchRide(rideId);
  const full = await loadRide(rideId);
  emitTo(`admin:${o.tenant_id}`, 'ride:updated', rideView(full, 'admin'));
  await emitOrder(o.id);
  return rideId;
}

/** O fixo não pôde (ocupado, offline, recusou ou não respondeu): a entrega vai para o rotativo, com frete */
export async function moveToRotation(rideId: string) {
  const moved = await tx(async (db) => {
    const r = await one(`SELECT * FROM rides WHERE id = $1 FOR UPDATE`, [rideId], db);
    if (!r?.shift_id || r.status !== 'requested') return null;
    await query(`UPDATE rides SET shift_id = NULL WHERE id = $1`, [rideId], db);
    const closed = await query<{ driver_id: string }>(
      `UPDATE ride_offers SET status = 'closed' WHERE ride_id = $1 AND status = 'sent' RETURNING driver_id`, [rideId], db,
    );
    await one(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [r.account_id], db);
    // o pedido já foi aceito para o cliente: entrega mesmo se os créditos ficarem negativos
    await debitDelivery(db, r.account_id, rideId, r.price_cents, null);
    return closed;
  });
  if (moved) emitTo(moved.map((d) => `user:${d.driver_id}`), 'ride:offer:closed', { rideId });
  return !!moved;
}

/**
 * Despacho da entrega do turno: oferece só ao fixo. Devolve 'aguardando' (oferta aberta dentro do prazo),
 * 'ofertado' ou 'rotativo' (o despacho segue para os mais próximos).
 */
export async function shiftDispatchState(ride: any): Promise<{ state: 'aguardando' | 'ofertar' | 'rotativo'; driverId?: string }> {
  const shift = await one(`SELECT driver_id, status, ends_at FROM food_shifts WHERE id = $1`, [ride.shift_id]);
  if (!shift?.driver_id || shift.status !== 'confirmado') return { state: 'rotativo' };
  const offer = await one(`SELECT status FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [ride.id, shift.driver_id]);
  if (!offer) return { state: 'ofertar', driverId: shift.driver_id };
  const young = Date.now() - new Date(ride.requested_at).getTime() < SHIFT_OFFER_SEC * 1000;
  if (offer.status === 'sent' && young) return { state: 'aguardando' };
  return { state: 'rotativo' };
}

/** Chamado a cada mudança da entrega (notifyRide): leva o andamento para o pedido */
export async function syncFoodOrder(r: any) {
  const o = await one(`SELECT * FROM food_orders WHERE id = $1`, [r.food_order_id]);
  if (!o || o.ride_id !== r.id || ['entregue', 'cancelado', 'recusado'].includes(o.status)) return;
  if (r.status === 'in_progress' && o.status !== 'em_entrega') {
    await query(`UPDATE food_orders SET status = 'em_entrega', ready_at = coalesce(ready_at, now()) WHERE id = $1`, [o.id]);
    await pushCustomer(o, 'Seu pedido saiu para entrega 🛵', `${firstName(r.driver_name)} está a caminho. Código de entrega: ${r.delivery_code}.`);
  } else if (r.status === 'completed') {
    await tx(async (db) => {
      const up = await one(`UPDATE food_orders SET status = 'entregue', delivered_at = now() WHERE id = $1 AND status <> 'entregue' RETURNING *`, [o.id], db);
      if (!up) return;
      const a = await one(`SELECT * FROM accounts WHERE id = $1 FOR UPDATE`, [o.account_id], db);
      const t = await one(`SELECT food_commission_pct FROM tenants WHERE id = $1`, [o.tenant_id], db);
      const commission = Math.round((o.subtotal_cents * commissionPctOf(a, t)) / 100);
      await query(`UPDATE food_orders SET commission_cents = $2 WHERE id = $1`, [o.id, commission], db);
      if (commission > 0) await addLedger(db, o.account_id, 'comissao', -commission, { foodOrderId: o.id, note: `comissão do pedido ${o.number}` });
      if (r.shift_id) await query(`UPDATE food_shifts SET deliveries = deliveries + 1 WHERE id = $1`, [r.shift_id], db);
    });
    await pushCustomer(o, 'Pedido entregue ✅', 'Bom apetite! Conte como foi no app.');
  } else if (r.status === 'cancelled' && r.cancelled_by !== 'loja') {
    // ninguém aceitou a entrega: o restaurante chama de novo (o frete já voltou para os créditos)
    await query(`UPDATE food_orders SET ride_id = NULL WHERE id = $1`, [o.id]);
    emitTo(`account:${o.account_id}`, 'food:no-courier', { orderId: o.id, number: Number(o.number) });
  }
  await emitOrder(o.id);
}

// ---------- restaurante: aceitar, recusar, pronto, cancelar ----------

export async function cancelOrder(o: any, by: 'cliente' | 'restaurante' | 'sistema' | 'central', reason: string | null) {
  if (['entregue', 'cancelado', 'recusado'].includes(o.status)) throw conflict('Este pedido já foi encerrado');
  if (o.status === 'em_entrega') throw conflict('O pedido já saiu para entrega', 'em_entrega');
  if (o.ride_id) {
    const r = await one(`SELECT status FROM rides WHERE id = $1`, [o.ride_id]);
    if (r && ['requested', 'accepted', 'arrived', 'scheduled'].includes(r.status)) {
      await query(`UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'loja', cancel_reason = 'pedido_cancelado' WHERE id = $1`, [o.ride_id]);
      const offers = await query<{ driver_id: string }>(`UPDATE ride_offers SET status = 'closed' WHERE ride_id = $1 AND status = 'sent' RETURNING driver_id`, [o.ride_id]);
      emitTo(offers.map((x) => `user:${x.driver_id}`), 'ride:offer:closed', { rideId: o.ride_id });
      await refundDelivery(o.ride_id);
      const full = await loadRide(o.ride_id);
      if (full?.driver_id) emitTo(`user:${full.driver_id}`, 'ride:updated', rideView(full, 'driver'));
    }
  }
  const refused = by === 'restaurante' && o.status === 'novo';
  await query(
    // Pix ainda não pago fica 'pendente': se o cliente pagar depois, a conferência devolve na hora
    `UPDATE food_orders SET status = $2, cancelled_by = $3, refuse_reason = $4, cancelled_at = now() WHERE id = $1`,
    [o.id, refused ? 'recusado' : 'cancelado', by, reason],
  );
  let refunded = false;
  try { refunded = await refundFoodPayment(o); } catch (e) { console.error('[food] estorno', e); }
  const why = reason ? ` Motivo: ${reason}.` : '';
  const pix = refunded ? ' O Pix foi devolvido.' : '';
  if (by !== 'cliente') {
    await pushCustomer(o, refused ? 'O restaurante não pôde aceitar seu pedido' : 'Seu pedido foi cancelado', `Pedido ${o.number}.${why}${pix}`);
  }
  await emitOrder(o.id);
  return { refunded };
}

// ---------- entregador fixo por turno ----------

export const shiftPrice = (t: any, hours: number) => {
  const price = t.food_shift_hour_cents * hours;
  return { priceCents: price, driverCents: Math.round(price * (1 - Number(t.food_shift_commission_pct) / 100)) };
};

export async function cancelShift(shiftId: string, by: string | null) {
  return tx(async (db) => {
    const s = await one(`SELECT * FROM food_shifts WHERE id = $1 FOR UPDATE`, [shiftId], db);
    if (!s || !['solicitado', 'confirmado'].includes(s.status)) throw conflict('Este turno não pode mais ser cancelado');
    await query(`UPDATE food_shifts SET status = 'cancelado' WHERE id = $1`, [s.id], db);
    await one(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [s.account_id], db);
    await addLedger(db, s.account_id, 'estorno', s.price_cents, { shiftId: s.id, note: 'turno de entregador cancelado', by });
    if (s.driver_id) {
      await pushTo(s.driver_id, { title: 'Turno cancelado', body: 'Um turno de entregador fixo foi cancelado. Veja no app.', data: { type: 'food_shift' }, channelId: CHANNEL_UPDATES }).catch(() => {});
    }
    return s;
  });
}

export function shiftView(s: any) {
  return {
    id: s.id, status: s.status, startsAt: s.starts_at, endsAt: s.ends_at, hours: s.hours,
    priceCents: s.price_cents, driverCents: s.driver_cents, deliveries: s.deliveries, notes: s.notes,
    restaurant: s.account_name ? { id: s.account_id, name: s.account_name, address: s.account_address } : undefined,
    driver: s.driver_id ? { id: s.driver_id, name: s.driver_name ?? null, vehicle: s.vehicle_model ? `${s.vehicle_model} · ${s.vehicle_plate}` : null } : null,
    driverPaidAt: s.driver_paid_at,
  };
}

export const SHIFT_SELECT = `SELECT s.*, a.name AS account_name, a.address AS account_address, u.name AS driver_name, d.vehicle_model, d.vehicle_plate
  FROM food_shifts s JOIN accounts a ON a.id = s.account_id LEFT JOIN users u ON u.id = s.driver_id LEFT JOIN drivers d ON d.user_id = s.driver_id`;

// ---------- rodada periódica (junto com o despacho, a cada 15 s) ----------

export async function runFoodJobs() {
  // Pix não pago no prazo: o pedido é cancelado
  const expired = await query(
    `UPDATE food_orders SET status = 'cancelado', cancelled_by = 'sistema', cancelled_at = now(), refuse_reason = 'Pix não pago no prazo'
      WHERE status = 'aguardando_pagamento' AND created_at < now() - make_interval(mins => $1) RETURNING id`, [PAY_TIMEOUT_MIN],
  );
  for (const o of expired) await emitOrder(o.id);
  // restaurante não respondeu: cancela e devolve o Pix
  const stale = await query(`SELECT * FROM food_orders WHERE status = 'novo' AND coalesce(paid_at, created_at) < now() - make_interval(mins => $1)`, [ACCEPT_TIMEOUT_MIN]);
  for (const o of stale) {
    try { await cancelOrder(o, 'sistema', 'o restaurante não respondeu a tempo'); } catch (e) { console.error('[food] cancelamento automático', e); }
  }
  // entrega do turno sem resposta do fixo no prazo: vai para o rotativo
  const waiting = await query<{ id: string }>(
    `SELECT id FROM rides WHERE shift_id IS NOT NULL AND status = 'requested' AND requested_at < now() - make_interval(secs => $1)`, [SHIFT_OFFER_SEC],
  );
  for (const r of waiting) if (await moveToRotation(r.id)) await dispatchRide(r.id);
  // turnos que acabaram
  const done = await query(`UPDATE food_shifts SET status = 'concluido' WHERE status = 'confirmado' AND ends_at <= now() RETURNING id`);
  // turno pedido e não confirmado pela central até o começo: cancela e devolve
  const unassigned = await query<{ id: string }>(`SELECT id FROM food_shifts WHERE status = 'solicitado' AND starts_at <= now()`);
  for (const s of unassigned) await cancelShift(s.id, null).catch(() => {});
  return { expired: expired.length, autoCancelled: stale.length, toRotation: waiting.length, shiftsDone: done.length };
}

export { money as foodMoney };
