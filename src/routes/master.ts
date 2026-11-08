import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { hashPassword, requireAuth } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { parse, phone, uuid } from '../lib/validate.js';
import { createTenantDefaults } from '../lib/rides.js';

const box = z.object({
  minLat: z.number(), maxLat: z.number(), minLng: z.number(), maxLng: z.number(),
}).refine((b) => b.minLat < b.maxLat && b.minLng < b.maxLng, 'área inválida');

const createTenant = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/, 'use só letras minúsculas, números e hífen'),
  name: z.string().min(3).max(60),
  cityLabel: z.string().min(2).max(60),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#F2622E'),
  licenseFeePerRideCents: z.number().int().min(0).max(1000).default(20),
  licenseMonthlyCents: z.number().int().min(0).max(10_000_000).default(0),
  area: box.optional(),
  admin: z.object({ name: z.string().min(3).max(80), phone, password: z.string().min(8) }),
});

export async function masterRoutes(app: FastifyInstance) {
  const master = { preHandler: requireAuth('master') };

  app.get('/master/tenants', master, async () => {
    const rows = await query(
      `SELECT t.id, t.slug, t.name, t.city_label, t.active, t.suspended_reason, t.license_fee_per_ride_cents,
              t.license_monthly_cents, t.created_at, (t.mp_access_token_enc IS NOT NULL) AS mp_connected,
              (SELECT coalesce(sum(i.total_cents),0) FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'open')::int AS open_invoices_cents,
              (SELECT count(*) FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.tenant_id = t.id AND d.status = 'approved')::int AS drivers,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.role = 'passenger')::int AS passengers,
              (SELECT count(*) FROM rides r WHERE r.tenant_id = t.id AND r.status = 'completed'
                 AND r.completed_at >= date_trunc('month', now()))::int AS rides_month,
              (SELECT coalesce(sum(license_fee_cents),0) FROM rides r WHERE r.tenant_id = t.id AND r.status = 'completed'
                 AND r.completed_at >= date_trunc('month', now()))::int AS license_fee_month_cents
         FROM tenants t ORDER BY t.created_at`,
    );
    return { tenants: rows };
  });

  app.post('/master/tenants', master, async (req, reply) => {
    const b = parse(createTenant, req.body);
    const exists = await one('SELECT 1 FROM tenants WHERE slug = $1', [b.slug]);
    if (exists) throw conflict('Já existe um licenciado com esse endereço', 'slug_em_uso');
    const tenant = await tx(async (db) => {
      const t = await one(
        `INSERT INTO tenants (slug, name, city_label, accent_color, license_fee_per_ride_cents, min_lat, max_lat, min_lng, max_lng, license_monthly_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, slug, name, city_label, accent_color, active, license_fee_per_ride_cents, license_monthly_cents, created_at`,
        [b.slug, b.name, b.cityLabel, b.accentColor, b.licenseFeePerRideCents,
         b.area?.minLat ?? null, b.area?.maxLat ?? null, b.area?.minLng ?? null, b.area?.maxLng ?? null, b.licenseMonthlyCents], db,
      );
      await createTenantDefaults(t.id, db);
      await query(
        `INSERT INTO users (tenant_id, role, name, phone, password_hash) VALUES ($1,'tenant_admin',$2,$3,$4)`,
        [t.id, b.admin.name, b.admin.phone, await hashPassword(b.admin.password)], db,
      );
      return t;
    });
    reply.code(201);
    return { tenant };
  });

  app.patch<{ Params: { id: string } }>('/master/tenants/:id', master, async (req) => {
    parse(uuid, req.params.id);
    const b = parse(z.object({
      active: z.boolean().optional(),
      licenseFeePerRideCents: z.number().int().min(0).max(1000).optional(),
      licenseMonthlyCents: z.number().int().min(0).max(10_000_000).optional(),
    }), req.body);
    const t = await one(
      `UPDATE tenants SET active = coalesce($2, active), license_fee_per_ride_cents = coalesce($3, license_fee_per_ride_cents),
              license_monthly_cents = coalesce($4, license_monthly_cents),
              suspended_reason = CASE WHEN $2 IS NULL THEN suspended_reason WHEN $2 THEN NULL ELSE 'manual' END
        WHERE id = $1 RETURNING id, slug, name, active, suspended_reason, license_fee_per_ride_cents, license_monthly_cents`,
      [req.params.id, b.active ?? null, b.licenseFeePerRideCents ?? null, b.licenseMonthlyCents ?? null],
    );
    if (!t) throw notFound('Licenciado não encontrado');
    if (b.active === false) {
      // suspenso: ninguém da cidade fica online
      await query(`UPDATE drivers SET online = false WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [t.id]);
    }
    return { tenant: t };
  });
}
