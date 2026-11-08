import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { api, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { setMercadoPagoGateway, type MercadoPagoGateway, type MpPayment } from '../src/lib/mercadopago.js';
import { generateCommissionInvoices } from '../src/lib/commissions.js';
import { runBillingJobs } from '../src/lib/billing.js';

const CITY_TOKEN = 'APP_USR-5555555555555555-cidade-bauru-comissao-0000000';
const payments = new Map<string, MpPayment & { token: string }>();
const prefs: any[] = [];
let next = 8_000_000_001;
const fake: MercadoPagoGateway = {
  async createPreference(token, p) { prefs.push({ token, p }); return { id: `pref-${prefs.length}`, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${prefs.length}` }; },
  async getPayment(token, id) { const x = payments.get(id); if (!x || x.token !== token) throw new Error('404'); return x; },
  async findPaymentsByReference(token, ref) { return [...payments.values()].filter((x) => x.token === token && x.external_reference === ref); },
  async getAccount(token) { if (token === CITY_TOKEN) return { id: '1', nickname: 'CIDADE', site_id: 'MLB' }; throw new Error('401'); },
  async createPixPayment() { throw new Error('não usado'); },
};

let ctx: Ctx;
let admin: string, ana: string, anaId: string, mariaId: string, tenantId: string;
let weekStart: string;

beforeAll(async () => {
  ctx = await startServer();
  setMercadoPagoGateway(fake);
  admin = await login(ctx, '14900000001');
  ana = await login(ctx, '14900000021'); // plano Livre (10%)
  anaId = (await one(`SELECT id, tenant_id FROM users WHERE phone = '14900000021'`)).id;
  mariaId = (await one(`SELECT id FROM users WHERE phone = '14900000010'`)).id;
  tenantId = (await one(`SELECT id FROM tenants WHERE slug = 'bauru'`)).id;
  weekStart = (await one(`SELECT (date_trunc('week', now()) - interval '7 days')::date::text AS d`)).d;
  await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, ana);
});
afterAll(async () => { setMercadoPagoGateway(null); await stopServer(ctx); });

/** corrida finalizada direto no banco (a finalização normal já grava a comissão; aqui só montamos o cenário) */
async function ride(method: string, priceCents: number, commissionCents: number, completedAt: string) {
  return (await one(
    `INSERT INTO rides (tenant_id, passenger_id, driver_id, category_code, status, origin_lat, origin_lng, origin_address,
                        dest_lat, dest_lng, dest_address, distance_km, duration_min, price_cents, payment_method,
                        boarding_code, share_token, commission_cents, completed_at)
     VALUES ($1,$2,$3,'carro','completed',-22.32,-49.08,'Centro',-22.34,-49.05,'Bairro',5,12,$4,$5,'1234',$6,$7,$8::timestamptz)
     RETURNING id`,
    [tenantId, mariaId, anaId, priceCents, method, randomBytes(9).toString('base64url'), commissionCents, completedAt],
  )).id as string;
}

describe('comissão do plano Livre', () => {
  it('fecha a semana só com as corridas pagas direto ao motorista', async () => {
    const day = `${weekStart} 15:00`;
    await ride('cash', 2500, 250, day);
    await ride('pix', 1800, 180, day);
    await ride('card', 3000, 300, day);
    await ride('convenio', 4000, 400, day);       // a central paga e repassa já sem a comissão
    await ride('cash', 2000, 0, day);             // plano sem comissão
    const thisWeek = await ride('cash', 1000, 100, new Date().toISOString()); // semana atual: fica para a próxima

    let c = await api(ctx, 'GET', '/driver/commissions', undefined, ana);
    expect(c.body.pendingCents).toBe(830);

    const created = await generateCommissionInvoices(weekStart);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ rides: 3, gross_cents: 7300, amount_cents: 730, status: 'open' });
    // rodar de novo não duplica
    expect(await generateCommissionInvoices(weekStart)).toHaveLength(0);
    expect((await runBillingJobs()).commissions).toBe(0);
    expect((await one('SELECT commission_invoice_id FROM rides WHERE id = $1', [thisWeek])).commission_invoice_id).toBeNull();

    c = await api(ctx, 'GET', '/driver/commissions', undefined, ana);
    expect(c.body.pendingCents).toBe(100);
    expect(c.body.invoices[0]).toMatchObject({ amount_cents: 730, status: 'open', overdue: false });
  });

  it('o repasse da central já vem sem a comissão', async () => {
    const e = await api(ctx, 'GET', '/driver/earnings?days=30', undefined, ana);
    expect(e.body.toReceiveFromCentralCents).toBe(3600);
  });

  it('vencida, o motorista não recebe corridas; paga pelo app e volta a trabalhar', async () => {
    expect((await api(ctx, 'POST', '/driver/online', { online: true }, ana)).status).toBe(200);
    await api(ctx, 'POST', '/driver/online', { online: false }, ana);
    await query(`UPDATE commission_invoices SET due_date = current_date - 1 WHERE driver_id = $1`, [anaId]);

    const me = await api(ctx, 'GET', '/driver/me', undefined, ana);
    expect(me.body.canWork).toBe(false);
    expect(me.body.blockedReason).toContain('Comissão da semana vencida');
    expect((await api(ctx, 'POST', '/driver/online', { online: true }, ana)).status).toBe(403);

    const inv = (await api(ctx, 'GET', '/driver/commissions', undefined, ana)).body.invoices[0];
    // cidade sem Mercado Pago: paga na central
    let r = await api(ctx, 'POST', `/driver/commissions/${inv.id}/checkout`, {}, ana);
    expect(r.body.code).toBe('mercadopago_nao_configurado');

    expect((await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: CITY_TOKEN }, admin)).status).toBe(200);
    r = await api(ctx, 'POST', `/driver/commissions/${inv.id}/checkout`, {}, ana);
    expect(r.status).toBe(201);
    expect(r.body.amountCents).toBe(730);
    expect(prefs.at(-1).token).toBe(CITY_TOKEN);
    // outra motorista não paga a fatura da Ana
    const joao = await login(ctx, '14900000020');
    expect((await api(ctx, 'POST', `/driver/commissions/${inv.id}/checkout`, {}, joao)).status).toBe(404);

    const id = String(next++);
    payments.set(id, { id, token: CITY_TOKEN, status: 'approved', external_reference: r.body.chargeId, transaction_amount: 7.3, currency_id: 'BRL' });
    const s = await api(ctx, 'POST', '/driver/subscription/sync', {}, ana);
    expect(s.body.applied).toBe(true);

    const after = await one('SELECT status, paid_by FROM commission_invoices WHERE id = $1', [inv.id]);
    expect(after).toMatchObject({ status: 'paid', paid_by: 'mercadopago' });
    expect((await api(ctx, 'GET', '/driver/me', undefined, ana)).body.canWork).toBe(true);
  });

  it('a central registra o pagamento recebido por fora ou cancela com motivo', async () => {
    const next = (await one(`SELECT (date_trunc('week', now()))::date::text AS d`)).d; // semana atual
    const [inv] = await generateCommissionInvoices(next);
    expect(inv.amount_cents).toBe(100);

    let list = await api(ctx, 'GET', '/admin/commissions', undefined, admin);
    expect(list.body.invoices.map((i: any) => i.id)).toContain(inv.id);
    expect(list.body.totals.open_cents).toBe(100);
    expect(list.body.invoices[0].driver_name).toBe('Ana Motorista');

    expect((await api(ctx, 'POST', `/admin/commissions/${inv.id}/cancel`, {}, admin)).status).toBe(400);
    const paid = await api(ctx, 'POST', `/admin/commissions/${inv.id}/mark-paid`, { note: 'Pix direto' }, admin);
    expect(paid.body.invoice).toMatchObject({ status: 'paid', paid_by: 'central' });
    expect((await api(ctx, 'POST', `/admin/commissions/${inv.id}/mark-paid`, {}, admin)).status).toBe(404);
    expect((await api(ctx, 'POST', `/admin/commissions/${inv.id}/mark-paid`, {}, ana)).status).toBe(403);

    list = await api(ctx, 'GET', '/admin/commissions?status=paid', undefined, admin);
    expect(list.body.invoices).toHaveLength(2);
    expect(list.body.totals.paid_month_cents).toBe(830);
  });

  it('relatório do convênio: só o licenciado vê o repasse sem a comissão', async () => {
    const acc = await one(`SELECT id FROM accounts WHERE kind = 'prefeitura' LIMIT 1`);
    const pt = await one(`SELECT id FROM patients WHERE account_id = $1 LIMIT 1`, [acc.id]);
    const r = await one(`SELECT id FROM rides WHERE payment_method = 'convenio' AND driver_id = $1`, [anaId]);
    await query(`UPDATE rides SET account_id = $2, patient_id = $3, completed_at = now() WHERE id = $1`, [r.id, acc.id, pt.id]);
    const adm = await api(ctx, 'GET', `/admin/accounts/${acc.id}/report`, undefined, admin);
    expect(adm.body.byDriver[0]).toMatchObject({ totalCents: 4000, commissionCents: 400, netCents: 3600 });
    const saude = await login(ctx, '14900000030');
    const op = await api(ctx, 'GET', '/account/report', undefined, saude);
    expect(op.body.byDriver[0].netCents).toBeUndefined();
    expect(op.body.rows[0].commission_cents).toBeUndefined();
  });
});
