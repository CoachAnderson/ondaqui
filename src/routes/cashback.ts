import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse, phone, uuid } from '../lib/validate.js';
import { emitTo } from '../lib/realtime.js';
import { adjustCashback, driverCashback, rulesOf, walletOf } from '../lib/cashback.js';

type Params = { Params: { id: string } };

const rulesPatch = z.object({
  pct: z.number().min(0).max(30).optional(),                   // 0 desliga o cashback do licenciado
  maxRideCents: z.number().int().min(0).max(10_000).optional(),
  maxMonthCents: z.number().int().min(0).max(100_000).optional(),
  days: z.number().int().min(7).max(365).optional(),
  usePct: z.number().int().min(10).max(100).optional(),
});

export async function cashbackRoutes(app: FastifyInstance) {
  const passenger = { preHandler: requireAuth('passenger') };
  const driver = { preHandler: requireAuth('driver') };
  const admin = { preHandler: requireAuth('tenant_admin') };
  const operator = { preHandler: requireAuth('account_operator') };

  // ---------- passageiro: saldo, vencimento e extrato ----------
  app.get('/cashback', passenger, async (req) => walletOf(req.auth.id, req.auth.tenantId!));

  // ---------- motorista: o que a central deve pelo cashback usado nas corridas dele ----------
  app.get('/driver/cashback', driver, async (req) => driverCashback(req.auth.id));

  // ---------- licenciado: regras, resumo e acerto com os motoristas ----------
  async function adminView(tenantId: string) {
    const t = await one(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
    const month = `created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;
    const s = await one(
      `SELECT coalesce(sum(amount_cents) FILTER (WHERE kind = 'corrida' AND ${month}), 0)::int AS from_rides_month,
              coalesce(sum(amount_cents) FILTER (WHERE kind = 'loja' AND ${month}), 0)::int AS from_stores_month,
              coalesce(sum(amount_cents) FILTER (WHERE kind = 'ajuste' AND amount_cents > 0 AND ${month}), 0)::int AS courtesy_month,
              -coalesce(sum(amount_cents) FILTER (WHERE kind IN ('uso', 'devolucao') AND ${month}), 0)::int AS used_month,
              -coalesce(sum(amount_cents) FILTER (WHERE kind = 'expirado' AND ${month}), 0)::int AS expired_month,
              coalesce(sum(amount_cents) FILTER (WHERE user_id IS NOT NULL), 0)::int AS balances,
              coalesce(sum(amount_cents) FILTER (WHERE user_id IS NULL), 0)::int AS waiting_signup,
              count(DISTINCT user_id) FILTER (WHERE kind IN ('uso') AND ${month})::int AS passengers_used_month
         FROM cashback_ledger WHERE tenant_id = $1`,
      [tenantId],
    );
    const payable = await one(
      `SELECT (SELECT coalesce(sum(amount_cents), 0) FROM cashback_payouts WHERE tenant_id = $1 AND status = 'open')::int AS open_cents,
              (SELECT coalesce(sum(cashback_used_cents + club_discount_cents), 0) FROM rides
                WHERE tenant_id = $1 AND status = 'completed' AND (cashback_used_cents + club_discount_cents) > 0 AND cashback_payout_id IS NULL)::int AS week_cents`,
      [tenantId],
    );
    const payouts = await query(
      `SELECT p.*, u.name AS driver_name, u.phone AS driver_phone, d.vehicle_plate, d.pix_key, d.pix_holder_name, d.pix_validated
         FROM cashback_payouts p JOIN users u ON u.id = p.driver_id LEFT JOIN drivers d ON d.user_id = p.driver_id
        WHERE p.tenant_id = $1 ORDER BY (p.status = 'open') DESC, p.period_start DESC, u.name LIMIT 100`,
      [tenantId],
    );
    const stores = await query(
      `SELECT a.id, a.name, a.cashback_per_order_cents,
              coalesce((SELECT sum(l.amount_cents) FROM cashback_ledger l WHERE l.account_id = a.id AND l.kind = 'loja' AND l.${month}), 0)::int AS given_month,
              (SELECT count(*) FROM cashback_ledger l WHERE l.account_id = a.id AND l.kind = 'loja' AND l.${month})::int AS orders_month
         FROM accounts a WHERE a.tenant_id = $1 AND a.kind = 'loja' AND a.active AND a.cashback_per_order_cents > 0 ORDER BY a.name`,
      [tenantId],
    );
    return { rules: rulesOf(t), summary: { ...s, ...payable }, payouts, stores };
  }

  app.get('/admin/cashback', admin, async (req) => adminView(req.auth.tenantId!));

  app.patch('/admin/cashback', admin, async (req) => {
    const b = parse(rulesPatch, req.body);
    await query(
      `UPDATE tenants SET cashback_pct = coalesce($2, cashback_pct), cashback_max_ride_cents = coalesce($3, cashback_max_ride_cents),
              cashback_max_month_cents = coalesce($4, cashback_max_month_cents), cashback_days = coalesce($5, cashback_days),
              cashback_use_pct = coalesce($6, cashback_use_pct)
        WHERE id = $1`,
      [req.auth.tenantId, b.pct ?? null, b.maxRideCents ?? null, b.maxMonthCents ?? null, b.days ?? null, b.usePct ?? null],
    );
    return adminView(req.auth.tenantId!);
  });

  // a central pagou o motorista (Pix por fora)
  app.post<Params>('/admin/cashback/payouts/:id/mark-paid', admin, async (req) => {
    parse(uuid, req.params.id);
    const { note } = parse(z.object({ note: z.string().trim().max(200).optional() }), req.body ?? {});
    const p = await one(
      `UPDATE cashback_payouts SET status = 'paid', paid_at = now(), registered_by = $3, note = $4
        WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING *`,
      [req.params.id, req.auth.tenantId, req.auth.id, note ?? null],
    );
    if (!p) throw notFound('Repasse não encontrado ou já pago');
    emitTo(`user:${p.driver_id}`, 'cashback:payout', { id: p.id, status: 'paid' });
    return { payout: p };
  });

  // cortesia ou correção: crédito (ou débito) no saldo de um passageiro pelo celular
  app.post('/admin/cashback/adjust', admin, async (req) => {
    const b = parse(z.object({
      phone,
      amountCents: z.number().int().min(-50_000).max(50_000).refine((v) => v !== 0, 'Informe o valor'),
      note: z.string().trim().min(3, 'Escreva o motivo').max(120),
    }), req.body);
    const u = await one(
      `SELECT id, name FROM users WHERE tenant_id = $1 AND phone = $2 AND role = 'passenger' AND deleted_at IS NULL`, [req.auth.tenantId, b.phone],
    );
    if (!u) throw notFound('Nenhum passageiro com este celular');
    const balance = await adjustCashback(req.auth.tenantId!, u.id, b.amountCents, b.note, req.auth.id);
    if (balance == null) throw badRequest('O saldo do passageiro é menor que o valor a tirar', 'saldo_insuficiente');
    emitTo(`user:${u.id}`, 'cashback:updated', { reason: 'ajuste' });
    return { passenger: u.name, balanceCents: balance };
  });

  // ---------- loja: quanto dá de cashback por pedido entregue ----------
  async function myStore(req: FastifyRequest) {
    const a = await one(`SELECT a.* FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [req.auth.id]);
    if (!a || a.kind !== 'loja') throw notFound('Loja não encontrada');
    return a;
  }

  app.get('/account/store/cashback', operator, async (req) => {
    const a = await myStore(req);
    const t = await one(`SELECT name, cashback_days FROM tenants WHERE id = $1`, [a.tenant_id]);
    const s = await one(
      `SELECT count(*)::int AS orders, coalesce(sum(amount_cents), 0)::int AS total,
              count(*) FILTER (WHERE user_id IS NULL)::int AS waiting_signup
         FROM cashback_ledger
        WHERE account_id = $1 AND kind = 'loja' AND created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
      [a.id],
    );
    return { amountCents: a.cashback_per_order_cents, days: t.cashback_days, appName: t.name, month: s };
  });

  app.put('/account/store/cashback', operator, async (req) => {
    const a = await myStore(req);
    const { amountCents } = parse(z.object({ amountCents: z.number().int().min(0).max(5000) }), req.body);
    if (amountCents > 0 && amountCents < 50) throw badRequest('O cashback mínimo é R$ 0,50 por pedido', 'cashback_minimo');
    await query(`UPDATE accounts SET cashback_per_order_cents = $2 WHERE id = $1`, [a.id, amountCents]);
    return { amountCents };
  });
}
