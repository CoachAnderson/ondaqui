import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { one, query } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { parse, latLng } from '../lib/validate.js';
import { driverWorkStatus } from '../lib/rides.js';
import { emitTo } from '../lib/realtime.js';
import { RATING, acknowledgeRatingAlerts, driverRating, openRatingAlert } from '../lib/ratings.js';
import { config } from '../lib/config.js';
import { decodeImage, removeImages, saveImage, sendImage } from '../lib/images.js';
import { DRIVER_OPT_IN } from '../lib/rides.js';
import { sqlDistanceKm } from '../lib/geo.js';

export async function driverRoutes(app: FastifyInstance) {
  const driver = { preHandler: requireAuth('driver') };

  app.get('/driver/me', driver, async (req) => {
    const d = await one(
      `SELECT d.status, d.photo_status, d.photo_review,
              (coalesce(d.photo_pending_path, d.photo_path) IS NOT NULL) AS has_photo,
              (coalesce(d.vehicle_pending_path, d.vehicle_photo_path) IS NOT NULL) AS has_vehicle_photo,
              d.category_code, d.vehicle_type, d.services_opt_in, d.verified, d.vehicle_plate, d.vehicle_model, d.vehicle_color,
              d.pix_key, d.pix_holder_name, d.pix_validated, d.plan_code, d.trial_until, d.paid_until,
              d.online, d.selfie_checked_at, d.camera_kind, d.camera_status, p.name AS plan_name, p.price_cents AS plan_price_cents,
              p.period_days, p.commission_pct
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         JOIN driver_plans p ON p.tenant_id = u.tenant_id AND p.code = d.plan_code
        WHERE d.user_id = $1`,
      [req.auth.id],
    );
    const work = await driverWorkStatus(req.auth.id);
    const mp = await one(`SELECT mp_access_token_enc IS NOT NULL AS ok FROM tenants WHERE id = $1`, [req.auth.tenantId]);
    const rating = await driverRating(req.auth.id);
    const alert = await openRatingAlert(req.auth.id);
    return {
      ...d, canWork: work.ok, blockedReason: work.reason, onlinePayment: !!mp?.ok,
      rating: { ...rating, below: RATING.below, minRatings: RATING.minRatings,
        alert: alert ? { average: Number(alert.average), ratings: alert.ratings, at: alert.created_at, acknowledged: !!alert.acknowledged_at } : null },
    };
  });

  // Selfie de início de turno (antigolpe): sem ela o motorista não fica online.
  // A comparação automática com a foto do cadastro entra na fase 2.
  app.post('/driver/shift-selfie', { ...driver, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const { image } = parse(z.object({ image: z.string().min(100) }), req.body);
    const { buf, ext } = decodeImage(image);
    const dir = resolve(config.uploadDir, 'selfies');
    await mkdir(dir, { recursive: true });
    const name = `${req.auth.id}-${Date.now()}.${ext}`;
    await writeFile(join(dir, name), buf);
    const old = await one('SELECT selfie_path FROM drivers WHERE user_id = $1', [req.auth.id]);
    await query(`UPDATE drivers SET selfie_checked_at = now(), selfie_path = $2 WHERE user_id = $1`, [req.auth.id, `selfies/${name}`]);
    // só a selfie do turno atual fica guardada (privacidade)
    if (old?.selfie_path && old.selfie_path !== `selfies/${name}`) await removeImages(old.selfie_path);
    return { ok: true };
  });

  // o motorista leu o aviso de nota baixa
  app.post('/driver/rating-alert/ack', driver, async (req) => {
    await acknowledgeRatingAlerts(req.auth.id);
    return { ok: true };
  });

  // Câmera de segurança no veículo: o motorista declara e assume o compromisso; o passageiro passa a ser avisado
  app.put('/driver/camera', driver, async (req) => {
    const b = parse(z.object({
      kind: z.enum(['none', 'video', 'video_audio']),
      agree: z.boolean().optional(),
    }), req.body);
    if (b.kind !== 'none' && b.agree !== true) {
      throw badRequest('Para usar câmera, aceite o compromisso de uso das gravações', 'compromisso_camera');
    }
    const d = await one(
      b.kind === 'none'
        ? `UPDATE drivers SET camera_kind = NULL, camera_status = NULL, camera_declared_at = NULL WHERE user_id = $1
           RETURNING camera_kind, camera_status`
        : `UPDATE drivers SET camera_kind = $2,
                  camera_status = CASE WHEN camera_kind = $2 AND camera_status = 'approved' THEN 'approved' ELSE 'pending' END,
                  camera_declared_at = now()
            WHERE user_id = $1 RETURNING camera_kind, camera_status`,
      b.kind === 'none' ? [req.auth.id] : [req.auth.id, b.kind],
    );
    emitTo(`admin:${req.auth.tenantId}`, 'driver:status', { driverId: req.auth.id });
    return { cameraKind: d.camera_kind, cameraStatus: d.camera_status };
  });

  // foto do perfil e do veículo: aparecem para o cliente depois que a central aprova
  app.post('/driver/photos', { ...driver, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const b = parse(z.object({ which: z.enum(['perfil', 'veiculo']), image: z.string().min(100) }), req.body);
    const path = await saveImage('motoristas', `${req.auth.id}-${b.which}`, b.image);
    // a foto nova fica em análise; quem já tem fotos aprovadas continua trabalhando com elas
    const r = await one(
      `UPDATE drivers SET ${b.which === 'perfil' ? 'photo_pending_path' : 'vehicle_pending_path'} = $2, photo_review = 'pending',
              photo_status = CASE WHEN photo_status = 'approved' THEN 'approved' ELSE 'pending' END
        WHERE user_id = $1 RETURNING photo_status, photo_review`,
      [req.auth.id, path],
    );
    emitTo(`admin:${req.auth.tenantId}`, 'driver:photo', { driverId: req.auth.id });
    return { photoStatus: r.photo_status, photoReview: r.photo_review };
  });

  app.get<{ Params: { which: string } }>('/driver/photos/:which', driver, async (req, reply) => {
    // o motorista vê a foto mais nova que mandou (em análise ou aprovada)
    const d = await one('SELECT photo_path, vehicle_photo_path, photo_pending_path, vehicle_pending_path FROM drivers WHERE user_id = $1', [req.auth.id]);
    return sendImage(reply, req.params.which === 'veiculo' ? d?.vehicle_pending_path ?? d?.vehicle_photo_path : d?.photo_pending_path ?? d?.photo_path);
  });

  // serviços que o próprio motorista escolhe atender (Pet, Entrega, Particular)
  app.put('/driver/services', driver, async (req) => {
    const { services } = parse(z.object({ services: z.array(z.enum(DRIVER_OPT_IN)).max(DRIVER_OPT_IN.length) }), req.body);
    const r = await one(
      `UPDATE drivers SET services_opt_in = $2 WHERE user_id = $1 RETURNING services_opt_in, verified`,
      [req.auth.id, [...new Set(services)]],
    );
    return { services: r.services_opt_in, verified: r.verified };
  });

  app.post('/driver/online', driver, async (req) => {
    const { online } = parse(z.object({ online: z.boolean() }), req.body);
    if (online) {
      const can = await driverWorkStatus(req.auth.id);
      if (!can.ok) throw forbidden(can.reason!);
    }
    await query('UPDATE drivers SET online = $2 WHERE user_id = $1', [req.auth.id, online]);
    emitTo(`admin:${req.auth.tenantId}`, 'driver:status', { driverId: req.auth.id, online });
    return { online };
  });

  app.post('/driver/location', driver, async (req) => {
    const p = parse(latLng.extend({ heading: z.number().optional() }), req.body);
    await query(`UPDATE drivers SET lat = $2, lng = $3, location_at = now() WHERE user_id = $1`, [req.auth.id, p.lat, p.lng]);
    const active = await one(
      `SELECT id, passenger_id FROM rides WHERE driver_id = $1 AND status IN ('accepted','arrived','in_progress')`,
      [req.auth.id],
    );
    const payload = { driverId: req.auth.id, lat: p.lat, lng: p.lng, heading: p.heading ?? null, rideId: active?.id ?? null };
    if (active) emitTo([`ride:${active.id}`, `user:${active.passenger_id}`], 'driver:location', payload);
    emitTo(`admin:${req.auth.tenantId}`, 'driver:location', payload);
    return { ok: true };
  });

  // Ofertas ainda abertas (o app pode ter estado fechado quando a oferta chegou)
  app.get('/driver/offers', driver, async (req) => {
    const rows = await query(
      `SELECT r.id AS ride_id, r.origin_lat, r.origin_lng, r.origin_address, r.dest_lat, r.dest_lng, r.dest_address,
              r.distance_km, r.duration_min, r.price_cents, r.payment_method,
              r.kind, r.scheduled_for, r.hours_booked, r.cod_amount_cents, r.helpers, r.notes, r.package_desc, r.wheelchair, r.companion, r.shift_id,
              (SELECT c.name FROM ride_categories c WHERE c.tenant_id = r.tenant_id AND c.code = r.category_code) AS service_name,
              ${sqlDistanceKm('r.origin_lat', 'r.origin_lng', 'd.lat', 'd.lng')} AS pickup_km
         FROM ride_offers o
         JOIN rides r ON r.id = o.ride_id
         JOIN drivers d ON d.user_id = o.driver_id
        WHERE o.driver_id = $1 AND o.status = 'sent' AND r.status = 'requested'
          AND o.created_at > now() - interval '2 minutes'
        ORDER BY o.created_at DESC`,
      [req.auth.id],
    );
    return {
      offers: rows.map((r) => ({
        rideId: r.ride_id,
        pickupDistanceKm: r.pickup_km != null ? Math.round(r.pickup_km * 10) / 10 : null,
        origin: { lat: r.origin_lat, lng: r.origin_lng, address: r.origin_address },
        destination: { lat: r.dest_lat, lng: r.dest_lng, address: r.dest_address },
        distanceKm: r.distance_km, durationMin: r.duration_min, priceCents: r.price_cents, paymentMethod: r.payment_method,
        kind: r.kind, serviceName: r.service_name, scheduledFor: r.scheduled_for, hoursBooked: r.hours_booked,
        helpers: r.helpers, notes: r.notes, packageDesc: r.package_desc, wheelchair: r.wheelchair, companion: r.companion,
        codAmountCents: r.cod_amount_cents, shift: !!r.shift_id,
      })),
    };
  });

  app.get('/driver/earnings', driver, async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(1) }), req.query);
    const r = await one(
      `SELECT count(*)::int AS rides,
              coalesce(sum(price_cents) FILTER (WHERE shift_id IS NULL), 0)::int AS gross_cents,
              coalesce(sum(commission_cents), 0)::int AS commission_cents,
              -- a central repassa já sem a comissão do plano (entregas do turno fixo são pagas pelo turno)
              coalesce(sum(price_cents - commission_cents) FILTER (WHERE payment_method IN ('convenio', 'conta_loja') AND shift_id IS NULL), 0)::int AS convenio_cents,
              (SELECT coalesce(sum(driver_cents), 0) FROM food_shifts s
                WHERE s.driver_id = $1 AND s.status = 'concluido' AND s.ends_at > now() - make_interval(days => $2))::int AS shift_cents
         FROM rides
        WHERE driver_id = $1 AND status = 'completed' AND completed_at > now() - make_interval(days => $2)`,
      [req.auth.id, q.days],
    );
    return { days: q.days, rides: r.rides, grossCents: r.gross_cents + r.shift_cents, commissionCents: r.commission_cents,
             netCents: r.gross_cents + r.shift_cents - r.commission_cents,
             // corridas de paciente e entregas de loja: a central repassa; turnos de entregador fixo (Daqui Food) também
             toReceiveFromCentralCents: r.convenio_cents + r.shift_cents, shiftCents: r.shift_cents };
  });
}
