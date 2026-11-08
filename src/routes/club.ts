import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { parse, phone } from '../lib/validate.js';
import { emitTo } from '../lib/realtime.js';
import { createClubCharge, syncCharge, tenantMpToken } from '../lib/billing.js';
import { TODAY_SQL, clubRulesOf, clubView, grantClub } from '../lib/club.js';

const rulesPatch = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(3).max(30).optional(),
  priceCents: z.number().int().min(100).max(100_000).optional(),
  discountPct: z.number().min(0).max(30).optional(),
  discountMaxCents: z.number().int().min(0).max(10_000).optional(),
  noSurge: z.boolean().optional(),
  cashbackMultiplier: z.number().int().min(1).max(3).optional(),
  priority: z.boolean().optional(),
});

export async function clubRoutes(app: FastifyInstance) {
  const passenger = { preHandler: requireAuth('passenger') };
  const admin = { preHandler: requireAuth('tenant_admin') };

  // ---------- passageiro ----------
  app.get('/club', passenger, async (req) => clubView(req.auth.id, req.auth.tenantId!, !!(await tenantMpToken(req.auth.tenantId!))));

  app.post('/club/checkout', passenger, async (req, reply) => {
    const r = await createClubCharge(req.auth.id, req.auth.tenantId!);
    reply.code(201);
    return r;
  });

  /** O app chama ao voltar do Mercado Pago: confere os pagamentos recentes do Clube deste passageiro */
  app.post('/club/sync', passenger, async (req) => {
    const pending = await query<{ id: string }>(
      `SELECT id FROM charges WHERE passenger_id = $1 AND kind = 'clube' AND status IN ('pending', 'rejected', 'expired')
         AND created_at > now() - interval '72 hours' ORDER BY created_at DESC LIMIT 5`,
      [req.auth.id],
    );
    const results = [];
    for (const c of pending) {
      try { results.push(await syncCharge(c.id)); } catch { results.push('erro'); }
    }
    const u = await one(`SELECT club_until::text AS until FROM users WHERE id = $1`, [req.auth.id]);
    return { applied: results.includes('aplicado'), pending: results.includes('pendente'), until: u?.until ?? null };
  });

  // ---------- licenciado ----------
  async function adminView(tenantId: string) {
    const t = await one(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
    const month = `>= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;
    const s = await one(
      `SELECT (SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'passenger' AND deleted_at IS NULL AND club_until >= ${TODAY_SQL})::int AS members,
              (SELECT count(*) FROM users WHERE tenant_id = $1 AND role = 'passenger' AND deleted_at IS NULL
                 AND club_until BETWEEN ${TODAY_SQL} AND ${TODAY_SQL} + 3)::int AS expiring,
              (SELECT coalesce(sum(amount_cents), 0) FROM club_payments WHERE tenant_id = $1 AND created_at ${month})::int AS revenue_month,
              (SELECT count(*) FROM club_payments WHERE tenant_id = $1 AND created_at ${month})::int AS payments_month,
              (SELECT coalesce(sum(club_discount_cents), 0) FROM rides WHERE tenant_id = $1 AND status = 'completed' AND completed_at ${month})::int AS discounts_month,
              (SELECT count(*) FROM rides WHERE tenant_id = $1 AND status = 'completed' AND club_member AND completed_at ${month})::int AS rides_month`,
      [tenantId],
    );
    const members = await query(
      `SELECT u.id, u.name, u.phone, u.club_until::text AS until, (u.club_until >= ${TODAY_SQL}) AS active,
              (SELECT count(*) FROM club_payments p WHERE p.user_id = u.id)::int AS months,
              (SELECT coalesce(sum(amount_cents), 0) FROM club_payments p WHERE p.user_id = u.id)::int AS paid_cents,
              (SELECT coalesce(sum(club_discount_cents), 0) FROM rides r WHERE r.passenger_id = u.id AND r.status = 'completed' AND r.club_member)::int AS saved_cents
         FROM users u WHERE u.tenant_id = $1 AND u.role = 'passenger' AND u.deleted_at IS NULL AND u.club_until IS NOT NULL
        ORDER BY (u.club_until >= ${TODAY_SQL}) DESC, u.club_until DESC LIMIT 200`,
      [tenantId],
    );
    return { rules: clubRulesOf(t), summary: s, members, mercadopago: !!t.mp_access_token_enc };
  }

  app.get('/admin/club', admin, async (req) => adminView(req.auth.tenantId!));

  app.patch('/admin/club', admin, async (req) => {
    const b = parse(rulesPatch, req.body);
    await query(
      `UPDATE tenants SET club_enabled = coalesce($2, club_enabled), club_name = coalesce($3, club_name),
              club_price_cents = coalesce($4, club_price_cents), club_discount_pct = coalesce($5, club_discount_pct),
              club_discount_max_cents = coalesce($6, club_discount_max_cents), club_no_surge = coalesce($7, club_no_surge),
              club_cashback_multiplier = coalesce($8, club_cashback_multiplier), club_priority = coalesce($9, club_priority)
        WHERE id = $1`,
      [req.auth.tenantId, b.enabled ?? null, b.name ?? null, b.priceCents ?? null, b.discountPct ?? null, b.discountMaxCents ?? null,
       b.noSurge ?? null, b.cashbackMultiplier ?? null, b.priority ?? null],
    );
    return adminView(req.auth.tenantId!);
  });

  // meses de cortesia, ou um pagamento recebido por fora (dinheiro, Pix direto na central)
  app.post('/admin/club/grant', admin, async (req) => {
    const b = parse(z.object({
      phone,
      months: z.number().int().min(1).max(12),
      amountCents: z.number().int().min(0).max(1_000_000).default(0),
      note: z.string().trim().min(3, 'Escreva o motivo').max(120),
    }), req.body);
    const r = await tx((db) => grantClub(req.auth.tenantId!, b.phone, b.months, b.amountCents, b.note, req.auth.id, db));
    emitTo(`user:${r.userId}`, 'club:paid', { until: r.until });
    return { passenger: r.name, until: r.until };
  });
}
