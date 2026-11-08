import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { one, query } from '../lib/db.js';
import { requireAuth, requireAuthEvenSuspended } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { encrypt, mask, decrypt } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse, uuid } from '../lib/validate.js';
import { mp, validSignature } from '../lib/mercadopago.js';
import { driverCommissions, settleCommission } from '../lib/commissions.js';
import {
  PLATFORM, createCommissionCharge, createDriverCharge, createInvoiceCharge, generateInvoices, handlePaymentNotification,
  invoiceAmounts, monthLabel, reactivateIfPaidUp, syncCharge, tenantMpToken, webhookUrl,
} from '../lib/billing.js';

type Params = { Params: { id: string } };

// ---------- notificações do Mercado Pago processadas depois de responder 200 ----------
const inFlight = new Set<Promise<unknown>>();
/** usado pelos testes: espera as notificações em andamento terminarem */
export async function drainWebhooks() { while (inFlight.size) await Promise.allSettled([...inFlight]); }

/** roda depois de responder (notificações do Mercado Pago) */
export function later(fn: () => Promise<unknown>) {
  const p = fn().catch(() => undefined).finally(() => inFlight.delete(p));
  inFlight.add(p);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function billingRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAuth('tenant_admin') };
  const adminEvenSuspended = { preHandler: requireAuthEvenSuspended('tenant_admin') };
  const driver = { preHandler: requireAuth('driver') };
  const master = { preHandler: requireAuth('master') };

  // ================= licenciado: conta Mercado Pago da cidade =================

  app.get('/admin/mercadopago', admin, async (req) => {
    const t = await one(`SELECT slug, mp_access_token_enc, mp_webhook_secret_enc, mp_account_label FROM tenants WHERE id = $1`, [req.auth.tenantId]);
    return {
      connected: !!t.mp_access_token_enc,
      account: t.mp_account_label,
      token: t.mp_access_token_enc ? mask(decrypt(t.mp_access_token_enc)) : null,
      webhookSecretSet: !!t.mp_webhook_secret_enc,
      webhookUrl: webhookUrl(t.slug),
      testMode: t.mp_access_token_enc ? decrypt(t.mp_access_token_enc).startsWith('TEST-') : null,
    };
  });

  app.put('/admin/mercadopago', admin, async (req) => {
    const b = parse(z.object({
      accessToken: z.string().trim().regex(/^(APP_USR|TEST)-[A-Za-z0-9-]{20,}$/, 'Access Token inválido (começa com APP_USR- ou TEST-)'),
      webhookSecret: z.string().trim().min(16).max(200).optional().or(z.literal('')),
    }), req.body);
    let account;
    try {
      account = await mp().getAccount(b.accessToken);
    } catch {
      throw badRequest('O Mercado Pago não aceitou este Access Token. Confira se copiou o token inteiro.', 'token_recusado');
    }
    if (account.site_id !== 'MLB') throw badRequest('A conta precisa ser do Mercado Pago Brasil', 'conta_fora_do_brasil');
    const label = `${account.nickname} (${account.id})`;
    await query(
      `UPDATE tenants SET mp_access_token_enc = $2, mp_account_label = $3,
              mp_webhook_secret_enc = CASE WHEN $4::text IS NULL THEN mp_webhook_secret_enc WHEN $4 = '' THEN NULL ELSE $4 END
        WHERE id = $1`,
      [req.auth.tenantId, encrypt(b.accessToken), label, b.webhookSecret === undefined ? null : b.webhookSecret ? encrypt(b.webhookSecret) : ''],
    );
    return { connected: true, account: label };
  });

  app.delete('/admin/mercadopago', admin, async (req) => {
    await query(`UPDATE tenants SET mp_access_token_enc = NULL, mp_webhook_secret_enc = NULL, mp_account_label = NULL WHERE id = $1`, [req.auth.tenantId]);
    return { connected: false };
  });

  // ================= motorista: mensalidade =================

  app.post('/driver/subscription/checkout', driver, async (req, reply) => {
    const { periods } = parse(z.object({ periods: z.number().int().min(1).max(6).default(1) }), req.body ?? {});
    const r = await createDriverCharge(req.auth.id, req.auth.tenantId!, periods);
    reply.code(201);
    return r;
  });

  /** O app chama ao voltar do Mercado Pago: confere os pagamentos recentes deste motorista */
  app.post('/driver/subscription/sync', driver, async (req) => {
    const pending = await query<{ id: string }>(
      `SELECT id FROM charges WHERE driver_id = $1 AND status IN ('pending', 'rejected', 'expired')
         AND created_at > now() - interval '72 hours' ORDER BY created_at DESC LIMIT 5`,
      [req.auth.id],
    );
    const results = [];
    for (const c of pending) {
      try { results.push(await syncCharge(c.id)); } catch { results.push('erro'); }
    }
    const d = await one(`SELECT paid_until, trial_until FROM drivers WHERE user_id = $1`, [req.auth.id]);
    return { applied: results.includes('aplicado'), pending: results.includes('pendente'), paidUntil: d?.paid_until, trialUntil: d?.trial_until };
  });

  app.get('/driver/subscription/charges', driver, async (req) => {
    const rows = await query(
      `SELECT id, description, amount_cents, status, created_at, paid_at FROM charges
        WHERE driver_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 20`,
      [req.auth.id],
    );
    return { charges: rows, available: !!(await tenantMpToken(req.auth.tenantId!)) };
  });

  // ================= motorista: comissão do plano Livre =================

  app.get('/driver/commissions', driver, async (req) => ({
    ...(await driverCommissions(req.auth.id)),
    available: !!(await tenantMpToken(req.auth.tenantId!)),
  }));

  app.post<Params>('/driver/commissions/:id/checkout', driver, async (req, reply) => {
    parse(uuid, req.params.id);
    const r = await createCommissionCharge(req.params.id, req.auth.id, req.auth.tenantId!);
    reply.code(201);
    return r;
  });

  // ================= licenciado: comissões a receber dos motoristas =================

  app.get('/admin/commissions', admin, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'paid', 'cancelled', 'all']).default('open') }), req.query);
    const invoices = await query(
      `SELECT i.*, u.name AS driver_name, u.phone AS driver_phone, d.vehicle_plate,
              (i.status = 'open' AND i.due_date < current_date) AS overdue
         FROM commission_invoices i JOIN users u ON u.id = i.driver_id LEFT JOIN drivers d ON d.user_id = i.driver_id
        WHERE i.tenant_id = $1 AND ($2 = 'all' OR i.status = $2)
        ORDER BY (i.status = 'open' AND i.due_date < current_date) DESC, i.due_date DESC, u.name LIMIT 300`,
      [req.auth.tenantId, status],
    );
    const totals = await one(
      `SELECT coalesce(sum(amount_cents) FILTER (WHERE status = 'open'), 0)::int AS open_cents,
              coalesce(sum(amount_cents) FILTER (WHERE status = 'open' AND due_date < current_date), 0)::int AS overdue_cents,
              coalesce(sum(amount_cents) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('month', now())), 0)::int AS paid_month_cents,
              (SELECT coalesce(sum(commission_cents), 0) FROM rides
                WHERE tenant_id = $1 AND status = 'completed' AND commission_cents > 0 AND commission_invoice_id IS NULL
                  AND payment_method IN ('cash', 'pix', 'card'))::int AS week_cents
         FROM commission_invoices WHERE tenant_id = $1`,
      [req.auth.tenantId],
    );
    return { invoices, totals };
  });

  app.post<Params>('/admin/commissions/:id/mark-paid', admin, async (req) => {
    parse(uuid, req.params.id);
    const { note } = parse(z.object({ note: z.string().trim().max(200).optional() }), req.body ?? {});
    const inv = await settleCommission(req.params.id, req.auth.tenantId!, req.auth.id, 'central', note);
    if (!inv) throw notFound('Fatura não encontrada ou já fechada');
    return { invoice: inv };
  });

  app.post<Params>('/admin/commissions/:id/cancel', admin, async (req) => {
    parse(uuid, req.params.id);
    const { note } = parse(z.object({ note: z.string().trim().min(3, 'Escreva o motivo').max(200) }), req.body ?? {});
    const inv = await settleCommission(req.params.id, req.auth.tenantId!, req.auth.id, 'cancelar', note);
    if (!inv) throw notFound('Fatura não encontrada ou já fechada');
    return { invoice: inv };
  });

  // ================= licenciado: faturas da plataforma =================

  app.get('/admin/invoices', adminEvenSuspended, async (req) => {
    const t = await one(`SELECT active, suspended_reason, license_monthly_cents, license_fee_per_ride_cents FROM tenants WHERE id = $1`, [req.auth.tenantId]);
    const invoices = await query(
      `SELECT i.*, (i.status = 'open' AND i.due_date < current_date) AS overdue FROM invoices i
        WHERE i.tenant_id = $1 ORDER BY i.period DESC LIMIT 24`,
      [req.auth.tenantId],
    );
    const period = (await one<{ p: string }>(`SELECT date_trunc('month', now())::date AS p`))!.p;
    const current = await invoiceAmounts(req.auth.tenantId!, period);
    return {
      tenant: { active: t.active, suspendedReason: t.suspended_reason, licenseMonthlyCents: t.license_monthly_cents, feePerRideCents: t.license_fee_per_ride_cents },
      onlinePayment: !!config.mpAccessToken,
      suspendAfterDays: config.suspendAfterDays,
      current: { period, label: monthLabel(period), ...current },
      invoices: invoices.map((i) => ({ ...i, label: monthLabel(i.period) })),
    };
  });

  app.post<Params>('/admin/invoices/:id/checkout', adminEvenSuspended, async (req, reply) => {
    parse(uuid, req.params.id);
    const r = await createInvoiceCharge(req.params.id, req.auth.tenantId!);
    reply.code(201);
    return r;
  });

  app.post<Params>('/admin/invoices/:id/sync', adminEvenSuspended, async (req) => {
    parse(uuid, req.params.id);
    const inv = await one(`SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth.tenantId]);
    if (!inv) throw notFound('Fatura não encontrada');
    const charges = await query<{ id: string }>(
      `SELECT id FROM charges WHERE invoice_id = $1 AND status IN ('pending', 'rejected', 'expired')
         AND created_at > now() - interval '72 hours' ORDER BY created_at DESC LIMIT 5`, [inv.id],
    );
    for (const c of charges) { try { await syncCharge(c.id); } catch { /* tenta de novo depois */ } }
    const after = await one(`SELECT i.status, t.active FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = $1`, [inv.id]);
    return { status: after.status, tenantActive: after.active };
  });

  // ================= master: faturas de todos =================

  app.get('/master/invoices', master, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'paid', 'cancelled']).optional() }), req.query);
    const rows = await query(
      `SELECT i.*, t.name AS tenant_name, t.slug, t.active AS tenant_active, t.suspended_reason,
              (i.status = 'open' AND i.due_date < current_date) AS overdue
         FROM invoices i JOIN tenants t ON t.id = i.tenant_id
        WHERE ($1::text IS NULL OR i.status = $1) ORDER BY i.period DESC, t.name LIMIT 300`,
      [status ?? null],
    );
    const totals = await one(
      `SELECT coalesce(sum(total_cents) FILTER (WHERE status = 'open'), 0)::int AS open_cents,
              coalesce(sum(total_cents) FILTER (WHERE status = 'open' AND due_date < current_date), 0)::int AS overdue_cents,
              coalesce(sum(total_cents) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('month', now())), 0)::int AS paid_month_cents
         FROM invoices`,
    );
    return { invoices: rows.map((i) => ({ ...i, label: monthLabel(i.period) })), totals, onlinePayment: !!config.mpAccessToken };
  });

  app.post('/master/invoices/generate', master, async (req) => {
    const { period } = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, 'use AAAA-MM').optional() }), req.body ?? {});
    const created = await generateInvoices(period ? `${period}-01` : undefined);
    return { created: created.length };
  });

  app.post<Params>('/master/invoices/:id/mark-paid', master, async (req) => {
    parse(uuid, req.params.id);
    const inv = await one(
      `UPDATE invoices SET status = 'paid', paid_at = now(), paid_by = 'manual' WHERE id = $1 AND status = 'open' RETURNING *`,
      [req.params.id],
    );
    if (!inv) throw badRequest('Fatura não encontrada ou já fechada');
    const reactivated = await reactivateIfPaidUp(inv.tenant_id);
    return { invoice: inv, reactivated };
  });

  app.post<Params>('/master/invoices/:id/cancel', master, async (req) => {
    parse(uuid, req.params.id);
    const inv = await one(`UPDATE invoices SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING *`, [req.params.id]);
    if (!inv) throw badRequest('Fatura não encontrada ou já fechada');
    const reactivated = await reactivateIfPaidUp(inv.tenant_id);
    return { invoice: inv, reactivated };
  });

  // ================= notificações (webhooks) do Mercado Pago =================

  async function receive(account: string, secret: string, req: any, reply: FastifyReply) {
    const q = (req.query ?? {}) as Record<string, string>;
    const body = (req.body ?? {}) as { type?: string; topic?: string; data?: { id?: string | number } };
    const topic = body.type ?? q.type ?? body.topic ?? q.topic;
    const dataId = String(q['data.id'] ?? body.data?.id ?? q.id ?? '');
    const log = (result: string) => query(
      `INSERT INTO mp_notifications (account, topic, data_id, result) VALUES ($1,$2,$3,$4)`,
      [account, topic ?? null, dataId.slice(0, 64) || null, result],
    ).catch(() => undefined);

    // com a chave secreta configurada, só aceita notificação assinada pelo Mercado Pago
    if (secret && !validSignature(secret, req.headers['x-signature'], req.headers['x-request-id'], q['data.id'] ?? dataId)) {
      await log('assinatura_invalida');
      return reply.code(401).send({ ok: false });
    }

    // responde 200 na hora; a conferência no Mercado Pago acontece em seguida
    reply.code(200).send({ ok: true });
    if (topic !== 'payment' || !/^\d{1,20}$/.test(dataId)) { await log('ignorado'); return reply; }
    later(async () => {
      try {
        const r = await handlePaymentNotification(account, dataId);
        await log(secret ? r : `${r} (sem_assinatura)`);
      } catch (e) {
        await log(`erro: ${(e as Error).message.slice(0, 120)}`);
      }
    });
    return reply;
  }

  app.post('/webhooks/mercadopago/plataforma', async (req, reply) => receive(PLATFORM, config.mpWebhookSecret, req, reply));

  app.post<{ Params: { slug: string } }>('/webhooks/mercadopago/t/:slug', async (req, reply) => {
    const t = await one<{ id: string; slug: string }>('SELECT id, slug FROM tenants WHERE slug = $1', [req.params.slug]);
    if (!t) return reply.code(404).send({ ok: false });
    const acc = await tenantMpToken(t.id);
    if (!acc) return reply.code(200).send({ ok: true }); // conta desconectada: nada a fazer
    return receive(t.slug, acc.webhookSecret, req, reply);
  });

  // ================= página de retorno do Checkout Pro =================

  app.get('/pagamento/retorno', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const kind = q.k === 'fatura' || q.k === 'loja' ? q.k : 'mensalidade';
    const status = q.collection_status ?? q.status ?? '';
    const ref = q.external_reference ?? '';

    // aproveita a volta para conferir o pagamento direto no Mercado Pago (não confia nos parâmetros)
    if (/^[0-9a-f-]{36}$/i.test(ref)) later(() => syncCharge(ref));

    const view = status === 'approved'
      ? { icon: '✅', title: 'Pagamento aprovado', text: 'Obrigado! Em instantes ele aparece confirmado.' }
      : status === 'pending' || status === 'in_process'
        ? { icon: '⏳', title: 'Pagamento em análise', text: 'Se você pagou com Pix ou boleto, a confirmação chega sozinha assim que o Mercado Pago aprovar.' }
        : status === 'rejected' || status === 'null' || status === 'failure'
          ? { icon: '⚠️', title: 'Pagamento não concluído', text: 'Nada foi cobrado. Você pode tentar de novo com outro meio de pagamento.' }
          : { icon: '↩️', title: 'Volte para o OnDaqui', text: 'Se você concluiu o pagamento, ele é confirmado automaticamente.' };
    const back = kind !== 'mensalidade' && config.painelUrl
      ? `<a class="btn" href="${esc(config.painelUrl)}/?pagina=${kind === 'loja' ? 'creditos' : 'faturas'}">Voltar ao painel</a>`
      : `<p class="hint">Pode fechar esta janela e voltar ao app.</p>`;

    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OnDaqui — ${esc(view.title)}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14161A;color:#F4F1EC;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:380px;padding:32px 24px;text-align:center}
.logo{font-weight:800;font-size:28px;letter-spacing:-.5px;margin-bottom:28px}.logo b{color:#F2622E}
.icon{font-size:44px}h1{font-size:22px;margin:12px 0 8px}p{color:#C9C3BA;line-height:1.5;margin:0}
.btn{display:inline-block;margin-top:24px;background:#F2622E;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:12px}
.hint{margin-top:24px;font-size:14px;color:#8F8981}
</style></head><body><main>
<div class="logo"><b>⏻n</b>Daqui</div>
<div class="icon">${view.icon}</div><h1>${esc(view.title)}</h1><p>${esc(view.text)}</p>${back}
</main></body></html>`;
  });
}
