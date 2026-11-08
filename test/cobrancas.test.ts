import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, login, startServer, stopServer, type Ctx } from './helpers.js';
import { config } from '../src/lib/config.js';
import { one, query } from '../src/lib/db.js';
import { pushOutbox } from '../src/lib/push.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { setMercadoPagoGateway, validSignature, type MercadoPagoGateway, type MpPayment, type PreferenceInput } from '../src/lib/mercadopago.js';
import { sendDriverReminders, suspendOverdueTenants } from '../src/lib/billing.js';
import { drainWebhooks } from '../src/routes/billing.js';

// ---------- Mercado Pago simulado ----------
const CITY_TOKEN = 'APP_USR-1111111111111111-cidade-bauru-0000000000000000';
const PLATFORM_TOKEN = 'APP_USR-2222222222222222-plataforma-000000000000000';
const CITY_SECRET = 'segredo-webhook-da-cidade-123456';
const PLATFORM_SECRET = 'segredo-webhook-da-plataforma-99';

const prefs: { token: string; p: PreferenceInput; key: string }[] = [];
const payments = new Map<string, { token: string; pay: MpPayment }>();
let nextPayment = 9_000_000_001;

const fake: MercadoPagoGateway = {
  async createPreference(token, p, key) {
    prefs.push({ token, p, key });
    return { id: `pref-${prefs.length}`, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${prefs.length}` };
  },
  async getPayment(token, id) {
    const x = payments.get(id);
    if (!x || x.token !== token) throw new Error('payment not found');
    return x.pay;
  },
  async findPaymentsByReference(token, ref) {
    return [...payments.values()].filter((x) => x.token === token && x.pay.external_reference === ref).map((x) => x.pay);
  },
  async getAccount(token) {
    if (token === CITY_TOKEN) return { id: '123456', nickname: 'ONDAQUIBAURU', site_id: 'MLB' };
    if (token.includes('argentina')) return { id: '9', nickname: 'AR', site_id: 'MLA' };
    throw new Error('401');
  },
};

/** "Paga" no Mercado Pago simulado e devolve o id do pagamento */
function pay(token: string, ref: string, amount: number, status = 'approved', currency = 'BRL') {
  const id = String(nextPayment++);
  payments.set(id, { token, pay: { id, status, external_reference: ref, transaction_amount: amount, currency_id: currency } });
  return id;
}

function signedHeaders(secret: string, dataId: string, requestId = `req-${dataId}`) {
  const ts = String(Date.now());
  const v1 = createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId, 'content-type': 'application/json' };
}

async function notify(ctx: Ctx, path: string, dataId: string, headers: Record<string, string>) {
  const res = await fetch(`${ctx.base}${path}?data.id=${dataId}&type=payment`, {
    method: 'POST', headers, body: JSON.stringify({ type: 'payment', action: 'payment.updated', data: { id: dataId } }),
  });
  await drainWebhooks();
  return res.status;
}

const paidUntil = async (phone: string) =>
  (await one(`SELECT d.paid_until FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.phone = $1`, [phone]))!.paid_until as string;
const planBase = async (phone: string) =>
  (await one(`SELECT greatest(coalesce(d.paid_until, current_date - 1), coalesce(d.trial_until, current_date - 1), current_date - 1) AS b
                FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.phone = $1`, [phone]))!.b as string;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

let ctx: Ctx;
let admin: string, joao: string, ana: string, master: string;

beforeAll(async () => {
  setMercadoPagoGateway(fake);
  ctx = await startServer();
  [admin, joao, ana, master] = await Promise.all([
    login(ctx, '14900000001'), login(ctx, '14900000020'), login(ctx, '14900000021'), login(ctx, '11900000000', null),
  ]);
  await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[joao-aparelho-mp]', platform: 'android' }, joao);
});
afterAll(async () => {
  setMercadoPagoGateway(null);
  config.mpAccessToken = '';
  config.mpWebhookSecret = '';
  await stopServer(ctx);
});
beforeEach(() => { pushOutbox.length = 0; });

describe('assinatura das notificações (x-signature)', () => {
  it('aceita a assinatura certa e recusa as erradas', () => {
    const h = signedHeaders('abc123', '42', 'r-1');
    expect(validSignature('abc123', h['x-signature'], 'r-1', '42')).toBe(true);
    expect(validSignature('outra', h['x-signature'], 'r-1', '42')).toBe(false);
    expect(validSignature('abc123', h['x-signature'], 'r-2', '42')).toBe(false);
    expect(validSignature('abc123', h['x-signature'], 'r-1', '43')).toBe(false);
    expect(validSignature('abc123', 'ts=1,v1=zz', 'r-1', '42')).toBe(false);
    expect(validSignature('abc123', undefined, 'r-1', '42')).toBe(false);
  });

  it('criptografa e abre os tokens guardados', () => {
    const s = encrypt(CITY_TOKEN);
    expect(s).not.toContain('APP_USR');
    expect(decrypt(s)).toBe(CITY_TOKEN);
    expect(() => decrypt(s.slice(0, -4) + 'AAAA')).toThrow();
  });
});

describe('conta Mercado Pago do licenciado', () => {
  it('recusa token inválido ou de outro país', async () => {
    expect((await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: 'qualquer' }, admin)).status).toBe(400);
    expect((await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: 'APP_USR-0000000000-recusado-00000000000' }, admin)).body.code).toBe('token_recusado');
    expect((await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: 'APP_USR-0000000000-argentina-0000000000' }, admin)).body.code).toBe('conta_fora_do_brasil');
  });

  it('motorista não consegue pagar antes de a cidade conectar a conta', async () => {
    const r = await api(ctx, 'POST', '/driver/subscription/checkout', {}, joao);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('mercadopago_nao_configurado');
  });

  it('conecta, guarda criptografado e mostra só o final do token', async () => {
    const r = await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: CITY_TOKEN, webhookSecret: CITY_SECRET }, admin);
    expect(r.status).toBe(200);
    expect(r.body.account).toContain('ONDAQUIBAURU');
    const g = await api(ctx, 'GET', '/admin/mercadopago', undefined, admin);
    expect(g.body).toMatchObject({ connected: true, webhookSecretSet: true, testMode: false });
    expect(g.body.token).toBe(`••••${CITY_TOKEN.slice(-4)}`);
    expect(g.body.webhookUrl).toMatch(/\/webhooks\/mercadopago\/t\/bauru$/);
    const raw = await one(`SELECT mp_access_token_enc, mp_webhook_secret_enc FROM tenants WHERE slug = 'bauru'`);
    expect(JSON.stringify(raw)).not.toContain('APP_USR');
    expect(JSON.stringify(raw)).not.toContain(CITY_SECRET);
    expect((await api(ctx, 'GET', '/driver/me', undefined, joao)).body.onlinePayment).toBe(true);
  });

  it('só o licenciado mexe na conta', async () => {
    expect((await api(ctx, 'GET', '/admin/mercadopago', undefined, joao)).status).toBe(403);
  });
});

describe('mensalidade do motorista', () => {
  let chargeId: string;

  it('plano sem mensalidade não abre pagamento', async () => {
    const r = await api(ctx, 'POST', '/driver/subscription/checkout', {}, ana);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('plano_sem_mensalidade');
  });

  it('abre o Checkout Pro na conta da cidade', async () => {
    const r = await api(ctx, 'POST', '/driver/subscription/checkout', { periods: 1 }, joao);
    expect(r.status).toBe(201);
    expect(r.body.init_point).toMatch(/^https:\/\/www\.mercadopago\.com\.br\//);
    expect(r.body.amountCents).toBe(19900);
    chargeId = r.body.chargeId;
    const last = prefs.at(-1)!;
    expect(last.token).toBe(CITY_TOKEN);
    expect(last.key).toBe(chargeId); // chave de idempotência
    expect(last.p).toMatchObject({ externalReference: chargeId, amountCents: 19900, autoReturn: false });
    expect(last.p.notificationUrl).toMatch(/\/webhooks\/mercadopago\/t\/bauru$/);
    expect(last.p.backUrl).toMatch(/\/pagamento\/retorno\?k=mensalidade$/);
  });

  it('recusa notificação sem assinatura válida', async () => {
    const id = pay(CITY_TOKEN, chargeId, 199);
    const before = await paidUntil('14900000020');
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', id, { 'content-type': 'application/json' })).toBe(401);
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', id, signedHeaders('segredo-errado', id))).toBe(401);
    expect(await paidUntil('14900000020')).toBe(before);
    payments.delete(id);
  });

  it('não aplica pagamento com valor diferente', async () => {
    const id = pay(CITY_TOKEN, chargeId, 1.99);
    const before = await paidUntil('14900000020');
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', id, signedHeaders(CITY_SECRET, id))).toBe(200);
    expect(await paidUntil('14900000020')).toBe(before);
    const log = await one(`SELECT result FROM mp_notifications WHERE data_id = $1`, [id]);
    expect(log.result).toBe('divergente');
    payments.delete(id);
  });

  it('pagamento aprovado soma 30 dias, avisa o motorista e não aplica duas vezes', async () => {
    const base = await planBase('14900000020');
    const id = pay(CITY_TOKEN, chargeId, 199);
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', id, signedHeaders(CITY_SECRET, id))).toBe(200);
    const after = await paidUntil('14900000020');
    expect(daysBetween(base, after)).toBe(30);
    const c = await one(`SELECT status, mp_payment_id FROM charges WHERE id = $1`, [chargeId]);
    expect(c).toMatchObject({ status: 'approved', mp_payment_id: id });
    const sp = await one(`SELECT amount_cents, registered_by FROM subscription_payments ORDER BY paid_at DESC LIMIT 1`);
    expect(sp).toMatchObject({ amount_cents: 19900, registered_by: null });
    expect(pushOutbox.some((m) => m.title.startsWith('Pagamento confirmado'))).toBe(true);

    // o Mercado Pago repete a notificação: nada muda
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', id, signedHeaders(CITY_SECRET, id, 'outro-request'))).toBe(200);
    expect(await paidUntil('14900000020')).toBe(after);
    expect((await query(`SELECT 1 FROM subscription_payments sp JOIN users u ON u.id = sp.driver_id WHERE u.phone = '14900000020' AND sp.registered_by IS NULL`)).length).toBe(1);
  });

  it('pagamento da cidade enviado para o endereço da plataforma é ignorado', async () => {
    config.mpAccessToken = CITY_TOKEN; // mesmo token, para provar que a conferência é pela conta dona da cobrança
    const r = await api(ctx, 'POST', '/driver/subscription/checkout', {}, joao);
    const id = pay(CITY_TOKEN, r.body.chargeId, 199);
    expect(await notify(ctx, '/webhooks/mercadopago/plataforma', id, { 'content-type': 'application/json' })).toBe(200);
    expect((await one(`SELECT status FROM charges WHERE id = $1`, [r.body.chargeId])).status).toBe('pending');
    config.mpAccessToken = '';
    payments.delete(id);
  });

  it('se a notificação não chegar, o app confere ao voltar do Mercado Pago', async () => {
    const before = await planBase('14900000020');
    const r = await api(ctx, 'POST', '/driver/subscription/checkout', {}, joao);
    pay(CITY_TOKEN, r.body.chargeId, 199, 'rejected');
    pay(CITY_TOKEN, r.body.chargeId, 199, 'approved');
    const s = await api(ctx, 'POST', '/driver/subscription/sync', {}, joao);
    expect(s.status).toBe(200);
    expect(s.body.applied).toBe(true);
    expect(daysBetween(before, await paidUntil('14900000020'))).toBe(30);
    const list = await api(ctx, 'GET', '/driver/subscription/charges', undefined, joao);
    expect(list.body.charges.filter((c: any) => c.status === 'approved').length).toBe(2);
  });

  it('estorno devolve os dias', async () => {
    const before = await paidUntil('14900000020');
    const c = await one(`SELECT id, mp_payment_id FROM charges WHERE status = 'approved' ORDER BY paid_at DESC LIMIT 1`);
    payments.get(c.mp_payment_id)!.pay.status = 'refunded';
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', c.mp_payment_id, signedHeaders(CITY_SECRET, c.mp_payment_id))).toBe(200);
    expect(daysBetween(await paidUntil('14900000020'), before)).toBe(30);
    expect((await one(`SELECT status FROM charges WHERE id = $1`, [c.id])).status).toBe('refunded');
  });

  it('página de retorno não confia nos parâmetros e escapa o texto', async () => {
    const res = await fetch(`${ctx.base}/pagamento/retorno?k=mensalidade&collection_status=approved&external_reference=<script>`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Pagamento aprovado');
    expect(html).not.toContain('<script>');
  });

  it('lembra do vencimento uma vez por etapa', async () => {
    await query(`UPDATE drivers SET paid_until = current_date + 3, trial_until = NULL WHERE user_id = (SELECT id FROM users WHERE phone = '14900000020')`);
    await sendDriverReminders();
    expect(pushOutbox.filter((m) => m.title === 'Renove seu plano').length).toBe(1);
    expect(pushOutbox[0].body).toContain('3 dias');
    await sendDriverReminders();
    expect(pushOutbox.length).toBe(1);
  });
});

describe('fatura mensal do licenciado', () => {
  let invoiceId: string;
  const prevMonth = () => {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };

  it('master gera a fatura do mês anterior sem duplicar', async () => {
    await query(`UPDATE tenants SET created_at = now() - interval '90 days' WHERE slug = 'bauru'`);
    const g = await api(ctx, 'POST', '/master/invoices/generate', { period: prevMonth() }, master);
    expect(g.body.created).toBe(1);
    expect((await api(ctx, 'POST', '/master/invoices/generate', { period: prevMonth() }, master)).body.created).toBe(0);
    const list = await api(ctx, 'GET', '/admin/invoices', undefined, admin);
    expect(list.status).toBe(200);
    expect(list.body.invoices).toHaveLength(1);
    const inv = list.body.invoices[0];
    expect(inv).toMatchObject({ license_cents: 49900, total_cents: 49900, status: 'open' });
    expect(inv.due_date.slice(8, 10)).toBe('10');
    expect(list.body.current.totalCents).toBeGreaterThanOrEqual(0);
    invoiceId = inv.id;
  });

  it('sem conta da plataforma, o pagamento online fica indisponível', async () => {
    const r = await api(ctx, 'POST', `/admin/invoices/${invoiceId}/checkout`, {}, admin);
    expect(r.body.code).toBe('mercadopago_nao_configurado');
  });

  it('atraso suspende a cidade, mas o licenciado ainda vê e paga a fatura', async () => {
    config.mpAccessToken = PLATFORM_TOKEN;
    config.mpWebhookSecret = PLATFORM_SECRET;
    await query(`UPDATE invoices SET due_date = current_date - 20 WHERE id = $1`, [invoiceId]);
    expect(await suspendOverdueTenants()).toHaveLength(1);

    expect((await api(ctx, 'GET', '/driver/me', undefined, joao)).body.code).toBe('licenciado_suspenso');
    expect((await api(ctx, 'GET', '/admin/overview', undefined, admin)).status).toBe(403);
    const me = await api(ctx, 'GET', '/me', undefined, admin);
    expect(me.body).toMatchObject({ tenant_active: false, suspended_reason: 'inadimplencia' });

    const r = await api(ctx, 'POST', `/admin/invoices/${invoiceId}/checkout`, {}, admin);
    expect(r.status).toBe(201);
    const last = prefs.at(-1)!;
    expect(last.token).toBe(PLATFORM_TOKEN);
    expect(last.p.notificationUrl).toMatch(/\/webhooks\/mercadopago\/plataforma$/);
    expect(last.p.amountCents).toBe(49900);

    const id = pay(PLATFORM_TOKEN, r.body.chargeId, 499);
    expect(await notify(ctx, '/webhooks/mercadopago/plataforma', id, signedHeaders(PLATFORM_SECRET, id))).toBe(200);
    const inv = await one(`SELECT status, paid_by FROM invoices WHERE id = $1`, [invoiceId]);
    expect(inv).toMatchObject({ status: 'paid', paid_by: 'mercadopago' });
    expect((await one(`SELECT active, suspended_reason FROM tenants WHERE slug = 'bauru'`))).toMatchObject({ active: true, suspended_reason: null });
    expect((await api(ctx, 'GET', '/admin/overview', undefined, admin)).status).toBe(200);
  });

  it('master pode dar baixa manual e vê o resumo', async () => {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 2);
    await api(ctx, 'POST', '/master/invoices/generate', { period: d.toISOString().slice(0, 7) }, master);
    const open = await api(ctx, 'GET', '/master/invoices?status=open', undefined, master);
    expect(open.body.invoices).toHaveLength(1);
    const r = await api(ctx, 'POST', `/master/invoices/${open.body.invoices[0].id}/mark-paid`, {}, master);
    expect(r.status).toBe(200);
    expect(r.body.invoice.paid_by).toBe('manual');
    expect((await api(ctx, 'GET', '/master/invoices', undefined, admin)).status).toBe(403);
  });

  it('suspensão manual do master não é desfeita por pagamento', async () => {
    const t = await one(`SELECT id FROM tenants WHERE slug = 'bauru'`);
    await api(ctx, 'PATCH', `/master/tenants/${t.id}`, { active: false }, master);
    expect((await one(`SELECT suspended_reason FROM tenants WHERE id = $1`, [t.id])).suspended_reason).toBe('manual');
    const tenants = await api(ctx, 'GET', '/master/tenants', undefined, master);
    expect(tenants.body.tenants[0]).toMatchObject({ license_monthly_cents: 49900, mp_connected: true });
    expect(JSON.stringify(tenants.body)).not.toContain('mp_access_token_enc');
    await api(ctx, 'PATCH', `/master/tenants/${t.id}`, { active: true, licenseMonthlyCents: 59900 }, master);
    expect(await one(`SELECT active, suspended_reason, license_monthly_cents FROM tenants WHERE id = $1`, [t.id]))
      .toMatchObject({ active: true, suspended_reason: null, license_monthly_cents: 59900 });
  });
});
