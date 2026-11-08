import { config } from './config.js';
import { one, pool, query, tx, type Db } from './db.js';
import { decrypt } from './crypto.js';
import { badRequest, HttpError, notFound } from './errors.js';
import { isPublicHttps, mp, type MpPayment } from './mercadopago.js';
import { CHANNEL_UPDATES, pushTo } from './push.js';
import { emitTo } from './realtime.js';
import { applyStorePayment, autoConfirmCod, generateStoreInvoices, reverseStorePayment } from './stores.js';
import { generateCommissionInvoices } from './commissions.js';
import { generateCashbackPayouts, runCashbackJobs } from './cashback.js';
import { CLUB_DAYS, extendClub, reverseClub, sendClubReminders } from './club.js';
import { ESCOLA_DAYS, extendSchoolContract, reverseSchoolPayment, runSchoolJobs } from './escola.js';

/**
 * Cobranças pelo Mercado Pago (Checkout Pro).
 *  • mensalidade do motorista → paga na conta do LICENCIADO (cada cidade conecta a sua)
 *  • fatura mensal do licenciado → paga na conta da PLATAFORMA (MP_ACCESS_TOKEN)
 * Cada tentativa de pagamento é uma linha em `charges`; o id dela vai como external_reference.
 * O pagamento só vale depois de conferido direto na API do Mercado Pago (nunca pelo que o
 * navegador ou a notificação dizem), e é aplicado uma única vez.
 */

export const PLATFORM = 'plataforma';
const CHARGE_TTL_HOURS = 48;

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

export class MercadoPagoUnavailable extends HttpError {
  constructor(msg: string) { super(503, msg, 'mercadopago_indisponivel'); }
}

// ---------- contas ----------

export async function tenantMpToken(tenantId: string, db: Db = pool) {
  const t = await one<{ mp_access_token_enc: string | null; mp_webhook_secret_enc: string | null; slug: string }>(
    'SELECT slug, mp_access_token_enc, mp_webhook_secret_enc FROM tenants WHERE id = $1', [tenantId], db,
  );
  if (!t?.mp_access_token_enc) return null;
  return {
    slug: t.slug,
    token: decrypt(t.mp_access_token_enc),
    webhookSecret: t.mp_webhook_secret_enc ? decrypt(t.mp_webhook_secret_enc) : '',
  };
}

/** Token da conta que recebe a cobrança: licenciado (mensalidade) ou plataforma (fatura) */
async function tokenForCharge(c: { kind: string; tenant_id: string }) {
  if (c.kind === 'fatura') return config.mpAccessToken || null;
  return (await tenantMpToken(c.tenant_id))?.token ?? null;
}

export const webhookUrl = (account: string) =>
  account === PLATFORM ? `${config.publicApiUrl}/webhooks/mercadopago/plataforma` : `${config.publicApiUrl}/webhooks/mercadopago/t/${account}`;

type ChargeKind = 'mensalidade' | 'fatura' | 'recarga' | 'fatura_loja' | 'comissao' | 'clube' | 'escola';
const returnUrl = (kind: ChargeKind) =>
  `${config.publicApiUrl}/pagamento/retorno?k=${kind === 'recarga' || kind === 'fatura_loja' ? 'loja' : kind}`;

// ---------- motorista: estender o plano ----------

/** Soma dias ao plano: conta a partir do que vencer por último (pago, teste grátis ou hoje) */
export async function extendDriverPlan(db: Db, driverId: string, planCode: string, days: number, amountCents: number, registeredBy: string | null) {
  const r = await one<{ paid_until: string; period_start: string }>(
    `UPDATE drivers SET paid_until = greatest(coalesce(paid_until, current_date - 1), coalesce(trial_until, current_date - 1), current_date - 1) + $2::int
      WHERE user_id = $1
      RETURNING paid_until, (paid_until - $2::int + 1) AS period_start`,
    [driverId, days], db,
  );
  if (!r) throw notFound('Motorista não encontrado');
  await query(
    `INSERT INTO subscription_payments (driver_id, plan_code, amount_cents, period_start, period_end, registered_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [driverId, planCode, amountCents, r.period_start, r.paid_until, registeredBy], db,
  );
  return r;
}

// ---------- criar cobranças ----------

export async function createPreferenceFor(chargeId: string, token: string, p: {
  title: string; itemId: string; amountCents: number; account: string; kind: ChargeKind;
}) {
  const backUrl = returnUrl(p.kind);
  try {
    const pref = await mp().createPreference(token, {
      title: p.title,
      itemId: p.itemId,
      amountCents: p.amountCents,
      externalReference: chargeId,
      notificationUrl: webhookUrl(p.account),
      backUrl,
      autoReturn: isPublicHttps(backUrl),
      expiresInHours: CHARGE_TTL_HOURS,
      statementDescriptor: 'ONDAQUI',
    }, chargeId);
    await query(`UPDATE charges SET mp_preference_id = $2, init_point = $3 WHERE id = $1`, [chargeId, pref.id, pref.init_point]);
    return pref.init_point;
  } catch (e) {
    await query(`UPDATE charges SET status = 'cancelled' WHERE id = $1`, [chargeId]);
    throw new MercadoPagoUnavailable(`Não foi possível abrir o pagamento no Mercado Pago: ${(e as Error).message}`);
  }
}

export async function createDriverCharge(driverId: string, tenantId: string, periods: number) {
  const d = await one(
    `SELECT d.plan_code, p.name AS plan_name, p.price_cents, p.period_days, t.slug, t.name AS tenant_name
       FROM drivers d JOIN users u ON u.id = d.user_id
       JOIN tenants t ON t.id = u.tenant_id
       JOIN driver_plans p ON p.tenant_id = t.id AND p.code = d.plan_code
      WHERE d.user_id = $1 AND u.tenant_id = $2`,
    [driverId, tenantId],
  );
  if (!d) throw notFound('Motorista não encontrado');
  if (d.period_days === 0 || d.price_cents <= 0) throw badRequest('Seu plano não tem mensalidade', 'plano_sem_mensalidade');
  const acc = await tenantMpToken(tenantId);
  if (!acc) throw badRequest('O pagamento pelo app ainda não está disponível nesta cidade. Fale com o licenciado.', 'mercadopago_nao_configurado');

  const amount = d.price_cents * periods;
  const title = `${d.tenant_name} — plano ${d.plan_name}${periods > 1 ? ` (${periods} períodos)` : ''}`;
  const c = await one<{ id: string }>(
    `INSERT INTO charges (kind, tenant_id, driver_id, plan_code, periods, amount_cents, description)
     VALUES ('mensalidade',$1,$2,$3,$4,$5,$6) RETURNING id`,
    [tenantId, driverId, d.plan_code, periods, amount, title],
  );
  const initPoint = await createPreferenceFor(c!.id, acc.token, {
    title, itemId: `plano-${d.plan_code}`, amountCents: amount, account: acc.slug, kind: 'mensalidade',
  });
  return { chargeId: c!.id, init_point: initPoint, amountCents: amount };
}

/** Passageiro assina (ou renova) o Clube por 30 dias, pago no Mercado Pago da cidade */
export async function createClubCharge(userId: string, tenantId: string) {
  const t = await one(`SELECT name, club_enabled, club_name, club_price_cents FROM tenants WHERE id = $1`, [tenantId]);
  if (!t?.club_enabled) throw badRequest('O clube ainda não está disponível nesta cidade', 'clube_desligado');
  const acc = await tenantMpToken(tenantId);
  if (!acc) throw badRequest('O pagamento pelo app ainda não está disponível nesta cidade. Fale com a central.', 'mercadopago_nao_configurado');
  const title = `${t.name} — ${t.club_name} (${CLUB_DAYS} dias)`;
  const c = await one<{ id: string }>(
    `INSERT INTO charges (kind, tenant_id, passenger_id, amount_cents, description) VALUES ('clube',$1,$2,$3,$4) RETURNING id`,
    [tenantId, userId, t.club_price_cents, title],
  );
  const initPoint = await createPreferenceFor(c!.id, acc.token, {
    title, itemId: 'clube', amountCents: t.club_price_cents, account: acc.slug, kind: 'clube',
  });
  return { chargeId: c!.id, init_point: initPoint, amountCents: t.club_price_cents as number };
}

/** Pais pagam a mensalidade do transporte escolar pelo Mercado Pago da cidade */
export async function createSchoolCharge(contractId: string, parentId: string, tenantId: string) {
  const c = await one(
    `SELECT c.*, t.name AS tenant_name FROM school_contracts c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.id = $1 AND c.parent_id = $2 AND c.tenant_id = $3`,
    [contractId, parentId, tenantId],
  );
  if (!c) throw notFound('Contrato não encontrado');
  if (c.status !== 'ativo' && c.status !== 'pausado') throw badRequest('A central ainda não confirmou o motorista deste transporte', 'escola_nao_ativo');
  const acc = await tenantMpToken(tenantId);
  if (!acc) throw badRequest('O pagamento pelo app ainda não está disponível nesta cidade. Pague na central.', 'mercadopago_nao_configurado');
  const title = `${c.tenant_name} — transporte escolar de ${String(c.student_name).split(/\s+/)[0]} (${ESCOLA_DAYS} dias)`;
  const ch = await one<{ id: string }>(
    `INSERT INTO charges (kind, tenant_id, passenger_id, school_contract_id, amount_cents, description) VALUES ('escola',$1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, parentId, contractId, c.monthly_cents, title],
  );
  const initPoint = await createPreferenceFor(ch!.id, acc.token, { title, itemId: 'escola', amountCents: c.monthly_cents, account: acc.slug, kind: 'escola' });
  return { chargeId: ch!.id, init_point: initPoint, amountCents: c.monthly_cents as number };
}

/** Motorista paga a fatura de comissão da semana pelo Mercado Pago da cidade */
export async function createCommissionCharge(invoiceId: string, driverId: string, tenantId: string) {
  const inv = await one(
    `SELECT i.*, t.name AS tenant_name FROM commission_invoices i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.id = $1 AND i.driver_id = $2 AND i.tenant_id = $3`,
    [invoiceId, driverId, tenantId],
  );
  if (!inv) throw notFound('Fatura de comissão não encontrada');
  if (inv.status !== 'open') throw badRequest('Esta fatura já foi paga ou cancelada', 'fatura_fechada');
  const acc = await tenantMpToken(tenantId);
  if (!acc) throw badRequest('O pagamento pelo app ainda não está disponível nesta cidade. Pague na central.', 'mercadopago_nao_configurado');
  const fmt = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
  const title = `${inv.tenant_name} — comissão de ${fmt(inv.period_start)} a ${fmt(inv.period_end)}`;
  const c = await one<{ id: string }>(
    `INSERT INTO charges (kind, tenant_id, driver_id, commission_invoice_id, amount_cents, description)
     VALUES ('comissao', $1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, driverId, inv.id, inv.amount_cents, title],
  );
  const initPoint = await createPreferenceFor(c!.id, acc.token, {
    title, itemId: `comissao-${inv.id}`, amountCents: inv.amount_cents, account: acc.slug, kind: 'comissao',
  });
  return { chargeId: c!.id, init_point: initPoint, amountCents: inv.amount_cents };
}

export async function createInvoiceCharge(invoiceId: string, tenantId: string) {
  const inv = await one(
    `SELECT i.*, t.name AS tenant_name FROM invoices i JOIN tenants t ON t.id = i.tenant_id
      WHERE i.id = $1 AND i.tenant_id = $2`,
    [invoiceId, tenantId],
  );
  if (!inv) throw notFound('Fatura não encontrada');
  if (inv.status !== 'open') throw badRequest('Esta fatura não está em aberto', 'fatura_fechada');
  if (!config.mpAccessToken) throw badRequest('Pagamento online das faturas ainda não está ativo. Fale com a OnDaqui.', 'mercadopago_nao_configurado');

  const title = `OnDaqui — fatura ${monthLabel(inv.period)} (${inv.tenant_name})`;
  const c = await one<{ id: string }>(
    `INSERT INTO charges (kind, tenant_id, invoice_id, amount_cents, description)
     VALUES ('fatura',$1,$2,$3,$4) RETURNING id`,
    [tenantId, invoiceId, inv.total_cents, title],
  );
  const initPoint = await createPreferenceFor(c!.id, config.mpAccessToken, {
    title, itemId: `fatura-${String(inv.period).slice(0, 7)}`, amountCents: inv.total_cents, account: PLATFORM, kind: 'fatura',
  });
  return { chargeId: c!.id, init_point: initPoint, amountCents: inv.total_cents };
}

// ---------- aplicar pagamentos (webhook, retorno e conferência manual) ----------

type ApplyResult = 'aplicado' | 'ja_aplicado' | 'pendente' | 'recusado' | 'estornado' | 'ignorado' | 'divergente';

const FAILED = new Set(['rejected', 'cancelled']);
const REVERSED = new Set(['refunded', 'charged_back']);

/**
 * Aplica um pagamento já buscado na API do Mercado Pago com o token da conta `account`.
 * Confere: a cobrança existe, pertence à conta que recebeu, valor e moeda batem.
 */
export async function applyPayment(account: string, p: MpPayment): Promise<ApplyResult> {
  if (!p.external_reference || !/^[0-9a-f-]{36}$/i.test(p.external_reference)) return 'ignorado';
  const charge = await one(
    `SELECT c.*, t.slug FROM charges c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`, [p.external_reference],
  );
  if (!charge) return 'ignorado';
  const expectedAccount = charge.kind === 'fatura' ? PLATFORM : charge.slug;
  if (account !== expectedAccount) return 'divergente';
  if (p.currency_id !== 'BRL' || Math.round(p.transaction_amount * 100) !== charge.amount_cents) return 'divergente';

  if (p.status === 'approved') return approveCharge(charge, p.id);
  if (REVERSED.has(p.status)) return reverseCharge(charge, p.id);
  if (FAILED.has(p.status)) {
    await query(`UPDATE charges SET status = 'rejected' WHERE id = $1 AND status = 'pending'`, [charge.id]);
    return 'recusado';
  }
  return 'pendente'; // pending, in_process, authorized...
}

async function approveCharge(charge: any, paymentId: string): Promise<ApplyResult> {
  const applied = await tx(async (db) => {
    // a linha da cobrança fica travada: duas notificações ao mesmo tempo não aplicam duas vezes
    const c = await one(
      `UPDATE charges SET status = 'approved', mp_payment_id = $2, paid_at = now()
        WHERE id = $1 AND status IN ('pending', 'rejected', 'expired', 'cancelled') RETURNING *`,
      [charge.id, paymentId], db,
    );
    if (!c) return null;
    if (c.kind === 'recarga' || c.kind === 'fatura_loja') {
      await applyStorePayment(db, c);
      return { kind: 'loja' as const, c };
    }
    if (c.kind === 'mensalidade') {
      const plan = await one(`SELECT period_days FROM driver_plans WHERE tenant_id = $1 AND code = $2`, [c.tenant_id, c.plan_code], db);
      const r = await extendDriverPlan(db, c.driver_id, c.plan_code, (plan?.period_days ?? 30) * c.periods, c.amount_cents, null);
      return { kind: 'mensalidade' as const, c, paidUntil: r.paid_until };
    }
    if (c.kind === 'comissao') {
      await query(
        `UPDATE commission_invoices SET status = 'paid', paid_at = now(), paid_by = 'mercadopago' WHERE id = $1 AND status = 'open'`,
        [c.commission_invoice_id], db,
      );
      return { kind: 'comissao' as const, c };
    }
    if (c.kind === 'clube') {
      const until = await extendClub(db, c.tenant_id, c.passenger_id, CLUB_DAYS * c.periods, c.amount_cents, { chargeId: c.id });
      return { kind: 'clube' as const, c, until };
    }
    if (c.kind === 'escola') {
      const until = await extendSchoolContract(db, c.school_contract_id, 1, c.amount_cents, { chargeId: c.id });
      return { kind: 'escola' as const, c, until };
    }
    await query(
      `UPDATE invoices SET status = 'paid', paid_at = now(), paid_by = 'mercadopago' WHERE id = $1 AND status = 'open'`,
      [c.invoice_id], db,
    );
    const reactivated = await reactivateIfPaidUp(c.tenant_id, db);
    return { kind: 'fatura' as const, c, reactivated };
  });
  if (!applied) return 'ja_aplicado';

  if (applied.kind === 'mensalidade') {
    const until = new Date(`${applied.paidUntil}T12:00:00`).toLocaleDateString('pt-BR');
    emitTo(`user:${applied.c.driver_id}`, 'subscription:paid', { paidUntil: applied.paidUntil });
    emitTo(`admin:${applied.c.tenant_id}`, 'driver:payment', { driverId: applied.c.driver_id, amountCents: applied.c.amount_cents });
    await pushTo(applied.c.driver_id, {
      title: 'Pagamento confirmado ✅', body: `Seu plano está em dia até ${until}. Boas corridas!`,
      channelId: CHANNEL_UPDATES, data: { type: 'subscription_paid' },
    });
  } else if (applied.kind === 'comissao') {
    emitTo(`user:${applied.c.driver_id}`, 'commission:paid', { id: applied.c.commission_invoice_id });
    emitTo(`admin:${applied.c.tenant_id}`, 'driver:payment', { driverId: applied.c.driver_id, amountCents: applied.c.amount_cents });
    await pushTo(applied.c.driver_id, {
      title: 'Comissão paga ✅', body: 'Pagamento confirmado. Você já pode receber corridas.',
      channelId: CHANNEL_UPDATES, data: { type: 'commission_paid' },
    });
  } else if (applied.kind === 'clube') {
    const until = new Date(`${applied.until}T12:00:00`).toLocaleDateString('pt-BR');
    emitTo(`user:${applied.c.passenger_id}`, 'club:paid', { until: applied.until });
    await pushTo(applied.c.passenger_id, {
      title: 'Bem-vindo ao Clube ✅', body: `Pagamento confirmado. Seus benefícios valem até ${until}.`,
      channelId: CHANNEL_UPDATES, data: { type: 'club' },
    });
  } else if (applied.kind === 'escola') {
    const until = applied.until ? new Date(`${applied.until}T12:00:00`).toLocaleDateString('pt-BR') : '';
    emitTo(`user:${applied.c.passenger_id}`, 'escola:paid', { contractId: applied.c.school_contract_id, until: applied.until });
    emitTo(`admin:${applied.c.tenant_id}`, 'escola:paid', { contractId: applied.c.school_contract_id });
    await pushTo(applied.c.passenger_id, {
      title: 'Mensalidade paga ✅', body: `Transporte escolar em dia até ${until}.`, channelId: CHANNEL_UPDATES, data: { type: 'escola' },
    });
  } else if (applied.kind === 'fatura') {
    emitTo(`admin:${applied.c.tenant_id}`, 'invoice:paid', { invoiceId: applied.c.invoice_id, reactivated: applied.reactivated });
  }
  return 'aplicado';
}

async function reverseCharge(charge: any, paymentId: string): Promise<ApplyResult> {
  await tx(async (db) => {
    const c = await one(
      `UPDATE charges SET status = 'refunded' WHERE id = $1 AND status = 'approved' AND mp_payment_id = $2 RETURNING *`,
      [charge.id, paymentId], db,
    );
    if (!c) return;
    if (c.kind === 'recarga' || c.kind === 'fatura_loja') {
      await reverseStorePayment(db, c);
    } else if (c.kind === 'mensalidade') {
      const plan = await one(`SELECT period_days FROM driver_plans WHERE tenant_id = $1 AND code = $2`, [c.tenant_id, c.plan_code], db);
      await query(`UPDATE drivers SET paid_until = paid_until - $2::int WHERE user_id = $1 AND paid_until IS NOT NULL`,
        [c.driver_id, (plan?.period_days ?? 30) * c.periods], db);
    } else if (c.kind === 'comissao') {
      await query(`UPDATE commission_invoices SET status = 'open', paid_at = NULL, paid_by = NULL WHERE id = $1 AND paid_by = 'mercadopago'`,
        [c.commission_invoice_id], db);
    } else if (c.kind === 'clube') {
      await reverseClub(db, c.passenger_id, CLUB_DAYS * c.periods, c.id);
    } else if (c.kind === 'escola') {
      await reverseSchoolPayment(db, c.school_contract_id, c.id);
    } else {
      await query(`UPDATE invoices SET status = 'open', paid_at = NULL, paid_by = NULL WHERE id = $1 AND paid_by = 'mercadopago'`, [c.invoice_id], db);
    }
  });
  return 'estornado';
}

/** Licenciado suspenso por atraso volta a funcionar quando não sobra fatura vencida além do prazo */
export async function reactivateIfPaidUp(tenantId: string, db: Db = pool) {
  const r = await one(
    `UPDATE tenants SET active = true, suspended_reason = NULL
      WHERE id = $1 AND active = false AND suspended_reason = 'inadimplencia'
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = $1 AND i.status = 'open'
                        AND $2 > 0 AND i.due_date < current_date - $2::int)
      RETURNING id`,
    [tenantId, config.suspendAfterDays], db,
  );
  return !!r;
}

/** Busca no Mercado Pago os pagamentos de uma cobrança (quando a notificação não chega) */
export async function syncCharge(chargeId: string) {
  const c = await one(`SELECT c.*, t.slug FROM charges c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`, [chargeId]);
  if (!c) return 'ignorado' as ApplyResult;
  const token = await tokenForCharge(c);
  if (!token) return 'ignorado' as ApplyResult;
  const account = c.kind === 'fatura' ? PLATFORM : c.slug;
  const payments = await mp().findPaymentsByReference(token, chargeId);
  let best: ApplyResult = 'pendente';
  // aprovado tem prioridade; depois estorno; depois recusa
  const order = (s: string) => (s === 'approved' ? 0 : REVERSED.has(s) ? 1 : FAILED.has(s) ? 3 : 2);
  for (const p of payments.sort((a, b) => order(a.status) - order(b.status))) {
    if (p.external_reference !== chargeId) continue;
    best = await applyPayment(account, p);
    break;
  }
  return best;
}

/** Notificação do Mercado Pago: busca o pagamento com o token da conta e aplica */
export async function handlePaymentNotification(account: string, paymentId: string) {
  const token = account === PLATFORM
    ? config.mpAccessToken
    : (await one<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [account]).then((t) => (t ? tenantMpToken(t.id) : null)))?.token;
  if (!token) return 'sem_conta';
  const payment = await mp().getPayment(token, paymentId);
  return applyPayment(account, payment);
}

// ---------- faturas dos licenciados ----------

export const monthLabel = (period: string) => {
  const d = new Date(`${String(period).slice(0, 10)}T12:00:00`);
  const s = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); // "outubro de 2026"
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Valores de um mês para um licenciado (licença proporcional aos dias desde o cadastro + taxa por corrida) */
export async function invoiceAmounts(tenantId: string, period: string, db: Db = pool) {
  const r = await one(
    `WITH m AS (SELECT $2::date AS start, ($2::date + interval '1 month')::date AS stop)
     SELECT t.license_monthly_cents,
            (m.stop - m.start) AS days_in_month,
            greatest(0, m.stop - greatest(m.start, t.created_at::date)) AS days_active,
            (SELECT count(*) FROM rides r WHERE r.tenant_id = t.id AND r.status = 'completed'
               AND r.completed_at >= m.start AND r.completed_at < m.stop)::int AS rides_count,
            (SELECT coalesce(sum(r.license_fee_cents), 0) FROM rides r WHERE r.tenant_id = t.id AND r.status = 'completed'
               AND r.completed_at >= m.start AND r.completed_at < m.stop)::int AS ride_fee_cents
       FROM tenants t, m WHERE t.id = $1`,
    [tenantId, period], db,
  );
  if (!r) throw notFound('Licenciado não encontrado');
  const license = Math.round((r.license_monthly_cents * r.days_active) / r.days_in_month);
  return { licenseCents: license, ridesCount: r.rides_count, rideFeeCents: r.ride_fee_cents, totalCents: license + r.ride_fee_cents };
}

/** Gera as faturas do mês anterior (ou do mês informado, 'AAAA-MM-01'). Pode rodar várias vezes: não duplica. */
export async function generateInvoices(period?: string) {
  const p = period ?? (await one<{ p: string }>(`SELECT (date_trunc('month', now()) - interval '1 month')::date AS p`))!.p;
  const tenants = await query<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM tenants t
      WHERE t.created_at < ($1::date + interval '1 month')
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = t.id AND i.period = $1::date)`,
    [p],
  );
  const created = [];
  for (const t of tenants) {
    const a = await invoiceAmounts(t.id, p);
    if (a.totalCents <= 0) continue;
    const inv = await one(
      `INSERT INTO invoices (tenant_id, period, license_cents, rides_count, ride_fee_cents, total_cents, due_date)
       VALUES ($1, $2::date, $3, $4, $5, $6, ($2::date + interval '1 month')::date + ($7::int - 1))
       ON CONFLICT (tenant_id, period) DO NOTHING RETURNING *`,
      [t.id, p, a.licenseCents, a.ridesCount, a.rideFeeCents, a.totalCents, Math.min(Math.max(config.invoiceDueDay, 1), 28)],
    );
    if (!inv) continue;
    created.push(inv);
    emitTo(`admin:${t.id}`, 'invoice:new', { invoiceId: inv.id });
  }
  return created;
}

/** Suspende licenciados com fatura vencida há mais de BILLING_SUSPEND_AFTER_DAYS dias */
export async function suspendOverdueTenants() {
  if (config.suspendAfterDays <= 0) return [];
  const rows = await query<{ id: string }>(
    `UPDATE tenants t SET active = false, suspended_reason = 'inadimplencia'
      WHERE t.active AND EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'open'
                                 AND i.due_date < current_date - $1::int)
      RETURNING t.id`,
    [config.suspendAfterDays],
  );
  for (const t of rows) {
    await query(`UPDATE drivers SET online = false WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [t.id]);
  }
  return rows.map((r) => r.id);
}

// ---------- lembretes e limpeza ----------

/** Avisa o motorista 3 dias antes, 1 dia antes, no dia e no dia seguinte ao vencimento */
export async function sendDriverReminders() {
  const rows = await query<{ user_id: string; due: string; days_left: number; price_cents: number; plan_name: string }>(
    `SELECT d.user_id, s.due, (s.due - current_date) AS days_left, p.price_cents, p.name AS plan_name
       FROM drivers d JOIN users u ON u.id = d.user_id
       JOIN tenants t ON t.id = u.tenant_id
       JOIN driver_plans p ON p.tenant_id = t.id AND p.code = d.plan_code
       CROSS JOIN LATERAL (SELECT greatest(d.paid_until, d.trial_until) AS due) s
      WHERE t.active AND d.status = 'approved' AND NOT u.blocked AND p.period_days > 0 AND p.price_cents > 0
        AND s.due IS NOT NULL AND (s.due - current_date) IN (3, 1, 0, -1)
        AND NOT EXISTS (SELECT 1 FROM billing_reminders b WHERE b.user_id = d.user_id AND b.kind = 'plano-' || (s.due - current_date)
                        AND b.ref_date = s.due)`,
  );
  for (const r of rows) {
    const body = r.days_left > 1 ? `Seu plano ${r.plan_name} vence em ${r.days_left} dias. Renove por ${brl(r.price_cents)} pelo app, com Pix ou cartão.`
      : r.days_left === 1 ? `Seu plano ${r.plan_name} vence amanhã. Renove agora para não ficar sem corridas.`
      : r.days_left === 0 ? `Seu plano ${r.plan_name} vence hoje. Renove pelo app em menos de um minuto.`
      : `Seu plano venceu e você não está recebendo corridas. Toque para renovar.`;
    await query(
      `INSERT INTO billing_reminders (user_id, kind, ref_date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [r.user_id, `plano-${r.days_left}`, r.due],
    );
    await pushTo(r.user_id, {
      title: r.days_left < 0 ? 'Plano vencido' : 'Renove seu plano', body,
      channelId: CHANNEL_UPDATES, data: { type: 'subscription_due' },
    });
  }
  return rows.length;
}

/** Links de pagamento abertos há mais de 48 h deixam de valer (o Mercado Pago também expira a preferência) */
export async function expireStaleCharges() {
  const r = await query(
    `UPDATE charges SET status = 'expired' WHERE status = 'pending' AND created_at < now() - make_interval(hours => $1) RETURNING id`,
    [CHARGE_TTL_HOURS],
  );
  return r.length;
}

/** Rodada de cobrança: chamada a cada hora pelo servidor */
export async function runBillingJobs() {
  const day = (await one<{ d: number }>(`SELECT extract(day FROM now())::int AS d`))!.d;
  const invoices = day <= 5 ? await generateInvoices() : []; // gera nos primeiros dias do mês (repete sem duplicar)
  const suspended = await suspendOverdueTenants();
  const reminders = await sendDriverReminders() + await sendClubReminders();
  const expired = await expireStaleCharges();
  const storeInvoices = await generateStoreInvoices(); // fatura semanal das lojas (fecha a semana anterior, sem duplicar)
  const commissions = await generateCommissionInvoices(); // comissão do plano Livre da semana anterior
  // cashback usado nas corridas: abate da comissão da mesma semana, o resto a central paga ao motorista
  const payouts = await generateCashbackPayouts();
  const codConfirmed = await autoConfirmCod(); // produto cobrado na entrega que a loja não conferiu em 24 h
  const cashback = await runCashbackJobs(); // vence créditos e devolve o que ficou reservado em corridas canceladas
  const school = await runSchoolJobs(); // viagens escolares do dia e avisos de mensalidade
  return {
    invoices: invoices.length + storeInvoices.length, suspended: suspended.length, reminders, expired, commissions: commissions.length,
    codConfirmed, cashbackPayouts: payouts.length, cashbackExpired: cashback.expired, schoolTrips: school.trips,
  };
}
