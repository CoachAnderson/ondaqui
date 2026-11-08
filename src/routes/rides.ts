import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse, latLng, phone, place, uuid } from '../lib/validate.js';
import { insideBox } from '../lib/geo.js';
import { routeTrip } from '../lib/routing.js';
import { commissionFor, quoteService } from '../lib/pricing.js';
import {
  dispatchRide, driverWorkStatus, loadRide, newBoardingCode, newDeliveryCode, newShareToken, notifyRide, rideView,
} from '../lib/rides.js';
import { emitTo } from '../lib/realtime.js';
import { checkDriverRating } from '../lib/ratings.js';
import { checkFamilyLimit, familyMemberOf } from './family.js';
import { clubDiscountFor, isClubMember } from '../lib/club.js';
import { hasPrefs, readPrefs, tripPrefsSchema } from '../lib/prefs.js';
import { earnRideCashback, earnStoreCashback, releaseCashback, useCashback } from '../lib/cashback.js';
import { config } from '../lib/config.js';
import { saveImage, sendImage } from '../lib/images.js';

const extras = {
  /** Modo família: a corrida é para um parente do titular */
  familyMemberId: z.string().uuid().optional(),
  category: z.string().default('carro'),
  hours: z.number().int().min(1).max(12).optional(),      // Daqui Particular
  helpers: z.number().int().min(0).max(3).optional(),      // Daqui Frete
  scheduledFor: z.string().datetime({ offset: true }).optional(), // corrida agendada
};

const quoteSchema = z.object({ origin: latLng, destination: latLng.optional(), ...extras });

const createSchema = z.object({
  origin: place,
  destination: place.optional(),
  paymentMethod: z.enum(['pix', 'card', 'cash']),
  notes: z.string().trim().max(300).optional(),
  /** usar o saldo de cashback nesta corrida (até o limite da cidade) */
  useCashback: z.boolean().optional(),
  /** preferências só para esta corrida (sem isso, valem as do perfil) */
  tripPrefs: tripPrefsSchema.optional(),
  delivery: z.object({
    recipientName: z.string().trim().min(2).max(80),
    recipientPhone: phone,
    packageDesc: z.string().trim().min(2).max(200),
  }).optional(),
  ...extras,
});

type Params = { Params: { id: string } };
type QuoteInput = z.infer<typeof quoteSchema>;

export const SCHEDULE_MIN_AHEAD_MIN = 30;

/** Confere data de agendamento: de 30 minutos a 30 dias à frente */
export function checkSchedule(iso?: string) {
  if (!iso) return null;
  const at = new Date(iso);
  const ahead = (at.getTime() - Date.now()) / 60_000;
  if (ahead < SCHEDULE_MIN_AHEAD_MIN - 1) throw badRequest(`Agende com pelo menos ${SCHEDULE_MIN_AHEAD_MIN} minutos de antecedência`, 'agendamento_cedo');
  if (ahead > 30 * 24 * 60) throw badRequest('Agende com no máximo 30 dias de antecedência', 'agendamento_longe');
  return at;
}

/**
 * Preço de qualquer serviço. kinds = tipos que quem pede pode usar
 * (passageiro não pede "paciente"; a central da Saúde só pede "paciente").
 */
export async function computeQuote(tenantId: string, body: QuoteInput, kinds: string[]) {
  const t = await one('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  const cat = await one('SELECT * FROM ride_categories WHERE tenant_id = $1 AND code = $2 AND active', [tenantId, body.category]);
  if (!cat || !kinds.includes(cat.kind)) throw badRequest('Serviço indisponível nesta cidade', 'servico_indisponivel');
  if (!body.destination && cat.kind !== 'particular') throw badRequest('Informe o destino', 'sem_destino');
  if (!insideBox(body.origin, t) || (body.destination && !insideBox(body.destination, t))) {
    throw badRequest(`Fora da área de atendimento do ${t.name}`, 'fora_da_area');
  }
  const scheduled = checkSchedule(body.scheduledFor);
  // distância e tempo pelas ruas (OSRM); sem serviço de rotas, estimativa
  const trip = body.destination ? await routeTrip(body.origin, body.destination) : { distanceKm: 0, durationMin: 0, source: 'estimativa' as const };
  const hours = cat.kind === 'particular' ? body.hours ?? 2 : null;
  const helpers = cat.kind === 'frete' ? body.helpers ?? 0 : 0;
  const opts = { hours: hours ?? undefined, helpers, scheduled: !!scheduled };
  const price = quoteService(cat, trip.distanceKm, trip.durationMin, Number(t.current_surge), Number(t.surge_cap), opts);
  // o mesmo serviço sem a tarifa dinâmica (o Clube pode tirar a dinâmica do assinante)
  const baseCents = price.surge > 1 ? quoteService(cat, trip.distanceKm, trip.durationMin, 1, Number(t.surge_cap), opts).priceCents : price.priceCents;
  return {
    ...trip,
    durationMin: hours ? hours * 60 : trip.durationMin,
    routeSource: trip.source,
    routePolyline: trip.polyline ?? null,
    ...price,
    baseCents,
    category: cat.code, serviceName: cat.name, kind: cat.kind as string, vehicleType: cat.vehicle_type as string,
    requires: cat.requires as string[], hours, helpers, scheduledFor: scheduled?.toISOString() ?? null,
    licenseFeeCents: t.license_fee_per_ride_cents as number,
  };
}

/** Carrega a corrida e confere se quem pede faz parte dela */
export async function rideFor(req: FastifyRequest, id: string) {
  parse(uuid, id);
  const r = await loadRide(id);
  if (!r || r.tenant_id !== req.auth.tenantId) throw notFound('Corrida não encontrada');
  const isPassenger = !!r.passenger_id && r.passenger_id === req.auth.id;
  const isDriver = r.driver_id === req.auth.id;
  // central da Saúde ou loja que pediu a viagem/entrega
  const isAccount = req.auth.role === 'account_operator' && !!r.account_id &&
    !!(await one('SELECT 1 FROM users WHERE id = $1 AND account_id = $2', [req.auth.id, r.account_id]));
  if (!isPassenger && !isDriver && !isAccount && req.auth.role !== 'tenant_admin') throw forbidden();
  const viewer = isPassenger ? 'passenger' : isDriver ? 'driver' : isAccount ? 'account' : 'admin';
  return { r, viewer: viewer as 'passenger' | 'driver' | 'admin' | 'account' };
}

/** Clube na cotação: quanto o assinante deixa de pagar (para quem não assina, quanto economizaria) */
async function clubFor(tenantId: string, userId: string) {
  const t = await one(`SELECT club_enabled, club_no_surge, club_discount_pct, club_discount_max_cents FROM tenants WHERE id = $1`, [tenantId]);
  const member = t.club_enabled ? await isClubMember(userId) : false;
  return {
    member,
    apply: <Q extends { priceCents: number; baseCents: number }>(q: Q) => {
      if (!t.club_enabled) return { ...q, club: null };
      const d = clubDiscountFor(t, q.priceCents, q.baseCents);
      return { ...q, club: { member, discountCents: d.totalCents, surgeWaivedCents: d.surgeWaivedCents, payCents: q.priceCents - (member ? d.totalCents : 0) } };
    },
  };
}

export async function rideRoutes(app: FastifyInstance) {
  const passenger = { preHandler: requireAuth('passenger') };
  const driver = { preHandler: requireAuth('driver') };
  const either = { preHandler: requireAuth('passenger', 'driver') };

  // ---------- passageiro ----------

  const PASSENGER_KINDS = ['corrida', 'entrega', 'particular', 'frete'];

  async function checkPassengerCan(req: FastifyRequest, requires: string[], familyMemberId?: string) {
    const member = familyMemberId ? await familyMemberOf(req.auth.id, familyMemberId) : null;
    if (!requires.includes('mulher')) return member;
    if (member) {
      if (!member.declared_woman) throw forbidden(`O Daqui Mulher atende só passageiras. Marque no cadastro de ${member.name.split(/\s+/)[0]} que ela é mulher.`);
      return member;
    }
    const u = await one('SELECT declared_woman FROM users WHERE id = $1', [req.auth.id]);
    if (!u?.declared_woman) {
      throw forbidden('O Daqui Mulher atende só passageiras. Ative a opção "Sou mulher" no seu perfil para usar.');
    }
    return null;
  }

  app.post('/rides/quote', passenger, async (req) => {
    const b = parse(quoteSchema, req.body);
    const q = await computeQuote(req.auth.tenantId!, b, PASSENGER_KINDS);
    await checkPassengerCan(req, q.requires, b.familyMemberId);
    return (await clubFor(req.auth.tenantId!, req.auth.id)).apply(q);
  });

  // todas as opções de uma vez: a tela do passageiro mostra o preço de cada serviço
  app.post('/rides/quotes', passenger, async (req) => {
    const b = parse(quoteSchema.omit({ category: true }), req.body);
    const cats = await query(
      `SELECT code FROM ride_categories WHERE tenant_id = $1 AND active AND kind = ANY($2) ORDER BY sort, min_fare_cents`,
      [req.auth.tenantId, PASSENGER_KINDS],
    );
    const club = await clubFor(req.auth.tenantId!, req.auth.id);
    const quotes = [];
    for (const c of cats) {
      try { quotes.push(club.apply(await computeQuote(req.auth.tenantId!, { ...b, category: c.code }, PASSENGER_KINDS))); } catch { /* serviço não se aplica */ }
    }
    return { quotes };
  });

  app.post('/rides', passenger, async (req, reply) => {
    const body = parse(createSchema, req.body);
    const q = await computeQuote(req.auth.tenantId!, body, PASSENGER_KINDS);
    const member = await checkPassengerCan(req, q.requires, body.familyMemberId);
    if (member) {
      if (q.kind === 'entrega') throw badRequest('Para entregas, use o pedido de entrega normal', 'familia_entrega');
      await checkFamilyLimit(member, q.priceCents);
    }
    if (q.kind === 'entrega' && !body.delivery) throw badRequest('Informe quem vai receber e o que será entregue', 'dados_entrega');
    const dest = body.destination ?? { ...body.origin, address: 'Roteiro combinado com o motorista' };
    // Clube: o assinante paga sem dinâmica e com desconto; a central acerta a diferença com o motorista
    const club = (await clubFor(req.auth.tenantId!, req.auth.id)).apply(q).club;
    const clubDiscount = club?.member ? club.discountCents : 0;
    // preferências da viagem (música, conversa, ar): do perfil ou do pedido; não valem para entrega nem para corrida de parente
    let prefs = null;
    if (q.kind !== 'entrega' && !member) {
      const p = body.tripPrefs ?? readPrefs((await one(`SELECT trip_prefs FROM users WHERE id = $1`, [req.auth.id]))?.trip_prefs);
      if (hasPrefs(p)) prefs = p;
    }
    let ride;
    try {
      ride = await tx(async (db) => {
        const created = await one(
          `INSERT INTO rides (tenant_id, passenger_id, category_code, kind, vehicle_type, requires, status, scheduled_for,
              origin_lat, origin_lng, origin_address, dest_lat, dest_lng, dest_address,
              distance_km, duration_min, price_cents, surge, payment_method, boarding_code, share_token, license_fee_cents,
              hours_booked, helpers, notes, recipient_name, recipient_phone, package_desc, delivery_code, route_source, route_polyline,
              family_member_id, club_member, club_discount_cents, trip_prefs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
           RETURNING id`,
          [req.auth.tenantId, req.auth.id, q.category, q.kind, q.vehicleType, q.requires,
           q.scheduledFor ? 'scheduled' : 'requested', q.scheduledFor,
           body.origin.lat, body.origin.lng, body.origin.address, dest.lat, dest.lng, dest.address,
           q.distanceKm, q.durationMin, q.priceCents, q.surge, body.paymentMethod,
           newBoardingCode(), newShareToken(), q.licenseFeeCents,
           q.hours, q.helpers, body.notes ?? null,
           body.delivery?.recipientName ?? null, body.delivery?.recipientPhone ?? null, body.delivery?.packageDesc ?? null,
           q.kind === 'entrega' ? newDeliveryCode() : null, q.routeSource, q.routePolyline, member?.id ?? null,
           !!club?.member, clubDiscount, prefs ? JSON.stringify(prefs) : null], db,
        );
        if (body.useCashback) await useCashback(db, req.auth.tenantId!, req.auth.id, created!.id, q.priceCents - clubDiscount);
        return created;
      });
    } catch (e: any) {
      if (e.code === '23505') {
        throw member
          ? conflict(`${member.name.split(/\s+/)[0]} já tem uma corrida em andamento`, 'corrida_ativa')
          : conflict('Você já tem uma corrida em andamento', 'corrida_ativa');
      }
      throw e;
    }
    // Modo família: lembra onde buscou o parente, para sugerir na próxima
    if (member) {
      await query(`UPDATE family_members SET pickup_address = $2, pickup_lat = $3, pickup_lng = $4 WHERE id = $1`,
        [member.id, body.origin.address, body.origin.lat, body.origin.lng]);
    }
    const offered = q.scheduledFor ? 0 : await dispatchRide(ride!.id);
    const full = await loadRide(ride!.id);
    emitTo(`admin:${req.auth.tenantId}`, 'ride:updated', rideView(full, 'admin'));
    reply.code(201);
    return { ride: rideView(full, 'passenger'), driversNotified: offered };
  });

  // agendadas do passageiro
  app.get('/rides/scheduled', passenger, async (req) => {
    const rows = await query(
      `SELECT id FROM rides WHERE passenger_id = $1 AND status = 'scheduled' ORDER BY scheduled_for LIMIT 20`, [req.auth.id],
    );
    const rides = [];
    for (const row of rows) rides.push(rideView(await loadRide(row.id), 'passenger'));
    return { rides };
  });

  // Daqui Particular: passageiro pede mais horas
  app.post<Params>('/rides/:id/extend', passenger, async (req) => {
    const { r, viewer } = await rideFor(req, req.params.id);
    const { hours } = parse(z.object({ hours: z.number().int().min(1).max(4) }), req.body);
    if (viewer !== 'passenger' || r.kind !== 'particular') throw conflict('Só o Daqui Particular pode ser estendido');
    if (!['scheduled', 'requested', 'accepted', 'arrived', 'in_progress'].includes(r.status)) throw conflict('Este serviço já terminou');
    const cat = await one('SELECT per_hour_cents FROM ride_categories WHERE tenant_id = $1 AND code = $2', [r.tenant_id, r.category_code]);
    await query(
      `UPDATE rides SET hours_booked = hours_booked + $2, duration_min = duration_min + $2 * 60, price_cents = price_cents + $3 WHERE id = $1`,
      [r.id, hours, hours * (cat?.per_hour_cents ?? 0)],
    );
    await notifyRide(r.id);
    return { ride: rideView(await loadRide(r.id), 'passenger') };
  });

  app.get('/rides/current', either, async (req) => {
    const col = req.auth.role === 'driver' ? 'driver_id' : 'passenger_id';
    const r = await one(
      `SELECT id FROM rides WHERE ${col} = $1 AND status IN ('requested','accepted','arrived','in_progress')
          ${col === 'passenger_id' ? 'AND family_member_id IS NULL' : ''}
        ORDER BY requested_at DESC LIMIT 1`,
      [req.auth.id],
    );
    if (!r) return { ride: null };
    const full = await loadRide(r.id);
    return { ride: rideView(full, req.auth.role === 'driver' ? 'driver' : 'passenger') };
  });

  app.get('/rides/history', either, async (req) => {
    const col = req.auth.role === 'driver' ? 'driver_id' : 'passenger_id';
    const rows = await query(
      `SELECT id FROM rides WHERE ${col} = $1 AND status IN ('completed','cancelled')
        ORDER BY requested_at DESC LIMIT 50`,
      [req.auth.id],
    );
    const viewer = req.auth.role === 'driver' ? 'driver' : 'passenger';
    const rides = [];
    for (const row of rows) rides.push(rideView(await loadRide(row.id), viewer));
    return { rides };
  });

  app.get<Params>('/rides/:id', { preHandler: requireAuth('passenger', 'driver', 'tenant_admin') }, async (req) => {
    const { r, viewer } = await rideFor(req, req.params.id);
    return { ride: rideView(r, viewer) };
  });

  app.post<Params>('/rides/:id/cancel', either, async (req) => {
    const { r, viewer } = await rideFor(req, req.params.id);
    const reason = parse(z.object({ reason: z.string().max(200).optional() }), req.body ?? {}).reason ?? null;

    if (viewer === 'passenger') {
      if (!['scheduled', 'requested', 'accepted', 'arrived'].includes(r.status)) throw conflict('Esta corrida não pode mais ser cancelada');
      await query(
        `UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'passageiro', cancel_reason = $2 WHERE id = $1`,
        [r.id, reason],
      );
      await query(`UPDATE ride_offers SET status = 'closed' WHERE ride_id = $1 AND status = 'sent'`, [r.id]);
      await releaseCashback(r.id); // o cashback reservado volta para o saldo
    } else if (viewer === 'driver') {
      if (!['accepted', 'arrived'].includes(r.status)) throw conflict('Esta corrida não pode mais ser cancelada');
      // motorista desistiu: a corrida volta a procurar outro motorista
      await tx(async (db) => {
        await query(
          `UPDATE rides SET status = 'requested', driver_id = NULL, accepted_at = NULL, arrived_at = NULL WHERE id = $1`,
          [r.id], db,
        );
        await query(`UPDATE ride_offers SET status = 'declined' WHERE ride_id = $1 AND driver_id = $2`, [r.id, req.auth.id], db);
      });
      emitTo(`user:${req.auth.id}`, 'ride:updated', { id: r.id, status: 'cancelled', cancelReason: 'cancelada_pelo_motorista' });
      await dispatchRide(r.id);
    }
    await notifyRide(r.id);
    return { ok: true };
  });

  // Caminho do motorista até o embarque (e quanto falta), para o mapa dos dois lados
  app.get<Params>('/rides/:id/pickup-route', either, async (req) => {
    const { r } = await rideFor(req, req.params.id);
    if (r.status !== 'accepted' || r.driver_lat == null) return { polyline: null, distanceKm: null, durationMin: null };
    const t = await routeTrip({ lat: r.driver_lat, lng: r.driver_lng }, { lat: r.origin_lat, lng: r.origin_lng });
    return { polyline: t.polyline ?? null, distanceKm: t.distanceKm, durationMin: t.durationMin, source: t.source };
  });

  app.post<Params>('/rides/:id/rate', either, async (req) => {
    const { r, viewer } = await rideFor(req, req.params.id);
    const { stars, prefsRespected } = parse(z.object({
      stars: z.number().int().min(1).max(5),
      prefsRespected: z.boolean().optional(), // o passageiro conta se o motorista respeitou as preferências da viagem
    }), req.body);
    if (r.status !== 'completed') throw conflict('Só é possível avaliar corridas finalizadas');
    const col = viewer === 'passenger' ? 'driver_rating' : 'passenger_rating';
    await query(`UPDATE rides SET ${col} = $2 WHERE id = $1`, [r.id, stars]);
    if (viewer === 'passenger' && prefsRespected !== undefined && r.trip_prefs) {
      await query(`UPDATE rides SET prefs_respected = $2 WHERE id = $1`, [r.id, prefsRespected]);
    }
    // nota do motorista caiu abaixo de 4,5: aviso automático com orientação (termos, cláusula 6.2)
    if (viewer === 'passenger' && r.driver_id) await checkDriverRating(r.driver_id).catch(() => null);
    return { ok: true };
  });

  app.post<Params>('/rides/:id/panic', either, async (req, reply) => {
    const { r } = await rideFor(req, req.params.id);
    const pos = parse(latLng.partial(), req.body ?? {});
    const alert = await one(
      `INSERT INTO panic_alerts (tenant_id, ride_id, user_id, lat, lng) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [r.tenant_id, r.id, req.auth.id, pos.lat ?? null, pos.lng ?? null],
    );
    emitTo(`admin:${r.tenant_id}`, 'alert:panic', {
      id: alert.id,
      rideId: r.id,
      by: req.auth.role === 'driver' ? 'motorista' : 'passageiro',
      passenger: r.passenger_name,
      driver: r.driver_name,
      vehicle: r.vehicle_plate,
      location: pos.lat != null ? { lat: pos.lat, lng: pos.lng } : r.driver_lat != null ? { lat: r.driver_lat, lng: r.driver_lng } : null,
      createdAt: alert.created_at,
    });
    reply.code(201);
    return { ok: true, alertId: alert.id, message: 'Alerta enviado para a central. Se estiver em perigo, ligue 190.' };
  });

  // Antigolpe: o Pix só aparece se o licenciado validou a chave do motorista
  app.get<Params>('/rides/:id/payment', passenger, async (req) => {
    const { r } = await rideFor(req, req.params.id);
    if (!['accepted', 'arrived', 'in_progress', 'completed'].includes(r.status)) {
      throw conflict('O pagamento fica disponível depois que um motorista aceitar');
    }
    // com cashback, o passageiro paga ao motorista só a diferença
    const amountCents = r.price_cents - (r.cashback_used_cents ?? 0) - (r.club_discount_cents ?? 0);
    if (r.payment_method !== 'pix') return { method: r.payment_method, amountCents };
    if (!r.driver_id) throw conflict('O pagamento fica disponível depois que um motorista aceitar');
    const d = await one('SELECT pix_key, pix_holder_name, pix_validated FROM drivers WHERE user_id = $1', [r.driver_id]);
    if (!d?.pix_validated || !d.pix_key) {
      return {
        method: 'pix', available: false, amountCents,
        message: 'O Pix deste motorista ainda não foi validado pela central. Pague em dinheiro ou cartão.',
      };
    }
    return {
      method: 'pix', available: true, amountCents,
      pixKey: d.pix_key, holderName: d.pix_holder_name,
      warning: `Confira se o recebedor é ${d.pix_holder_name}. Nunca pague por link ou chave enviada por mensagem.`,
    };
  });

  // ---------- motorista ----------

  app.post<Params>('/rides/:id/accept', driver, async (req) => {
    parse(uuid, req.params.id);
    const can = await driverWorkStatus(req.auth.id);
    if (!can.ok) throw forbidden(can.reason!);
    let accepted;
    try {
      accepted = await tx(async (db) => {
        const r = await one(
          `UPDATE rides SET driver_id = $2, status = 'accepted', accepted_at = now()
            WHERE id = $1 AND tenant_id = $3 AND status = 'requested'
              AND EXISTS (SELECT 1 FROM ride_offers o WHERE o.ride_id = $1 AND o.driver_id = $2 AND o.status = 'sent')
            RETURNING id`,
          [req.params.id, req.auth.id, req.auth.tenantId], db,
        );
        if (!r) return null;
        await query(
          `UPDATE ride_offers SET status = CASE WHEN driver_id = $2 THEN 'accepted' ELSE 'closed' END
            WHERE ride_id = $1 AND status = 'sent'`,
          [req.params.id, req.auth.id], db,
        );
        return r;
      });
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Você já está em outra corrida', 'corrida_ativa');
      throw e;
    }
    if (!accepted) throw conflict('Esta corrida já foi aceita por outro motorista ou foi cancelada', 'oferta_encerrada');

    const others = await query(
      `SELECT driver_id FROM ride_offers WHERE ride_id = $1 AND status = 'closed'`, [req.params.id],
    );
    emitTo(others.map((o) => `user:${o.driver_id}`), 'ride:offer:closed', { rideId: req.params.id });
    await notifyRide(req.params.id);
    return { ride: rideView(await loadRide(req.params.id), 'driver') };
  });

  app.post<Params>('/rides/:id/decline', driver, async (req) => {
    parse(uuid, req.params.id);
    await query(
      `UPDATE ride_offers SET status = 'declined' WHERE ride_id = $1 AND driver_id = $2 AND status = 'sent'`,
      [req.params.id, req.auth.id],
    );
    // se ninguém mais tem a oferta aberta, chama os próximos motoristas
    const open = await one(`SELECT 1 FROM ride_offers WHERE ride_id = $1 AND status = 'sent'`, [req.params.id]);
    if (!open) await dispatchRide(req.params.id);
    return { ok: true };
  });

  // Foto da carga (Entrega e Frete): na coleta e na entrega, como comprovante para o cliente e a central
  const PHOTO_KINDS = ['entrega', 'frete'];
  const photoStep = { pickup: ['accepted', 'arrived'], dropoff: ['in_progress'] } as const;

  for (const which of ['pickup', 'dropoff'] as const) {
    app.post<Params>(`/rides/:id/${which}-photo`, { ...driver, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
      const { r, viewer } = await rideFor(req, req.params.id);
      if (viewer !== 'driver' || !PHOTO_KINDS.includes(r.kind) || !(photoStep[which] as readonly string[]).includes(r.status)) {
        throw conflict('Ação indisponível nesta etapa');
      }
      const { image } = parse(z.object({ image: z.string().min(100) }), req.body);
      const path = await saveImage(r.kind === 'frete' ? 'fretes' : 'entregas', `${r.id}-${which}`, image);
      await query(`UPDATE rides SET ${which === 'pickup' ? 'pickup_photo_path' : 'dropoff_photo_path'} = $2 WHERE id = $1`, [r.id, path]);
      await notifyRide(r.id);
      return { ok: true };
    });

    app.get<Params>(`/rides/:id/${which}-photo`, { preHandler: requireAuth('passenger', 'driver', 'tenant_admin', 'account_operator') }, async (req, reply) => {
      const { r } = await rideFor(req, req.params.id);
      return sendImage(reply, which === 'pickup' ? r.pickup_photo_path : r.dropoff_photo_path);
    });
  }

  // Foto do motorista e do veículo (só as aprovadas pela central) para quem está na corrida
  app.get<Params & { Querystring: { which?: string } }>('/rides/:id/driver-photo', { preHandler: requireAuth('passenger', 'tenant_admin', 'account_operator') }, async (req, reply) => {
    const { r } = await rideFor(req, req.params.id);
    const which = req.query.which === 'veiculo' ? 'veiculo' : 'perfil';
    if (!r.driver_id) throw notFound('Ainda sem motorista');
    const d = await one('SELECT photo_path, vehicle_photo_path, photo_status FROM drivers WHERE user_id = $1', [r.driver_id]);
    if (d?.photo_status !== 'approved') throw notFound('Foto indisponível');
    return sendImage(reply, which === 'veiculo' ? d.vehicle_photo_path : d.photo_path);
  });

  app.post<Params>('/rides/:id/arrived', driver, async (req) => {
    const { r, viewer } = await rideFor(req, req.params.id);
    if (viewer !== 'driver' || r.status !== 'accepted') throw conflict('Ação indisponível nesta etapa');
    await query(`UPDATE rides SET status = 'arrived', arrived_at = now() WHERE id = $1`, [r.id]);
    await notifyRide(r.id);
    return { ok: true };
  });

  app.post<Params>('/rides/:id/start', driver, async (req) => {
    const { r, viewer } = await rideFor(req, req.params.id);
    if (viewer !== 'driver' || !['accepted', 'arrived'].includes(r.status)) throw conflict('Ação indisponível nesta etapa');
    const { boardingCode } = parse(z.object({ boardingCode: z.string().regex(/^\d{4}$/, 'código de 4 números').optional() }), req.body ?? {});
    if (r.kind === 'paciente') {
      // paciente do convênio não usa o app: o motorista confere o nome e a central acompanha
    } else if (boardingCode !== r.boarding_code) {
      throw badRequest(r.kind === 'entrega'
        ? 'Código de coleta não confere. Peça o código a quem está entregando o pacote.'
        : 'Código de embarque não confere. Peça o código ao passageiro.', 'codigo_invalido');
    }
    if (PHOTO_KINDS.includes(r.kind) && !r.pickup_photo_path) {
      throw badRequest(r.kind === 'frete' ? 'Tire a foto da carga antes de sair' : 'Tire a foto do pacote antes de sair para a entrega', 'sem_foto');
    }
    await query(
      `UPDATE rides SET status = 'in_progress', started_at = now(), arrived_at = coalesce(arrived_at, now()) WHERE id = $1`,
      [r.id],
    );
    await notifyRide(r.id);
    return { ok: true };
  });

  app.post<Params>('/rides/:id/complete', driver, async (req) => {
    const { r, viewer } = await rideFor(req, req.params.id);
    if (viewer !== 'driver' || r.status !== 'in_progress') throw conflict('Ação indisponível nesta etapa');
    if (PHOTO_KINDS.includes(r.kind) && !r.dropoff_photo_path) {
      throw badRequest('Tire a foto da entrega (comprovante) antes de finalizar', 'sem_foto_entrega');
    }
    if (r.cod_amount_cents && !['pago', 'aguardando_loja', 'confirmado'].includes(r.cod_status)) {
      throw badRequest(`Antes de entregar, receba ${(r.cod_amount_cents / 100).toFixed(2).replace('.', ',')} reais do produto (Pix da loja ou maquininha)`, 'cobranca_pendente');
    }
    if (r.kind === 'entrega') {
      const { deliveryCode } = parse(z.object({ deliveryCode: z.string().regex(/^\d{4}$/, 'código de 4 números') }), req.body ?? {});
      if (deliveryCode !== r.delivery_code) throw badRequest('Código de entrega não confere. Peça o código a quem está recebendo.', 'codigo_invalido');
    }
    const plan = await one(
      `SELECT p.commission_pct FROM drivers d JOIN driver_plans p ON p.tenant_id = $2 AND p.code = d.plan_code WHERE d.user_id = $1`,
      [req.auth.id, r.tenant_id],
    );
    // entrega do turno fixo (Daqui Food): o entregador recebe pelo turno, não por entrega
    const commission = r.shift_id ? 0 : commissionFor(r.price_cents, Number(plan?.commission_pct ?? 0));
    await query(
      `UPDATE rides SET status = 'completed', completed_at = now(), commission_cents = $2 WHERE id = $1`,
      [r.id, commission],
    );
    // cashback: o passageiro ganha a % da cidade; o cliente da loja ganha o presente da loja
    await (r.account_id ? earnStoreCashback(r.id) : earnRideCashback(r.id)).catch((e) => console.error('[cashback]', e));
    await notifyRide(r.id);
    const cashbackUsed = r.cashback_used_cents ?? 0;
    const clubDiscount = r.club_discount_cents ?? 0;
    return {
      ok: true, priceCents: r.price_cents, commissionCents: commission, driverReceivesCents: r.shift_id ? 0 : r.price_cents - commission,
      shift: !!r.shift_id,
      // o motorista recebe do passageiro o valor menos cashback e Clube; a central paga a diferença no acerto da semana
      collectCents: r.price_cents - cashbackUsed - clubDiscount, cashbackUsedCents: cashbackUsed, clubDiscountCents: clubDiscount,
    };
  });
}
