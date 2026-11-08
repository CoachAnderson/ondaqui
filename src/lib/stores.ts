import { config } from './config.js';
import { one, pool, query, tx, type Db } from './db.js';
import { badRequest, HttpError, notFound } from './errors.js';
import { decrypt } from './crypto.js';
import { createPreferenceFor, tenantMpToken } from './billing.js';
import { mp } from './mercadopago.js';
import { emitTo } from './realtime.js';

/**
 * Daqui Entrega para lojas.
 *  • Frete: créditos pré-pagos (recarga pelo Mercado Pago) ou fatura semanal (lojas liberadas pela central).
 *    O dinheiro do frete vai para a conta Mercado Pago do LICENCIADO, que repassa ao motoboy.
 *  • Produto: quem recebe paga direto para a LOJA na entrega (Pix da loja ou maquininha).
 *    O motoboy nunca carrega o dinheiro do produto.
 */

export class StoreBlocked extends HttpError {
  constructor(msg: string, code: string) { super(402, msg, code); }
}

/** Dias para pagar a fatura semanal depois que ela fecha */
const STORE_INVOICE_DAYS = 3;
/** Pix na chave ou maquininha: a loja tem este prazo para conferir; depois conta como recebido */
export const COD_CONFIRM_HOURS = config.codConfirmHours;

export async function addLedger(db: Db, accountId: string, kind: string, amount: number,
  extra: { rideId?: string; chargeId?: string; note?: string; by?: string | null; foodOrderId?: string; shiftId?: string } = {}) {
  const a = await one<{ balance_cents: number }>(
    `UPDATE accounts SET balance_cents = balance_cents + $2 WHERE id = $1 RETURNING balance_cents`, [accountId, amount], db,
  );
  await query(
    `INSERT INTO account_ledger (account_id, kind, amount_cents, balance_after, ride_id, charge_id, note, created_by, food_order_id, shift_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [accountId, kind, amount, a!.balance_cents, extra.rideId ?? null, extra.chargeId ?? null, extra.note ?? null, extra.by ?? null,
     extra.foodOrderId ?? null, extra.shiftId ?? null], db,
  );
  return a!.balance_cents;
}

/** Confere se a loja pode pedir uma entrega deste valor (trava a conta até o fim da transação) */
export async function reserveDelivery(db: Db, accountId: string, priceCents: number) {
  const a = await one(`SELECT * FROM accounts WHERE id = $1 FOR UPDATE`, [accountId], db);
  if (!a?.active) throw badRequest('Conta da loja desativada. Fale com a central.', 'conta_inativa');
  if (a.billing_mode === 'prepago') {
    if (a.balance_cents < priceCents) {
      throw new StoreBlocked(`Saldo insuficiente: faltam R$ ${((priceCents - a.balance_cents) / 100).toFixed(2).replace('.', ',')}. Recarregue os créditos.`, 'saldo_insuficiente');
    }
  } else {
    const overdue = await one(`SELECT 1 FROM store_invoices WHERE account_id = $1 AND status = 'open' AND due_date < current_date`, [accountId], db);
    if (overdue) throw new StoreBlocked('Há uma fatura vencida. Pague a fatura para voltar a pedir entregas.', 'fatura_vencida');
    if (a.balance_cents - priceCents < -a.credit_limit_cents) {
      throw new StoreBlocked('Limite de entregas em aberto atingido. Pague a fatura ou fale com a central.', 'limite_atingido');
    }
  }
}

export const debitDelivery = (db: Db, accountId: string, rideId: string, priceCents: number, by: string | null) =>
  addLedger(db, accountId, 'entrega', -priceCents, { rideId, by });

/**
 * Cashback que a loja dá ao cliente pelo pedido entregue. Sai do saldo (pré-pago) ou entra na fatura da semana.
 * Pré-pago sem saldo: não dá (a loja não fica negativa). Devolve false quando não debitou.
 */
export async function debitStoreCashback(db: Db, accountId: string, rideId: string, amountCents: number) {
  const a = await one(`SELECT billing_mode, balance_cents, credit_limit_cents, active FROM accounts WHERE id = $1 FOR UPDATE`, [accountId], db);
  if (!a?.active) return false;
  if (a.billing_mode === 'prepago' ? a.balance_cents < amountCents : a.balance_cents - amountCents < -a.credit_limit_cents) return false;
  await addLedger(db, accountId, 'cashback', -amountCents, { rideId, note: 'cashback para o cliente' });
  return true;
}

/** Entrega cancelada antes da coleta: o frete volta para a loja (uma vez só) */
export async function refundDelivery(rideId: string) {
  return tx(async (db) => {
    const debit = await one(`SELECT account_id, amount_cents FROM account_ledger WHERE ride_id = $1 AND kind = 'entrega'`, [rideId], db);
    if (!debit) return false;
    const done = await one(`SELECT 1 FROM account_ledger WHERE ride_id = $1 AND kind = 'estorno'`, [rideId], db);
    if (done) return false;
    await one(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [debit.account_id], db);
    await addLedger(db, debit.account_id, 'estorno', -debit.amount_cents, { rideId, note: 'entrega cancelada' });
    return true;
  });
}

export async function adjustBalance(accountId: string, amountCents: number, note: string, by: string) {
  return tx(async (db) => {
    await one(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [accountId], db);
    return addLedger(db, accountId, 'ajuste', amountCents, { note, by });
  });
}

// ---------- recarga e fatura pelo Mercado Pago (conta do licenciado) ----------

export async function createRecharge(accountId: string, tenantId: string, amountCents: number) {
  const a = await one(`SELECT name FROM accounts WHERE id = $1 AND tenant_id = $2 AND kind = 'loja'`, [accountId, tenantId]);
  if (!a) throw notFound('Loja não encontrada');
  const acc = await tenantMpToken(tenantId);
  if (!acc) throw badRequest('A central ainda não conectou o Mercado Pago. Fale com a central para recarregar.', 'mercadopago_nao_configurado');
  const title = `Créditos de entrega — ${a.name}`;
  const c = await one<{ id: string }>(
    `INSERT INTO charges (kind, tenant_id, account_id, amount_cents, description) VALUES ('recarga',$1,$2,$3,$4) RETURNING id`,
    [tenantId, accountId, amountCents, title],
  );
  const initPoint = await createPreferenceFor(c!.id, acc.token, { title, itemId: 'creditos-entrega', amountCents, account: acc.slug, kind: 'recarga' });
  return { chargeId: c!.id, init_point: initPoint, amountCents };
}

export async function createStoreInvoiceCharge(invoiceId: string, accountId: string, tenantId: string) {
  const inv = await one(`SELECT i.*, a.name FROM store_invoices i JOIN accounts a ON a.id = i.account_id WHERE i.id = $1 AND i.account_id = $2`, [invoiceId, accountId]);
  if (!inv) throw notFound('Fatura não encontrada');
  if (inv.status !== 'open') throw badRequest('Esta fatura não está em aberto', 'fatura_fechada');
  const acc = await tenantMpToken(tenantId);
  if (!acc) throw badRequest('A central ainda não conectou o Mercado Pago.', 'mercadopago_nao_configurado');
  const title = `Fatura de entregas — ${inv.name}`;
  const c = await one<{ id: string }>(
    `INSERT INTO charges (kind, tenant_id, account_id, store_invoice_id, amount_cents, description) VALUES ('fatura_loja',$1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, accountId, invoiceId, inv.total_cents, title],
  );
  const initPoint = await createPreferenceFor(c!.id, acc.token, { title, itemId: 'fatura-entregas', amountCents: inv.total_cents, account: acc.slug, kind: 'fatura_loja' });
  return { chargeId: c!.id, init_point: initPoint, amountCents: inv.total_cents };
}

/** Pagamento aprovado (chamado pela aplicação de pagamentos, já dentro da transação) */
export async function applyStorePayment(db: Db, c: any) {
  if (c.kind === 'recarga') {
    await addLedger(db, c.account_id, 'recarga', c.amount_cents, { chargeId: c.id, note: 'Mercado Pago' });
  } else {
    const inv = await one(
      `UPDATE store_invoices SET status = 'paid', paid_at = now(), paid_by = 'mercadopago' WHERE id = $1 AND status = 'open' RETURNING *`,
      [c.store_invoice_id], db,
    );
    if (inv) await addLedger(db, c.account_id, 'pagamento_fatura', inv.total_cents, { chargeId: c.id, note: 'fatura paga' });
  }
  emitTo(`account:${c.account_id}`, 'account:balance', { kind: c.kind });
}

/** Estorno/chargeback de uma recarga: o crédito sai do saldo */
export async function reverseStorePayment(db: Db, c: any) {
  if (c.kind === 'recarga') await addLedger(db, c.account_id, 'ajuste', -c.amount_cents, { chargeId: c.id, note: 'recarga estornada' });
  else {
    await query(`UPDATE store_invoices SET status = 'open', paid_at = NULL, paid_by = NULL WHERE id = $1 AND paid_by = 'mercadopago'`, [c.store_invoice_id], db);
    await addLedger(db, c.account_id, 'ajuste', -c.amount_cents, { chargeId: c.id, note: 'pagamento de fatura estornado' });
  }
}

export async function markStoreInvoicePaid(invoiceId: string, tenantId: string, by: string) {
  return tx(async (db) => {
    const inv = await one(
      `UPDATE store_invoices i SET status = 'paid', paid_at = now(), paid_by = 'manual'
         FROM accounts a WHERE a.id = i.account_id AND a.tenant_id = $2 AND i.id = $1 AND i.status = 'open' RETURNING i.*`,
      [invoiceId, tenantId], db,
    );
    if (!inv) throw badRequest('Fatura não encontrada ou já fechada');
    await one(`SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE`, [inv.account_id], db);
    await addLedger(db, inv.account_id, 'pagamento_fatura', inv.total_cents, { note: 'baixa manual', by });
    return inv;
  });
}

/** Fecha a semana anterior (segunda a domingo) das lojas em modo fatura. Pode rodar várias vezes. */
export async function generateStoreInvoices(weekStart?: string) {
  const start = weekStart ?? (await one<{ d: string }>(`SELECT (date_trunc('week', now()) - interval '7 days')::date AS d`))!.d;
  const rows = await query(
    `SELECT a.id, count(*) FILTER (WHERE l.kind = 'entrega')::int - count(*) FILTER (WHERE l.kind = 'estorno' AND l.ride_id IS NOT NULL)::int AS n,
            -coalesce(sum(l.amount_cents), 0)::int AS total
       FROM accounts a
       -- frete, cashback dado pela loja e, no Daqui Food, comissão dos pedidos e turnos de entregador fixo
       JOIN account_ledger l ON l.account_id = a.id AND l.kind IN ('entrega', 'estorno', 'cashback', 'comissao', 'turno')
        AND l.created_at >= $1::date AND l.created_at < $1::date + 7
      WHERE a.kind = 'loja' AND a.billing_mode = 'fatura'
        AND NOT EXISTS (SELECT 1 FROM store_invoices i WHERE i.account_id = a.id AND i.period_start = $1::date)
      GROUP BY a.id`,
    [start],
  );
  const created = [];
  for (const r of rows) {
    if (r.total <= 0) continue;
    const inv = await one(
      `INSERT INTO store_invoices (account_id, period_start, period_end, deliveries, total_cents, due_date)
       VALUES ($1, $2::date, $2::date + 6, $3, $4, $2::date + 6 + $5::int)
       ON CONFLICT (account_id, period_start) DO NOTHING RETURNING *`,
      [r.id, start, r.n, r.total, STORE_INVOICE_DAYS],
    );
    if (inv) { created.push(inv); emitTo(`account:${r.id}`, 'account:balance', { kind: 'fatura' }); }
  }
  return created;
}

// ---------- cobrança do produto na entrega ----------

/** Conta Mercado Pago da loja (para gerar o Pix com valor) */
export async function storeMp(accountId: string, db: Db = pool) {
  const a = await one(`SELECT mp_access_token_enc, mp_webhook_secret_enc FROM accounts WHERE id = $1`, [accountId], db);
  if (!a?.mp_access_token_enc) return null;
  return { token: decrypt(a.mp_access_token_enc), webhookSecret: a.mp_webhook_secret_enc ? decrypt(a.mp_webhook_secret_enc) : '' };
}

const payerEmail = (rideId: string) => {
  const host = (() => { try { return new URL(config.publicApiUrl).hostname; } catch { return 'ondaqui.com.br'; } })();
  const domain = /^(localhost|127\.|\d+\.\d+\.\d+\.\d+$)/.test(host) ? 'ondaqui.com.br' : host.replace(/^api\./, '');
  return `entrega-${rideId.slice(0, 8)}@${domain}`;
};

/** Gera (ou devolve o já gerado) Pix da loja para quem recebe pagar o produto */
export async function startCodPix(r: any) {
  if (r.cod_method === 'pix_mp' && r.cod_qr_code && r.cod_status === 'pendente') return;
  const store = await storeMp(r.account_id);
  if (!store) {
    const a = await one(`SELECT pix_key, pix_validated FROM accounts WHERE id = $1`, [r.account_id]);
    if (!a?.pix_key || !a.pix_validated) throw badRequest('A loja não tem Pix conferido pela central. Use a maquininha da loja.', 'sem_pix_loja');
    await query(`UPDATE rides SET cod_method = 'pix_chave' WHERE id = $1`, [r.id]);
    return;
  }
  const pix = await mp().createPixPayment(store.token, {
    amountCents: r.cod_amount_cents,
    description: `Pedido entregue pelo OnDaqui para ${r.recipient_name}`,
    externalReference: `cod:${r.id}`,
    notificationUrl: `${config.publicApiUrl}/webhooks/mercadopago/loja/${r.account_id}`,
    payerEmail: payerEmail(r.id),
    expiresInMinutes: 60,
  }, `cod-${r.id}`);
  await query(
    `UPDATE rides SET cod_method = 'pix_mp', cod_mp_payment_id = $2, cod_qr_code = $3, cod_qr_base64 = $4 WHERE id = $1`,
    [r.id, pix.id, pix.qrCode, pix.qrCodeBase64],
  );
}

/** Confere o Pix da loja direto no Mercado Pago (não confia em quem avisa) */
export async function checkCodPix(rideId: string) {
  const r = await one(`SELECT * FROM rides WHERE id = $1`, [rideId]);
  if (!r || r.cod_method !== 'pix_mp' || !r.cod_mp_payment_id || r.cod_status !== 'pendente') return r?.cod_status ?? null;
  const store = await storeMp(r.account_id);
  if (!store) return r.cod_status;
  const p = await mp().getPayment(store.token, r.cod_mp_payment_id);
  if (p.status === 'approved' && p.external_reference === `cod:${r.id}` && Math.round(p.transaction_amount * 100) === r.cod_amount_cents) {
    const up = await one(
      `UPDATE rides SET cod_status = 'pago', cod_paid_at = now() WHERE id = $1 AND cod_status = 'pendente' RETURNING driver_id, account_id`, [r.id],
    );
    if (up) {
      const payload = { rideId: r.id, codStatus: 'pago' };
      if (up.driver_id) emitTo(`user:${up.driver_id}`, 'ride:cod', payload);
      emitTo(`account:${up.account_id}`, 'ride:cod', payload);
    }
    return 'pago';
  }
  return r.cod_status;
}

/** Fecha como recebidas as cobranças que a loja não conferiu no prazo (roda junto com a cobrança, de hora em hora) */
export async function autoConfirmCod() {
  const rows = await query<{ id: string; account_id: string; driver_id: string }>(
    `UPDATE rides SET cod_status = 'confirmado', cod_settled_by = 'automatico', cod_settled_at = now()
      WHERE cod_status = 'aguardando_loja' AND cod_paid_at < now() - make_interval(hours => $1)
      RETURNING id, account_id, driver_id`,
    [COD_CONFIRM_HOURS],
  );
  for (const r of rows) {
    emitTo(`account:${r.account_id}`, 'ride:cod', { rideId: r.id, codStatus: 'confirmado', automatic: true });
    emitTo(`user:${r.driver_id}`, 'ride:cod', { rideId: r.id, codStatus: 'confirmado' });
  }
  return rows.length;
}
