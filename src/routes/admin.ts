import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { one, query, tx } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse, uuid } from '../lib/validate.js';
import { DRIVER_VERIFIED, loadRide, rideView } from '../lib/rides.js';
import { emitTo } from '../lib/realtime.js';
import { config } from '../lib/config.js';
import { extendDriverPlan } from '../lib/billing.js';
import { removeImages, sendImage } from '../lib/images.js';
import { RATING } from '../lib/ratings.js';

type Params = { Params: { id: string } };
type CodeParams = { Params: { code: string } };

const driverPatch = z.object({
  status: z.enum(['approved', 'rejected', 'blocked', 'pending']).optional(),
  cnhEarOk: z.boolean().optional(),
  inssOk: z.boolean().optional(),
  criminalRecordOk: z.boolean().optional(),
  insuranceAppOk: z.boolean().optional(),
  pixValidated: z.boolean().optional(),
  planCode: z.string().optional(),
  vehicleType: z.enum(['carro', 'moto', 'utilitario']).optional(),
  verified: z.array(z.enum(DRIVER_VERIFIED)).optional(),
  photoApproved: z.boolean().optional(),
  cameraApproved: z.boolean().optional(), // câmera declarada pelo motorista: conferida (adesivo de aviso no carro) ou barrada
});

const settingsPatch = z.object({
  currentSurge: z.number().min(1).max(3).optional(),
  surgeCap: z.number().min(1).max(3).optional(),
  dispatchRadiusKm: z.number().min(1).max(50).optional(),
  selfieValidityHours: z.number().int().min(1).max(72).optional(),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

const money = z.number().int().min(0).max(1_000_000);
const categoryPut = z.object({
  name: z.string().min(2).max(40),
  baseFareCents: money, perKmCents: money, perMinCents: money, minFareCents: money,
  perHourCents: money.optional(),
  extraFeeCents: money.optional(),
  description: z.string().trim().max(120).optional(),
  active: z.boolean().default(true),
});
const planPut = z.object({
  name: z.string().min(2).max(60),
  priceCents: money,
  periodDays: z.number().int().min(0).max(365),
  commissionPct: z.number().min(0).max(50),
  active: z.boolean().default(true),
});

async function driverOfTenant(req: FastifyRequest, id: string) {
  parse(uuid, id);
  const d = await one(
    `SELECT d.*, u.name, u.phone, u.created_at, u.tenant_id
       FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1 AND u.tenant_id = $2`,
    [id, req.auth.tenantId],
  );
  if (!d) throw notFound('Motorista não encontrado');
  return d;
}

function driverRow(d: any) {
  return {
    id: d.user_id, name: d.name, phone: d.phone, status: d.status, category: d.category_code,
    vehicle: { plate: d.vehicle_plate, model: d.vehicle_model, color: d.vehicle_color },
    compliance: { cnhEarOk: d.cnh_ear_ok, inssOk: d.inss_ok, criminalRecordOk: d.criminal_record_ok, insuranceAppOk: d.insurance_app_ok },
    pix: { key: d.pix_key, holderName: d.pix_holder_name, validated: d.pix_validated },
    plan: d.plan_code, trialUntil: d.trial_until, paidUntil: d.paid_until,
    vehicleType: d.vehicle_type, services: d.services_opt_in, verified: d.verified,
    photoStatus: d.photo_status, hasPhoto: !!d.photo_path, hasVehiclePhoto: !!d.vehicle_photo_path,
    photoReview: d.photo_review, pendingPhoto: !!d.photo_pending_path, pendingVehiclePhoto: !!d.vehicle_pending_path,
    camera: d.camera_kind ? { kind: d.camera_kind, status: d.camera_status, declaredAt: d.camera_declared_at } : null,
    online: d.online, location: d.lat != null ? { lat: d.lat, lng: d.lng, at: d.location_at } : null,
    selfieCheckedAt: d.selfie_checked_at, hasSelfie: !!d.selfie_path, createdAt: d.created_at,
    rating: d.rating_average != null ? {
      average: Number(d.rating_average), ratings: d.rating_count,
      low: d.rating_count >= RATING.minRatings && Number(d.rating_average) < RATING.below, alertAt: d.rating_alert_at ?? null,
    } : null,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAuth('tenant_admin') };

  app.get('/admin/overview', admin, async (req) => {
    const t = req.auth.tenantId;
    const r = await one(
      `SELECT
         (SELECT count(*) FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.tenant_id = $1 AND d.online)::int AS drivers_online,
         (SELECT count(*) FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.tenant_id = $1 AND d.status = 'pending')::int AS drivers_pending,
         (SELECT count(*) FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.tenant_id = $1 AND d.status = 'approved')::int AS drivers_approved,
         (SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'passenger')::int AS passengers,
         (SELECT count(*) FROM rides WHERE tenant_id = $1 AND status IN ('requested','accepted','arrived','in_progress'))::int AS rides_active,
         (SELECT count(*) FROM rides WHERE tenant_id = $1 AND status = 'completed' AND completed_at >= date_trunc('day', now()))::int AS rides_today,
         (SELECT coalesce(sum(price_cents),0) FROM rides WHERE tenant_id = $1 AND status = 'completed' AND completed_at >= date_trunc('day', now()))::int AS gross_today_cents,
         (SELECT coalesce(sum(commission_cents),0) FROM rides WHERE tenant_id = $1 AND status = 'completed' AND completed_at >= date_trunc('month', now()))::int AS commission_month_cents,
         (SELECT coalesce(sum(amount_cents),0) FROM subscription_payments sp JOIN users u ON u.id = sp.driver_id WHERE u.tenant_id = $1 AND sp.paid_at >= date_trunc('month', now()))::int AS subscriptions_month_cents,
         (SELECT count(*) FROM panic_alerts WHERE tenant_id = $1 AND resolved_at IS NULL)::int AS open_alerts`,
      [t],
    );
    return r;
  });

  app.get('/admin/map', admin, async (req) => {
    const drivers = await query(
      `SELECT d.user_id AS id, u.name, d.vehicle_plate AS plate, d.lat, d.lng, d.location_at,
              EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = d.user_id AND r.status IN ('accepted','arrived','in_progress')) AS busy
         FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE u.tenant_id = $1 AND d.online AND d.lat IS NOT NULL`,
      [req.auth.tenantId],
    );
    const rides = await query(
      `SELECT id FROM rides WHERE tenant_id = $1 AND status IN ('requested','accepted','arrived','in_progress')`,
      [req.auth.tenantId],
    );
    const active = [];
    for (const r of rides) active.push(rideView(await loadRide(r.id), 'admin'));
    const t = await one('SELECT min_lat, max_lat, min_lng, max_lng FROM tenants WHERE id = $1', [req.auth.tenantId]);
    return { drivers, rides: active, area: t };
  });

  // ---------- motoristas ----------

  app.get('/admin/drivers', admin, async (req) => {
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'blocked', 'nota_baixa']).optional() }), req.query);
    const rows = await query(
      `SELECT d.*, u.name, u.phone, u.created_at, rt.rating_average, rt.rating_count,
              (SELECT max(created_at) FROM driver_rating_alerts a WHERE a.driver_id = d.user_id) AS rating_alert_at
         FROM drivers d JOIN users u ON u.id = d.user_id
         -- média das últimas 50 avaliações dos passageiros
         LEFT JOIN LATERAL (
           SELECT round(avg(s)::numeric, 2) AS rating_average, count(*)::int AS rating_count FROM (
             SELECT driver_rating AS s FROM rides WHERE driver_id = d.user_id AND driver_rating IS NOT NULL
              ORDER BY completed_at DESC NULLS LAST LIMIT ${RATING.window}) last) rt ON true
        WHERE u.tenant_id = $1 AND u.deleted_at IS NULL AND ($2::text IS NULL OR d.status = $2
              OR ($2 = 'nota_baixa' AND rt.rating_count >= ${RATING.minRatings} AND rt.rating_average < ${RATING.below})
              -- "aguardando": também quem já trabalha mas mandou foto nova ou declarou câmera para a central conferir
              OR ($2 = 'pending' AND u.deleted_at IS NULL AND (d.photo_review = 'pending' OR d.camera_status = 'pending')))
        ORDER BY (d.status = 'pending') DESC, u.created_at DESC`,
      [req.auth.tenantId, q.status ?? null],
    );
    return { drivers: rows.map(driverRow) };
  });

  app.get<Params>('/admin/drivers/:id', admin, async (req) => {
    const d = await driverOfTenant(req, req.params.id);
    const payments = await query(
      `SELECT plan_code, amount_cents, period_start, period_end, paid_at,
              CASE WHEN registered_by IS NULL THEN 'mercadopago' ELSE 'manual' END AS source FROM subscription_payments
        WHERE driver_id = $1 ORDER BY paid_at DESC LIMIT 12`,
      [d.user_id],
    );
    const stats = await one(
      `SELECT count(*)::int AS rides, round(avg(driver_rating), 2) AS rating
         FROM rides WHERE driver_id = $1 AND status = 'completed'`,
      [d.user_id],
    );
    return { driver: driverRow(d), payments, stats };
  });

  app.patch<Params>('/admin/drivers/:id', admin, async (req) => {
    const d = await driverOfTenant(req, req.params.id);
    const b = parse(driverPatch, req.body);
    const next = {
      cnh: b.cnhEarOk ?? d.cnh_ear_ok, inss: b.inssOk ?? d.inss_ok,
      crim: b.criminalRecordOk ?? d.criminal_record_ok, ins: b.insuranceAppOk ?? d.insurance_app_ok,
    };
    if (b.status === 'approved' && !(next.cnh && next.inss && next.crim && next.ins)) {
      throw badRequest('Para aprovar, confira CNH com EAR, INSS, antecedentes criminais e seguro APP', 'documentos_pendentes');
    }
    if (b.pixValidated && !d.pix_key) throw badRequest('Motorista não cadastrou chave Pix');
    if (b.photoApproved && (!(d.photo_pending_path ?? d.photo_path) || !(d.vehicle_pending_path ?? d.vehicle_photo_path))) {
      throw badRequest('Faltam fotos: o motorista precisa enviar a foto dele e a do veículo', 'fotos_faltando');
    }
    if (b.planCode) {
      const p = await one('SELECT 1 FROM driver_plans WHERE tenant_id = $1 AND code = $2', [req.auth.tenantId, b.planCode]);
      if (!p) throw badRequest('Plano inválido');
    }
    const status = b.status ?? d.status;
    await query(
      `UPDATE drivers SET status = $2, cnh_ear_ok = $3, inss_ok = $4, criminal_record_ok = $5, insurance_app_ok = $6,
              pix_validated = $7, plan_code = $8, online = CASE WHEN $2 <> 'approved' OR ($11::boolean = false AND photo_status <> 'approved') THEN false ELSE online END,
              vehicle_type = $9, verified = $10,
              -- aprovar: as fotos em análise passam a ser as que o cliente vê
              photo_path = CASE WHEN $11::boolean THEN coalesce(photo_pending_path, photo_path) ELSE photo_path END,
              vehicle_photo_path = CASE WHEN $11::boolean THEN coalesce(vehicle_pending_path, vehicle_photo_path) ELSE vehicle_photo_path END,
              photo_pending_path = CASE WHEN $11::boolean IS NULL THEN photo_pending_path ELSE NULL END,
              vehicle_pending_path = CASE WHEN $11::boolean IS NULL THEN vehicle_pending_path ELSE NULL END,
              photo_review = CASE WHEN $11::boolean IS NULL THEN photo_review WHEN $11 THEN NULL ELSE 'rejected' END,
              -- recusar fotos novas não tira as que já estavam aprovadas
              photo_status = CASE WHEN $11::boolean IS NULL THEN photo_status WHEN $11 THEN 'approved'
                                  WHEN photo_status = 'approved' THEN 'approved' ELSE 'rejected' END,
              category_code = CASE $9 WHEN 'moto' THEN 'moto' WHEN 'utilitario' THEN 'frete' ELSE 'carro' END
        WHERE user_id = $1`,
      [d.user_id, status, next.cnh, next.inss, next.crim, next.ins, b.pixValidated ?? d.pix_validated, b.planCode ?? d.plan_code,
       b.vehicleType ?? d.vehicle_type, b.verified ? [...new Set(b.verified)] : d.verified, b.photoApproved ?? null],
    );
    if (b.cameraApproved !== undefined) {
      if (!d.camera_kind) throw badRequest('Este motorista não declarou câmera', 'sem_camera');
      await query(`UPDATE drivers SET camera_status = $2 WHERE user_id = $1`, [d.user_id, b.cameraApproved ? 'approved' : 'rejected']);
    }
    // fotos que deixaram de ser usadas são apagadas: as antigas trocadas ou as novas recusadas
    if (b.photoApproved === true) {
      await removeImages(d.photo_pending_path && d.photo_path !== d.photo_pending_path ? d.photo_path : null,
        d.vehicle_pending_path && d.vehicle_photo_path !== d.vehicle_pending_path ? d.vehicle_photo_path : null);
    } else if (b.photoApproved === false) {
      await removeImages(d.photo_pending_path, d.vehicle_pending_path);
    }
    return { driver: driverRow(await driverOfTenant(req, req.params.id)) };
  });

  // Registra o pagamento da mensalidade e estende a validade do plano
  app.post<Params>('/admin/drivers/:id/payments', admin, async (req, reply) => {
    const d = await driverOfTenant(req, req.params.id);
    const { periods } = parse(z.object({ periods: z.number().int().min(1).max(12).default(1) }), req.body ?? {});
    const plan = await one('SELECT * FROM driver_plans WHERE tenant_id = $1 AND code = $2', [req.auth.tenantId, d.plan_code]);
    if (!plan || plan.period_days === 0) throw badRequest('O plano deste motorista não tem mensalidade');
    // pagamento recebido por fora (dinheiro, Pix direto): o licenciado registra aqui
    const result = await tx((db) => extendDriverPlan(db, d.user_id, plan.code, plan.period_days * periods, plan.price_cents * periods, req.auth.id));
    reply.code(201);
    return { paidUntil: result.paid_until, amountCents: plan.price_cents * periods };
  });

  // ?versao=nova mostra a foto em análise; sem ela, a aprovada (ou a mais nova, se ainda não há aprovada)
  app.get<Params & { Querystring: { which?: string; versao?: string } }>('/admin/drivers/:id/photo', admin, async (req, reply) => {
    const d = await driverOfTenant(req, req.params.id);
    const veic = req.query.which === 'veiculo';
    const current = veic ? d.vehicle_photo_path : d.photo_path;
    const pending = veic ? d.vehicle_pending_path : d.photo_pending_path;
    return sendImage(reply, req.query.versao === 'nova' ? pending : current ?? pending);
  });

  app.get<Params>('/admin/drivers/:id/selfie', admin, async (req, reply) => {
    const d = await driverOfTenant(req, req.params.id);
    if (!d.selfie_path) throw notFound('Sem selfie');
    const base = resolve(config.uploadDir);
    const file = resolve(base, d.selfie_path);
    if (!file.startsWith(base + sep) || !existsSync(file)) throw notFound('Sem selfie');
    reply.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg');
    return reply.send(createReadStream(file));
  });

  // ---------- corridas e alertas ----------

  app.get('/admin/rides', admin, async (req) => {
    const q = parse(z.object({
      status: z.enum(['active', 'scheduled', 'completed', 'cancelled', 'all']).default('all'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);
    const filter = {
      active: `AND status IN ('requested','accepted','arrived','in_progress')`,
      scheduled: `AND status = 'scheduled'`,
      completed: `AND status = 'completed'`,
      cancelled: `AND status = 'cancelled'`,
      all: '',
    }[q.status];
    const rows = await query(
      `SELECT id FROM rides WHERE tenant_id = $1 ${filter} ORDER BY requested_at DESC LIMIT $2`,
      [req.auth.tenantId, q.limit],
    );
    const rides = [];
    for (const r of rows) rides.push(rideView(await loadRide(r.id), 'admin'));
    return { rides };
  });

  app.get('/admin/alerts', admin, async (req) => {
    const q = parse(z.object({ open: z.enum(['true', 'false']).default('true') }), req.query);
    const rows = await query(
      `SELECT a.*, u.name AS user_name, u.role AS user_role, r.status AS ride_status,
              du.name AS driver_name, d.vehicle_plate
         FROM panic_alerts a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN rides r ON r.id = a.ride_id
         LEFT JOIN users du ON du.id = r.driver_id
         LEFT JOIN drivers d ON d.user_id = r.driver_id
        WHERE a.tenant_id = $1 AND ($2 = 'false' OR a.resolved_at IS NULL)
        ORDER BY a.created_at DESC LIMIT 100`,
      [req.auth.tenantId, q.open],
    );
    return { alerts: rows };
  });

  app.post<Params>('/admin/alerts/:id/resolve', admin, async (req) => {
    parse(uuid, req.params.id);
    const { note } = parse(z.object({ note: z.string().max(500).optional() }), req.body ?? {});
    const a = await one(
      `UPDATE panic_alerts SET resolved_at = now(), resolved_by = $3, note = $4
        WHERE id = $1 AND tenant_id = $2 AND resolved_at IS NULL RETURNING id`,
      [req.params.id, req.auth.tenantId, req.auth.id, note ?? null],
    );
    if (!a) throw notFound('Alerta não encontrado ou já resolvido');
    emitTo(`admin:${req.auth.tenantId}`, 'alert:resolved', { id: a.id });
    return { ok: true };
  });

  // ---------- configurações, tarifas e planos ----------

  app.get('/admin/settings', admin, async (req) => {
    return one(
      `SELECT slug, name, city_label, accent_color, current_surge, surge_cap, dispatch_radius_km,
              selfie_validity_hours, license_fee_per_ride_cents FROM tenants WHERE id = $1`,
      [req.auth.tenantId],
    );
  });

  app.patch('/admin/settings', admin, async (req) => {
    const b = parse(settingsPatch, req.body);
    const t = await one('SELECT * FROM tenants WHERE id = $1', [req.auth.tenantId]);
    const cap = b.surgeCap ?? Number(t.surge_cap);
    const surge = b.currentSurge ?? Number(t.current_surge);
    if (surge > cap) throw badRequest(`A tarifa dinâmica não pode passar do teto de ${cap}x`, 'acima_do_teto');
    return one(
      `UPDATE tenants SET current_surge = $2, surge_cap = $3, dispatch_radius_km = $4, selfie_validity_hours = $5, accent_color = $6
        WHERE id = $1
        RETURNING slug, name, city_label, accent_color, current_surge, surge_cap, dispatch_radius_km, selfie_validity_hours, license_fee_per_ride_cents`,
      [req.auth.tenantId, surge, cap, b.dispatchRadiusKm ?? t.dispatch_radius_km,
       b.selfieValidityHours ?? t.selfie_validity_hours, b.accentColor ?? t.accent_color],
    );
  });

  app.get('/admin/categories', admin, async (req) => ({
    categories: await query('SELECT * FROM ride_categories WHERE tenant_id = $1 ORDER BY sort, min_fare_cents', [req.auth.tenantId]),
  }));

  app.put<CodeParams>('/admin/categories/:code', admin, async (req) => {
    const code = parse(z.string().regex(/^[a-z0-9-]{2,20}$/, 'código inválido'), req.params.code);
    const b = parse(categoryPut, req.body);
    return one(
      `INSERT INTO ride_categories (tenant_id, code, name, base_fare_cents, per_km_cents, per_min_cents, min_fare_cents, active,
                                   per_hour_cents, extra_fee_cents, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9, 0), coalesce($10, 0), coalesce($11, ''))
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = $3, base_fare_cents = $4, per_km_cents = $5,
         per_min_cents = $6, min_fare_cents = $7, active = $8,
         per_hour_cents = coalesce($9, ride_categories.per_hour_cents),
         extra_fee_cents = coalesce($10, ride_categories.extra_fee_cents),
         description = coalesce($11, ride_categories.description)
       RETURNING *`,
      [req.auth.tenantId, code, b.name, b.baseFareCents, b.perKmCents, b.perMinCents, b.minFareCents, b.active,
       b.perHourCents ?? null, b.extraFeeCents ?? null, b.description ?? null],
    );
  });

  app.get('/admin/plans', admin, async (req) => ({
    plans: await query('SELECT * FROM driver_plans WHERE tenant_id = $1 ORDER BY price_cents', [req.auth.tenantId]),
  }));

  app.put<CodeParams>('/admin/plans/:code', admin, async (req) => {
    const code = parse(z.string().regex(/^[a-z0-9-]{2,20}$/, 'código inválido'), req.params.code);
    const b = parse(planPut, req.body);
    if (b.periodDays === 0 && b.priceCents > 0) throw badRequest('Plano sem período não pode ter mensalidade');
    return one(
      `INSERT INTO driver_plans (tenant_id, code, name, price_cents, period_days, commission_pct, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = $3, price_cents = $4, period_days = $5, commission_pct = $6, active = $7
       RETURNING *`,
      [req.auth.tenantId, code, b.name, b.priceCents, b.periodDays, b.commissionPct, b.active],
    );
  });
}
