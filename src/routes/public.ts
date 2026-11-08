import type { FastifyInstance } from 'fastify';
import { one, query } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { sendImage } from '../lib/images.js';
import { config } from '../lib/config.js';

export async function publicRoutes(app: FastifyInstance) {
  // Marca, categorias e planos de uma cidade (usado pelos apps ao abrir)
  app.get<{ Params: { slug: string } }>('/public/tenants/:slug', async (req) => {
    const t = await one(
      `SELECT id, slug, name, city_label, accent_color, current_surge, surge_cap,
              min_lat, max_lat, min_lng, max_lng
         FROM tenants WHERE slug = $1 AND active`,
      [req.params.slug],
    );
    if (!t) throw notFound('Cidade não encontrada');
    const categories = await query(
      `SELECT code, name, kind, vehicle_type, requires, description, base_fare_cents, per_km_cents, per_min_cents,
              min_fare_cents, per_hour_cents, extra_fee_cents
         FROM ride_categories WHERE tenant_id = $1 AND active AND kind <> 'paciente' ORDER BY sort, min_fare_cents`,
      [t.id],
    );
    const plans = await query(
      `SELECT code, name, price_cents, period_days, commission_pct
         FROM driver_plans WHERE tenant_id = $1 AND active ORDER BY price_cents`,
      [t.id],
    );
    const { id, ...brand } = t;
    // algum motorista da cidade usa câmera: o app avisa o passageiro já na hora de pedir
    const cam = await one(
      `SELECT EXISTS (SELECT 1 FROM drivers d JOIN users u ON u.id = d.user_id
                       WHERE u.tenant_id = $1 AND d.camera_status IN ('pending', 'approved')) AS on`,
      [t.id],
    );
    return { ...brand, categories, plans, phoneVerification: config.phoneVerification, camerasInUse: !!cam?.on };
  });

  // Fotos do acompanhamento: motorista e veículo (só durante a corrida), logo da loja e comprovante de entrega
  app.get<{ Params: { token: string; which: string } }>('/public/share/:token/photo/:which', async (req, reply) => {
    const r = await one(
      `SELECT r.status, r.dropoff_photo_path, d.photo_status, d.photo_path, d.vehicle_photo_path, a.logo_path
         FROM rides r LEFT JOIN drivers d ON d.user_id = r.driver_id LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.share_token = $1`,
      [req.params.token],
    );
    if (!r) throw notFound('Link inválido');
    const active = ['accepted', 'arrived', 'in_progress'].includes(r.status);
    const path = req.params.which === 'logo' ? r.logo_path
      : req.params.which === 'entrega' ? (r.status === 'completed' ? r.dropoff_photo_path : null)
      : r.photo_status === 'approved' && active ? (req.params.which === 'veiculo' ? r.vehicle_photo_path : r.photo_path) : null;
    return sendImage(reply, path);
  });

  // Acompanhar corrida pelo link compartilhado (família, amigos)
  app.get<{ Params: { token: string } }>('/public/share/:token', async (req) => {
    const r = await one(
      `SELECT r.status, r.origin_address, r.dest_address, r.requested_at, r.started_at, r.completed_at, r.route_polyline,
              r.origin_lat, r.origin_lng, r.dest_lat, r.dest_lng,
              r.kind, r.recipient_name, r.delivery_code, r.scheduled_for, c.name AS service_name,
              (d.photo_status = 'approved' AND d.photo_path IS NOT NULL) AS photo_ok,
              (d.photo_status = 'approved' AND d.vehicle_photo_path IS NOT NULL) AS vehicle_ok,
              (r.dropoff_photo_path IS NOT NULL) AS dropoff_ok,
              a.name AS store_name, (a.kind = 'loja' AND a.logo_path IS NOT NULL) AS logo_ok,
              du.name AS driver_name, d.vehicle_plate, d.vehicle_model, d.vehicle_color,
              CASE WHEN d.camera_status IN ('pending', 'approved') AND r.kind <> 'entrega' THEN d.camera_kind END AS camera,
              CASE WHEN r.status IN ('accepted','arrived','in_progress') THEN d.lat END AS lat,
              CASE WHEN r.status IN ('accepted','arrived','in_progress') THEN d.lng END AS lng,
              t.name AS tenant_name
         FROM rides r
         JOIN tenants t ON t.id = r.tenant_id
         LEFT JOIN ride_categories c ON c.tenant_id = r.tenant_id AND c.code = r.category_code
         LEFT JOIN accounts a ON a.id = r.account_id
         LEFT JOIN users du ON du.id = r.driver_id
         LEFT JOIN drivers d ON d.user_id = r.driver_id
        WHERE r.share_token = $1`,
      [req.params.token],
    );
    if (!r) throw notFound('Link inválido');
    return {
      status: r.status,
      tenant: r.tenant_name,
      kind: r.kind,
      service: r.service_name,
      scheduledFor: r.scheduled_for,
      // Daqui Entrega: o remetente manda este link para quem vai receber, com o código de entrega
      delivery: r.kind === 'entrega'
        ? { recipientName: r.recipient_name, code: r.status === 'completed' || r.status === 'cancelled' ? null : r.delivery_code }
        : null,
      origin: r.origin_address,
      destination: r.dest_address,
      // traçado e pontas da viagem, para o mapa da família (só enquanto a corrida não acabou)
      route: ['accepted', 'arrived', 'in_progress'].includes(r.status)
        ? { polyline: r.route_polyline ?? null, from: { lat: r.origin_lat, lng: r.origin_lng }, to: r.dest_lat != null ? { lat: r.dest_lat, lng: r.dest_lng } : null }
        : null,
      driver: r.driver_name
        ? {
            name: r.driver_name.split(/\s+/)[0],
            vehicle: { plate: r.vehicle_plate, model: r.vehicle_model, color: r.vehicle_color },
            location: r.lat != null ? { lat: r.lat, lng: r.lng } : null,
            hasPhoto: !!r.photo_ok && ['accepted', 'arrived', 'in_progress'].includes(r.status),
            hasVehiclePhoto: !!r.vehicle_ok && ['accepted', 'arrived', 'in_progress'].includes(r.status),
            camera: r.camera ?? null,
          }
        : null,
      store: r.logo_ok || r.store_name ? { name: r.store_name, hasLogo: !!r.logo_ok } : null,
      // comprovante: foto da entrega, para quem recebeu ou mandou
      hasDropoffPhoto: !!r.dropoff_ok && r.status === 'completed',
      requestedAt: r.requested_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    };
  });
}
