import { one, pool, query, tx, type Db } from './db.js';
import { CHANNEL_UPDATES, pushTo } from './push.js';
import { emitTo } from './realtime.js';
import { sendSms, toE164 } from './sms.js';
import { debitStoreCashback } from './stores.js';

/**
 * Cashback do passageiro.
 *  • Ganha: % da corrida paga pelo licenciado (teto por corrida e por mês) e valor fixo por pedido de loja.
 *  • Usa: ao pedir, até X% do valor da corrida; paga menos ao motorista.
 *  • Vence: cada crédito vale N dias. O mais antigo é usado (e vence) primeiro.
 *  • O motorista recebe o valor cheio: o cashback usado entra no acerto da semana (abate da comissão ou Pix da central).
 * Não é dinheiro: não pode ser sacado nem transferido.
 */

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
const dateBr = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const dayKey = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

/** créditos (o que vence); devolução não conta como crédito novo: desfaz um uso */
const GRANT_KINDS = `kind IN ('corrida', 'loja', 'ajuste') AND amount_cents > 0`;

export interface CashbackRules {
  enabled: boolean; pct: number; maxRideCents: number; maxMonthCents: number; days: number; usePct: number;
}

export function rulesOf(t: any): CashbackRules {
  return {
    enabled: Number(t.cashback_pct) > 0,
    pct: Number(t.cashback_pct),
    maxRideCents: t.cashback_max_ride_cents,
    maxMonthCents: t.cashback_max_month_cents,
    days: t.cashback_days,
    usePct: t.cashback_use_pct,
  };
}

/**
 * Vence o que passou da validade. Conta pelo mais antigo primeiro: tudo que já saiu (usos e vencidos)
 * consome os créditos mais velhos; o que sobrar de crédito vencido sai agora.
 */
export async function expireCashback(userId?: string, db: Db = pool) {
  const rows = await query<{ user_id: string; amount: number }>(
    `WITH s AS (
       SELECT user_id, tenant_id,
              coalesce(sum(amount_cents) FILTER (WHERE ${GRANT_KINDS} AND expires_at <= now()), 0) AS g,
              -coalesce(sum(amount_cents) FILTER (WHERE amount_cents < 0 OR kind = 'devolucao'), 0) AS d
         FROM cashback_ledger WHERE user_id IS NOT NULL ${userId ? 'AND user_id = $1' : ''}
        GROUP BY user_id, tenant_id
     )
     INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, note)
     SELECT tenant_id, user_id, 'expirado', -(g - d), 'passou da validade' FROM s WHERE g - d > 0
     RETURNING user_id, -amount_cents AS amount`,
    userId ? [userId] : [], db,
  );
  return rows;
}

export async function balanceOf(userId: string, db: Db = pool) {
  const r = await one<{ b: number }>(`SELECT coalesce(sum(amount_cents), 0)::int AS b FROM cashback_ledger WHERE user_id = $1`, [userId], db);
  return r?.b ?? 0;
}

/** Saldo, próximo vencimento e extrato, para o app */
export async function walletOf(userId: string, tenantId: string) {
  await expireCashback(userId);
  const t = await one(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
  const entries = await query(
    `SELECT l.id, l.kind, l.amount_cents, l.expires_at, l.created_at, l.note, a.name AS store_name, r.dest_address
       FROM cashback_ledger l
       LEFT JOIN accounts a ON a.id = l.account_id
       LEFT JOIN rides r ON r.id = l.ride_id
      WHERE l.user_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 40`,
    [userId],
  );
  // quanto resta de cada crédito, do mais antigo para o mais novo
  const all = await query<{ kind: string; amount_cents: number; expires_at: Date | null }>(
    `SELECT kind, amount_cents, expires_at FROM cashback_ledger WHERE user_id = $1 ORDER BY expires_at NULLS LAST, id`, [userId],
  );
  let spent = -all.filter((e) => e.amount_cents < 0 || e.kind === 'devolucao').reduce((s, e) => s + e.amount_cents, 0);
  let next: { amountCents: number; expiresAt: Date } | null = null;
  for (const g of all.filter((e) => e.amount_cents > 0 && e.kind !== 'devolucao')) {
    const left = g.amount_cents - Math.min(spent, g.amount_cents);
    spent = Math.max(0, spent - g.amount_cents);
    if (left > 0 && g.expires_at) {
      // junta tudo o que vence no mesmo dia (horário de Brasília)
      if (!next) next = { amountCents: left, expiresAt: g.expires_at };
      else if (dayKey(g.expires_at) === dayKey(next.expiresAt)) next.amountCents += left;
      else break;
    }
  }
  return {
    balanceCents: await balanceOf(userId),
    nextExpiry: next,
    rules: rulesOf(t),
    entries: entries.map((e) => ({
      id: String(e.id), kind: e.kind, amountCents: e.amount_cents, createdAt: e.created_at, expiresAt: e.expires_at,
      label: e.kind === 'corrida' ? `Corrida para ${e.dest_address ?? 'destino'}`
        : e.kind === 'loja' ? `Presente de ${e.store_name ?? 'uma loja'}`
        : e.kind === 'uso' ? `Usado na corrida para ${e.dest_address ?? 'destino'}`
        : e.kind === 'devolucao' ? 'Devolvido: corrida cancelada'
        : e.kind === 'expirado' ? 'Venceu'
        : e.note ?? 'Ajuste da central',
    })),
  };
}

/** Quanto do saldo dá para usar nesta corrida */
export const usableFor = (balanceCents: number, priceCents: number, usePct: number) =>
  Math.max(0, Math.min(balanceCents, Math.floor((priceCents * usePct) / 100)));

/**
 * Reserva o cashback ao pedir (dentro da transação que cria a corrida).
 * Trava o passageiro para duas corridas ao mesmo tempo (a dele e a de um parente) não usarem o mesmo saldo.
 */
export async function useCashback(db: Db, tenantId: string, userId: string, rideId: string, priceCents: number) {
  await one(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId], db);
  await expireCashback(userId, db);
  const t = await one(`SELECT cashback_use_pct FROM tenants WHERE id = $1`, [tenantId], db);
  const used = usableFor(await balanceOf(userId, db), priceCents, t.cashback_use_pct);
  if (used <= 0) return 0;
  await query(
    `INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, ride_id) VALUES ($1, $2, 'uso', $3, $4)`,
    [tenantId, userId, -used, rideId], db,
  );
  await query(`UPDATE rides SET cashback_used_cents = $2 WHERE id = $1`, [rideId, used], db);
  return used;
}

/** Corrida cancelada: o cashback reservado volta para o saldo (uma vez só) */
export async function releaseCashback(rideId: string, db: Db = pool) {
  const r = await one(
    `INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, ride_id, note)
     SELECT tenant_id, user_id, 'devolucao', -amount_cents, ride_id, 'corrida cancelada' FROM cashback_ledger
      WHERE ride_id = $1 AND kind = 'uso'
        AND EXISTS (SELECT 1 FROM rides WHERE id = $1 AND status = 'cancelled')
     ON CONFLICT DO NOTHING RETURNING user_id, amount_cents`,
    [rideId], db,
  );
  if (r) emitTo(`user:${r.user_id}`, 'cashback:updated', { reason: 'devolucao' });
  return r?.amount_cents ?? 0;
}

/** Rodada de segurança: devolve o que ficou reservado em corridas canceladas por qualquer caminho */
export async function releaseCancelledCashback() {
  const rows = await query<{ ride_id: string }>(
    `SELECT l.ride_id FROM cashback_ledger l JOIN rides r ON r.id = l.ride_id
      WHERE l.kind = 'uso' AND r.status = 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM cashback_ledger x WHERE x.ride_id = l.ride_id AND x.kind = 'devolucao')`,
  );
  for (const r of rows) await releaseCashback(r.ride_id);
  return rows.length;
}

/**
 * Corrida finalizada: o passageiro ganha a % do licenciado sobre o que pagou (sem o cashback usado),
 * respeitando o teto por corrida e por mês. Corridas pagas por loja ou Prefeitura não geram cashback.
 */
export async function earnRideCashback(rideId: string) {
  return tx(async (db) => {
    const r = await one(
      `SELECT r.id, r.tenant_id, r.passenger_id, r.account_id, r.price_cents, r.cashback_used_cents, r.club_discount_cents, r.club_member, r.status,
              t.cashback_pct, t.cashback_max_ride_cents, t.cashback_max_month_cents, t.cashback_days,
              CASE WHEN r.club_member AND t.club_enabled THEN t.club_cashback_multiplier ELSE 1 END AS mult
         FROM rides r JOIN tenants t ON t.id = r.tenant_id WHERE r.id = $1`,
      [rideId], db,
    );
    if (!r || r.status !== 'completed' || !r.passenger_id || r.account_id || Number(r.cashback_pct) <= 0) return 0;
    await one(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [r.passenger_id], db);
    const month = await one<{ s: number }>(
      `SELECT coalesce(sum(amount_cents), 0)::int AS s FROM cashback_ledger
        WHERE user_id = $1 AND kind = 'corrida' AND created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
      [r.passenger_id], db,
    );
    // assinante do Clube ganha o cashback multiplicado (e os tetos também)
    const mult = Number(r.mult) || 1;
    const paid = r.price_cents - r.cashback_used_cents - r.club_discount_cents;
    const earned = Math.min(
      Math.floor((paid * Number(r.cashback_pct) * mult) / 100),
      r.cashback_max_ride_cents * mult,
      Math.max(0, r.cashback_max_month_cents * mult - (month?.s ?? 0)),
    );
    if (earned < 1) return 0;
    const ins = await one(
      `INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, ride_id, expires_at)
       VALUES ($1, $2, 'corrida', $3, $4, now() + make_interval(days => $5))
       ON CONFLICT DO NOTHING RETURNING id`,
      [r.tenant_id, r.passenger_id, earned, r.id, r.cashback_days], db,
    );
    if (!ins) return 0;
    await query(`UPDATE rides SET cashback_earned_cents = $2 WHERE id = $1`, [r.id, earned], db);
    emitTo(`user:${r.passenger_id}`, 'cashback:updated', { reason: 'corrida', amountCents: earned });
    return earned;
  });
}

/**
 * Pedido de loja entregue: o cliente ganha o cashback que a loja oferece, pago pelo saldo da loja.
 * Quem recebe ainda não tem o app: o crédito fica guardado no celular e entra na conta no cadastro.
 */
export async function earnStoreCashback(rideId: string) {
  const res = await tx(async (db) => {
    const r = await one(
      `SELECT r.id, r.tenant_id, r.account_id, r.recipient_phone, r.status, r.kind,
              a.kind AS account_kind, a.name AS store_name, a.cashback_per_order_cents AS amount,
              t.name AS tenant_name, t.cashback_days
         FROM rides r JOIN accounts a ON a.id = r.account_id JOIN tenants t ON t.id = r.tenant_id WHERE r.id = $1`,
      [rideId], db,
    );
    if (!r || r.status !== 'completed' || r.kind !== 'entrega' || r.account_kind !== 'loja' || !(r.amount > 0) || !r.recipient_phone) return null;
    const holder = await one(
      `SELECT id, role FROM users WHERE tenant_id = $1 AND phone = $2 AND deleted_at IS NULL`, [r.tenant_id, r.recipient_phone], db,
    );
    if (holder && holder.role !== 'passenger') return null; // celular de motorista ou da equipe: não ganha
    if (await one(`SELECT 1 FROM cashback_ledger WHERE ride_id = $1 AND kind = 'loja'`, [r.id], db)) return null;
    if (!(await debitStoreCashback(db, r.account_id, r.id, r.amount))) return null; // loja sem saldo
    // SMS para quem não tem o app: no máximo um por semana para o mesmo celular
    const recentSms = holder ? true : !!(await one(
      `SELECT 1 FROM cashback_ledger WHERE tenant_id = $1 AND user_id IS NULL AND phone = $2 AND kind = 'loja' AND created_at > now() - interval '7 days'`,
      [r.tenant_id, r.recipient_phone], db,
    ));
    const e = await one(
      `INSERT INTO cashback_ledger (tenant_id, user_id, phone, kind, amount_cents, ride_id, account_id, expires_at)
       VALUES ($1, $2, $3, 'loja', $4, $5, $6, now() + make_interval(days => $7)) RETURNING expires_at`,
      [r.tenant_id, holder?.id ?? null, holder ? null : r.recipient_phone, r.amount, r.id, r.account_id, r.cashback_days], db,
    );
    await query(`UPDATE rides SET cashback_earned_cents = $2 WHERE id = $1`, [r.id, r.amount], db);
    return { ...r, holderId: holder?.id ?? null, sms: !holder && !recentSms, expiresAt: e!.expires_at as Date };
  });
  if (!res) return 0;
  emitTo(`account:${res.account_id}`, 'account:balance', { kind: 'cashback' });
  if (res.holderId) {
    emitTo(`user:${res.holderId}`, 'cashback:updated', { reason: 'loja', amountCents: res.amount });
    await pushTo(res.holderId, {
      title: `${res.store_name} te deu ${brl(res.amount)} de cashback`,
      body: 'Já está no seu saldo para usar na próxima corrida.',
      channelId: CHANNEL_UPDATES, data: { type: 'cashback' },
    }).catch(() => {});
  } else if (res.sms) {
    const text = `${res.store_name} te deu ${brl(res.amount)} de crédito para corridas no app ${res.tenant_name}. `
      + `Baixe o app e cadastre este celular até ${dateBr(res.expiresAt)} para usar.`;
    await sendSms({ to: toE164(res.recipient_phone), code: '', tenant: res.tenant_id, text })
      .catch((err) => console.error('[cashback] SMS não enviado:', err instanceof Error ? err.message : err));
  }
  return res.amount as number;
}

/** Cadastro novo: o crédito guardado no celular passa para a conta */
export async function claimPhoneCashback(db: Db, tenantId: string, userId: string, phone: string) {
  const r = await query(
    `UPDATE cashback_ledger SET user_id = $3, phone = NULL WHERE tenant_id = $1 AND user_id IS NULL AND phone = $2 RETURNING amount_cents`,
    [tenantId, phone, userId], db,
  );
  return r.reduce((s, x) => s + x.amount_cents, 0);
}

/** Crédito ou débito manual da central (cortesia, correção de reclamação) */
export async function adjustCashback(tenantId: string, userId: string, amountCents: number, note: string, by: string) {
  return tx(async (db) => {
    const t = await one(`SELECT cashback_days FROM tenants WHERE id = $1`, [tenantId], db);
    await one(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId], db);
    if (amountCents < 0 && (await balanceOf(userId, db)) + amountCents < 0) return null;
    await query(
      `INSERT INTO cashback_ledger (tenant_id, user_id, kind, amount_cents, note, created_by, expires_at)
       VALUES ($1, $2, 'ajuste', $3, $4, $5, CASE WHEN $3 > 0 THEN now() + make_interval(days => $6) END)`,
      [tenantId, userId, amountCents, note, by, t.cashback_days], db,
    );
    return balanceOf(userId, db);
  });
}

// ---------- acerto com o motorista ----------

/**
 * Fecha a semana (segunda a domingo) do cashback usado nas corridas de cada motorista.
 * Roda depois das faturas de comissão: o que der é abatido da comissão da mesma semana;
 * o resto a central paga ao motorista (Pix). Pode rodar várias vezes.
 */
export async function generateCashbackPayouts(weekStart?: string) {
  const start = weekStart ?? (await one<{ d: string }>(`SELECT (date_trunc('week', now()) - interval '7 days')::date AS d`))!.d;
  const groups = await query<{ driver_id: string; tenant_id: string }>(
    `SELECT DISTINCT r.driver_id, r.tenant_id FROM rides r
      WHERE r.status = 'completed' AND (r.cashback_used_cents + r.club_discount_cents) > 0 AND r.cashback_payout_id IS NULL AND r.completed_at < $1::date + 7
        AND NOT EXISTS (SELECT 1 FROM cashback_payouts p WHERE p.driver_id = r.driver_id AND p.period_start = $1::date)`,
    [start],
  );
  const created = [];
  for (const g of groups) {
    const p = await tx(async (db) => {
      const sum = await one<{ n: number; total: number }>(
        `SELECT count(*)::int AS n, coalesce(sum(cashback_used_cents + club_discount_cents), 0)::int AS total FROM rides
          WHERE driver_id = $1 AND status = 'completed' AND (cashback_used_cents + club_discount_cents) > 0 AND cashback_payout_id IS NULL AND completed_at < $2::date + 7`,
        [g.driver_id, start], db,
      );
      if (!sum || sum.total <= 0) return null;
      const inv = await one(
        `SELECT * FROM commission_invoices WHERE driver_id = $1 AND period_start = $2::date AND status = 'open' FOR UPDATE`,
        [g.driver_id, start], db,
      );
      const offset = inv ? Math.min(inv.amount_cents, sum.total) : 0;
      const amount = sum.total - offset;
      const payout = await one(
        `INSERT INTO cashback_payouts (tenant_id, driver_id, period_start, period_end, rides, cashback_cents, offset_cents, amount_cents,
                                       commission_invoice_id, status, paid_at)
         VALUES ($1, $2, $3::date, $3::date + 6, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 0 THEN now() END)
         ON CONFLICT (driver_id, period_start) DO NOTHING RETURNING *`,
        [g.tenant_id, g.driver_id, start, sum.n, sum.total, offset, amount, inv?.id ?? null, amount === 0 ? 'abatido' : 'open'], db,
      );
      if (!payout) return null;
      await query(
        `UPDATE rides SET cashback_payout_id = $1
          WHERE driver_id = $2 AND status = 'completed' AND (cashback_used_cents + club_discount_cents) > 0 AND cashback_payout_id IS NULL AND completed_at < $3::date + 7`,
        [payout.id, g.driver_id, start], db,
      );
      if (inv && offset > 0) {
        const left = inv.amount_cents - offset;
        await query(
          `UPDATE commission_invoices SET amount_cents = $2, cashback_offset_cents = cashback_offset_cents + $3,
                  status = CASE WHEN $2 = 0 THEN 'paid' ELSE status END,
                  paid_at = CASE WHEN $2 = 0 THEN now() ELSE paid_at END,
                  paid_by = CASE WHEN $2 = 0 THEN 'cashback' ELSE paid_by END
            WHERE id = $1`,
          [inv.id, left, offset], db,
        );
        // cobrança aberta no Mercado Pago com o valor antigo não vale mais
        await query(`UPDATE charges SET status = 'cancelled' WHERE commission_invoice_id = $1 AND status = 'pending'`, [inv.id], db);
      }
      return payout;
    });
    if (!p) continue;
    created.push(p);
    emitTo(`user:${p.driver_id}`, 'cashback:payout', { id: p.id });
    const body = p.offset_cents > 0 && p.amount_cents === 0
      ? `${brl(p.cashback_cents)} de cashback e descontos do Clube dos passageiros foram abatidos da sua comissão.`
      : p.offset_cents > 0
        ? `${brl(p.offset_cents)} abatidos da comissão e ${brl(p.amount_cents)} a central paga no seu Pix.`
        : `A central vai pagar ${brl(p.amount_cents)} no seu Pix pelo cashback e descontos do Clube dos passageiros.`;
    await pushTo(p.driver_id, { title: 'Cashback da semana', body, channelId: CHANNEL_UPDATES, data: { type: 'cashback' } }).catch(() => {});
  }
  return created;
}

/** O que a central deve ao motorista: semanas fechadas em aberto e corridas da semana atual */
export async function driverCashback(driverId: string) {
  const pending = await one<{ n: number; total: number }>(
    `SELECT count(*)::int AS n, coalesce(sum(cashback_used_cents + club_discount_cents), 0)::int AS total FROM rides
      WHERE driver_id = $1 AND status = 'completed' AND (cashback_used_cents + club_discount_cents) > 0 AND cashback_payout_id IS NULL`,
    [driverId],
  );
  const payouts = await query(
    `SELECT id, period_start, period_end, rides, cashback_cents, offset_cents, amount_cents, status, paid_at
       FROM cashback_payouts WHERE driver_id = $1 ORDER BY period_start DESC LIMIT 12`,
    [driverId],
  );
  return { pendingRides: pending?.n ?? 0, pendingCents: pending?.total ?? 0, payouts };
}

/** Rodada de hora em hora: vence créditos e devolve reservas esquecidas */
export async function runCashbackJobs() {
  const expired = await expireCashback();
  const released = await releaseCancelledCashback();
  // crédito de loja guardado no celular de quem não se cadastrou a tempo: venceu, o celular sai da base
  const dropped = await query(`DELETE FROM cashback_ledger WHERE user_id IS NULL AND expires_at <= now() RETURNING id`);
  return { expired: expired.length, released, droppedPhones: dropped.length };
}
