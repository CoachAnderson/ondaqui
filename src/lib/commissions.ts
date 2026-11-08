import { one, query, tx, type Db, pool } from './db.js';
import { CHANNEL_UPDATES, pushTo } from './push.js';
import { emitTo } from './realtime.js';

/**
 * Comissão do plano Livre.
 *  • Corrida paga direto ao motorista (dinheiro, Pix ou maquininha): o motorista recebe tudo e fica devendo a
 *    comissão. Toda segunda-feira as corridas da semana anterior viram uma fatura, com 3 dias para pagar.
 *    Vencida, o motorista não recebe corridas até pagar.
 *  • Corrida paga pela central (Prefeitura, loja com conta): a central repassa já sem a comissão.
 */
export const DIRECT_PAYMENTS = ['cash', 'pix', 'card'] as const;
export const COMMISSION_DUE_DAYS = 3;

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/** Fecha a semana (segunda a domingo) em faturas de comissão; corridas antigas que ficaram de fora entram junto */
export async function generateCommissionInvoices(weekStart?: string) {
  const start = weekStart ?? (await one<{ d: string }>(`SELECT (date_trunc('week', now()) - interval '7 days')::date AS d`))!.d;
  const groups = await query<{ driver_id: string; tenant_id: string }>(
    `SELECT DISTINCT r.driver_id, r.tenant_id FROM rides r
      WHERE r.status = 'completed' AND r.commission_cents > 0 AND r.commission_invoice_id IS NULL
        AND r.payment_method = ANY($2::text[]) AND r.completed_at < $1::date + 7
        AND NOT EXISTS (SELECT 1 FROM commission_invoices i WHERE i.driver_id = r.driver_id AND i.period_start = $1::date)`,
    [start, [...DIRECT_PAYMENTS]],
  );
  const created = [];
  for (const g of groups) {
    const inv = await tx(async (db) => {
      const sum = await one<{ n: number; gross: number; amount: number }>(
        `SELECT count(*)::int AS n, coalesce(sum(price_cents), 0)::int AS gross, coalesce(sum(commission_cents), 0)::int AS amount
           FROM rides WHERE driver_id = $1 AND status = 'completed' AND commission_cents > 0 AND commission_invoice_id IS NULL
            AND payment_method = ANY($3::text[]) AND completed_at < $2::date + 7`,
        [g.driver_id, start, [...DIRECT_PAYMENTS]], db,
      );
      if (!sum || sum.amount <= 0) return null;
      const i = await one(
        `INSERT INTO commission_invoices (tenant_id, driver_id, period_start, period_end, rides, gross_cents, amount_cents, due_date)
         VALUES ($1, $2, $3::date, $3::date + 6, $4, $5, $6, current_date + $7::int)
         ON CONFLICT (driver_id, period_start) DO NOTHING RETURNING *`,
        [g.tenant_id, g.driver_id, start, sum.n, sum.gross, sum.amount, COMMISSION_DUE_DAYS], db,
      );
      if (!i) return null;
      await query(
        `UPDATE rides SET commission_invoice_id = $1
          WHERE driver_id = $2 AND status = 'completed' AND commission_cents > 0 AND commission_invoice_id IS NULL
            AND payment_method = ANY($4::text[]) AND completed_at < $3::date + 7`,
        [i.id, g.driver_id, start, [...DIRECT_PAYMENTS]], db,
      );
      return i;
    });
    if (!inv) continue;
    created.push(inv);
    const due = new Date(`${String(inv.due_date).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
    emitTo(`user:${inv.driver_id}`, 'commission:new', { id: inv.id });
    await pushTo(inv.driver_id, {
      title: 'Comissão da semana',
      body: `${inv.rides} corridas pagas direto a você: comissão de ${brl(inv.amount_cents)}. Pague pelo app até ${due}.`,
      channelId: CHANNEL_UPDATES, data: { type: 'commission' },
    }).catch(() => {});
  }
  return created;
}

/** Fatura de comissão vencida e em aberto impede o motorista de trabalhar */
export const COMMISSION_OVERDUE_SQL = (driverCol: string) =>
  `EXISTS (SELECT 1 FROM commission_invoices ci WHERE ci.driver_id = ${driverCol} AND ci.status = 'open' AND ci.due_date < current_date)`;

/** Resumo para o app do motorista */
export async function driverCommissions(driverId: string, db: Db = pool) {
  const pending = await one<{ n: number; amount: number }>(
    `SELECT count(*)::int AS n, coalesce(sum(commission_cents), 0)::int AS amount FROM rides
      WHERE driver_id = $1 AND status = 'completed' AND commission_cents > 0 AND commission_invoice_id IS NULL
        AND payment_method = ANY($2::text[])`,
    [driverId, [...DIRECT_PAYMENTS]], db,
  );
  const invoices = await query(
    `SELECT id, period_start, period_end, rides, gross_cents, amount_cents, cashback_offset_cents, due_date, status, paid_at, paid_by,
            (status = 'open' AND due_date < current_date) AS overdue
       FROM commission_invoices WHERE driver_id = $1 AND status <> 'cancelled'
      ORDER BY period_start DESC LIMIT 12`,
    [driverId], db,
  );
  return { pendingRides: pending?.n ?? 0, pendingCents: pending?.amount ?? 0, invoices };
}

/** A central recebeu a comissão por fora (dinheiro, Pix direto) ou perdoou */
export async function settleCommission(id: string, tenantId: string, by: string, how: 'central' | 'cancelar', note?: string) {
  const inv = await one(
    how === 'central'
      ? `UPDATE commission_invoices SET status = 'paid', paid_at = now(), paid_by = 'central', registered_by = $3, note = $4
          WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING *`
      : `UPDATE commission_invoices SET status = 'cancelled', registered_by = $3, note = $4
          WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING *`,
    [id, tenantId, by, note ?? null],
  );
  if (inv) {
    // cobranças abertas no Mercado Pago para esta fatura não valem mais
    await query(`UPDATE charges SET status = 'cancelled' WHERE commission_invoice_id = $1 AND status = 'pending'`, [id]);
    emitTo(`user:${inv.driver_id}`, 'commission:paid', { id });
  }
  return inv;
}
