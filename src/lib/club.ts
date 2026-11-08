import { one, pool, query, type Db } from './db.js';
import { badRequest, notFound } from './errors.js';
import { CHANNEL_UPDATES, pushTo } from './push.js';

/**
 * Clube do passageiro: assinatura mensal, paga pelo app no Mercado Pago da cidade. Não renova sozinha:
 * o app avisa antes de vencer e o passageiro paga mais um mês quando quiser.
 * Benefícios (o licenciado liga cada um): desconto em cada corrida, sem tarifa dinâmica,
 * cashback multiplicado e prioridade no despacho. O motorista recebe o valor cheio da corrida.
 */
export const CLUB_DAYS = 30;

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
/** "hoje" no horário de Brasília */
export const TODAY_SQL = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

export interface ClubRules {
  enabled: boolean; name: string; priceCents: number; days: number;
  discountPct: number; discountMaxCents: number; noSurge: boolean; cashbackMultiplier: number; priority: boolean;
}

export function clubRulesOf(t: any): ClubRules {
  return {
    enabled: !!t.club_enabled, name: t.club_name, priceCents: t.club_price_cents, days: CLUB_DAYS,
    discountPct: Number(t.club_discount_pct), discountMaxCents: t.club_discount_max_cents,
    noSurge: !!t.club_no_surge, cashbackMultiplier: t.club_cashback_multiplier, priority: !!t.club_priority,
  };
}

/** Assinante com o Clube em dia (e o Clube ligado na cidade) */
export async function isClubMember(userId: string, db: Db = pool) {
  const r = await one<{ ok: boolean }>(
    `SELECT (t.club_enabled AND u.club_until >= ${TODAY_SQL}) AS ok FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
    [userId], db,
  );
  return !!r?.ok;
}

/**
 * Quanto o assinante deixa de pagar numa corrida: a dinâmica (se o Clube tira) mais o desconto,
 * calculado sobre o preço sem dinâmica e limitado pelo teto por corrida.
 */
export function clubDiscountFor(t: any, priceCents: number, baseCents: number) {
  if (!t.club_enabled) return { totalCents: 0, surgeWaivedCents: 0, discountCents: 0 };
  const surgeWaivedCents = t.club_no_surge ? Math.max(0, priceCents - baseCents) : 0;
  const over = t.club_no_surge ? baseCents : priceCents;
  const discountCents = Math.min(Math.floor((over * Number(t.club_discount_pct)) / 100), t.club_discount_max_cents);
  return { totalCents: surgeWaivedCents + discountCents, surgeWaivedCents, discountCents };
}

/** Soma dias ao Clube a partir do que vencer por último (ou de hoje) e registra o mês */
export async function extendClub(db: Db, tenantId: string, userId: string, days: number, amountCents: number,
  extra: { chargeId?: string; by?: string; note?: string } = {}) {
  const r = await one<{ club_until: string; period_start: string }>(
    `UPDATE users SET club_until = greatest(coalesce(club_until, ${TODAY_SQL} - 1), ${TODAY_SQL} - 1) + $2::int
      WHERE id = $1 AND tenant_id = $3
      RETURNING club_until::text, (club_until - $2::int + 1)::text AS period_start`,
    [userId, days, tenantId], db,
  );
  if (!r) throw notFound('Passageiro não encontrado');
  await query(
    `INSERT INTO club_payments (tenant_id, user_id, amount_cents, period_start, period_end, charge_id, registered_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, userId, amountCents, r.period_start, r.club_until, extra.chargeId ?? null, extra.by ?? null, extra.note ?? null], db,
  );
  return r.club_until;
}

/** Estorno do Mercado Pago: tira o mês pago */
export async function reverseClub(db: Db, userId: string, days: number, chargeId: string) {
  await query(`UPDATE users SET club_until = club_until - $2::int WHERE id = $1 AND club_until IS NOT NULL`, [userId, days], db);
  // o mês estornado sai da receita do Clube (a cobrança fica registrada como estornada)
  await query(`DELETE FROM club_payments WHERE charge_id = $1`, [chargeId], db);
}

/** Cartão do Clube no app: regras, se é assinante, até quando e quanto economizou */
export async function clubView(userId: string, tenantId: string, mpAvailable: boolean) {
  const t = await one(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
  const u = await one(
    `SELECT club_until::text AS until, (club_until >= ${TODAY_SQL}) AS active, (club_until - ${TODAY_SQL}) AS days_left
       FROM users WHERE id = $1`,
    [userId],
  );
  const saved = await one<{ month: number; total: number }>(
    `SELECT coalesce(sum(club_discount_cents) FILTER (WHERE completed_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'), 0)::int AS month,
            coalesce(sum(club_discount_cents), 0)::int AS total
       FROM rides WHERE passenger_id = $1 AND status = 'completed' AND club_member`,
    [userId],
  );
  return {
    rules: clubRulesOf(t),
    member: !!t.club_enabled && !!u?.active,
    until: u?.until ?? null,
    daysLeft: u?.active ? Number(u.days_left) : null,
    savedMonthCents: saved?.month ?? 0,
    savedTotalCents: saved?.total ?? 0,
    available: mpAvailable,
  };
}

/** Avisa o assinante 3 dias antes, no dia e no dia seguinte ao vencimento (o Clube não renova sozinho) */
export async function sendClubReminders() {
  const rows = await query<{ id: string; due: string; days_left: number; price: number; name: string }>(
    `SELECT u.id, u.club_until::text AS due, (u.club_until - ${TODAY_SQL}) AS days_left, t.club_price_cents AS price, t.club_name AS name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE t.active AND t.club_enabled AND u.role = 'passenger' AND u.deleted_at IS NULL AND NOT u.blocked
        AND u.club_until IS NOT NULL AND (u.club_until - ${TODAY_SQL}) IN (3, 0, -1)
        AND NOT EXISTS (SELECT 1 FROM billing_reminders b WHERE b.user_id = u.id AND b.kind = 'clube-' || (u.club_until - ${TODAY_SQL})
                        AND b.ref_date = u.club_until)`,
  );
  for (const r of rows) {
    await query(`INSERT INTO billing_reminders (user_id, kind, ref_date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [r.id, `clube-${r.days_left}`, r.due]);
    const body = r.days_left > 0 ? `Seu ${r.name} vence em ${r.days_left} dias. Renove por ${brl(r.price)} pelo app para não perder os descontos.`
      : r.days_left === 0 ? `Seu ${r.name} vence hoje. Renove por ${brl(r.price)} pelo app.`
      : `Seu ${r.name} venceu. Renove quando quiser para voltar a ter os descontos.`;
    await pushTo(r.id, { title: r.days_left < 0 ? `${r.name} vencido` : `Renove o ${r.name}`, body, channelId: CHANNEL_UPDATES, data: { type: 'club' } })
      .catch(() => {});
  }
  return rows.length;
}

/** A central dá meses de cortesia (ou registra um pagamento feito por fora) */
export async function grantClub(tenantId: string, phone: string, months: number, amountCents: number, note: string, by: string, db: Db = pool) {
  const u = await one(
    `SELECT id, name FROM users WHERE tenant_id = $1 AND phone = $2 AND role = 'passenger' AND deleted_at IS NULL`, [tenantId, phone], db,
  );
  if (!u) throw notFound('Nenhum passageiro com este celular');
  if (months < 1) throw badRequest('Informe pelo menos 1 mês');
  const until = await extendClub(db, tenantId, u.id, CLUB_DAYS * months, amountCents, { by, note });
  return { userId: u.id as string, name: u.name as string, until };
}
