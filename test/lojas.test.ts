import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, centro, destino, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { setMercadoPagoGateway, type MercadoPagoGateway, type MpPayment } from '../src/lib/mercadopago.js';
import { autoConfirmCod, generateStoreInvoices } from '../src/lib/stores.js';
import { drainWebhooks } from '../src/routes/billing.js';

// ---------- Mercado Pago simulado ----------
const CITY_TOKEN = 'APP_USR-3333333333333333-cidade-bauru-loja-000000000000';
const STORE_TOKEN = 'APP_USR-4444444444444444-farmacia-central-0000000000';
const payments = new Map<string, { token: string; pay: MpPayment }>();
const prefs: any[] = [];
const pixes: any[] = [];
let next = 7_000_000_001;

const fake: MercadoPagoGateway = {
  async createPreference(token, p) { prefs.push({ token, p }); return { id: `pref-${prefs.length}`, init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${prefs.length}` }; },
  async getPayment(token, id) { const x = payments.get(id); if (!x || x.token !== token) throw new Error('404'); return x.pay; },
  async findPaymentsByReference(token, ref) { return [...payments.values()].filter((x) => x.token === token && x.pay.external_reference === ref).map((x) => x.pay); },
  async getAccount(token) { if (token === CITY_TOKEN || token === STORE_TOKEN) return { id: '1', nickname: 'CONTA', site_id: 'MLB' }; throw new Error('401'); },
  async createPixPayment(token, p) {
    const id = String(next++);
    pixes.push({ token, p, id });
    payments.set(id, { token, pay: { id, status: 'pending', external_reference: p.externalReference, transaction_amount: p.amountCents / 100, currency_id: 'BRL' } });
    return { id, status: 'pending', qrCode: `00020126PIX-COPIA-E-COLA-${id}`, qrCodeBase64: 'iVBORw0KGgo=' };
  },
};
const pay = (token: string, ref: string, amount: number) => {
  const id = String(next++);
  payments.set(id, { token, pay: { id, status: 'approved', external_reference: ref, transaction_amount: amount, currency_id: 'BRL' } });
  return id;
};
const notify = async (ctx: Ctx, path: string, id: string) => {
  const res = await fetch(`${ctx.base}${path}?data.id=${id}&type=payment`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'payment', data: { id } }),
  });
  await drainWebhooks();
  return res.status;
};

let ctx: Ctx;
let loja: string, admin: string, carlos: string, maria: string;
let lojaId: string, carlosId: string;
const balance = async () => (await one('SELECT balance_cents FROM accounts WHERE id = $1', [lojaId])).balance_cents as number;
const pedido = (extra: Record<string, unknown> = {}) => ({
  destination: { ...destino, name: 'Cliente Lúcia' }, recipientName: 'Lúcia Cliente', recipientPhone: '14933332222',
  packageDesc: 'Remédios', ...extra,
});

/** motoboy coleta: aceita, chega, fotografa e inicia com o código de coleta */
async function coletar(id: string, code: string) {
  expect((await api(ctx, 'POST', `/rides/${id}/accept`, {}, carlos)).status).toBe(200);
  await api(ctx, 'POST', `/rides/${id}/arrived`, {}, carlos);
  await api(ctx, 'POST', `/rides/${id}/pickup-photo`, { image: fakeSelfie }, carlos);
  expect((await api(ctx, 'POST', `/rides/${id}/start`, { boardingCode: code }, carlos)).status).toBe(200);
  await api(ctx, 'POST', `/rides/${id}/dropoff-photo`, { image: fakeSelfie }, carlos);
}

beforeAll(async () => {
  setMercadoPagoGateway(fake);
  ctx = await startServer();
  [loja, admin, carlos, maria] = await Promise.all([
    login(ctx, '14900000040'), login(ctx, '14900000001'), login(ctx, '14900000022'), login(ctx, '14900000010'),
  ]);
  lojaId = (await one(`SELECT id FROM accounts WHERE name = 'Farmácia Central'`)).id;
  carlosId = (await one(`SELECT id FROM users WHERE phone = '14900000022'`)).id;
  await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, carlos);
  await api(ctx, 'POST', '/driver/online', { online: true }, carlos);
  await api(ctx, 'POST', '/driver/location', { lat: -22.326, lng: -49.071 }, carlos);
});
afterAll(async () => { setMercadoPagoGateway(null); await stopServer(ctx); });

describe('conta loja: frete com créditos', () => {
  it('a loja vê saldo, desconto e Pix conferido', async () => {
    const r = await api(ctx, 'GET', '/account/store', undefined, loja);
    expect(r.body.store).toMatchObject({ name: 'Farmácia Central', billingMode: 'prepago', balanceCents: 10000, discountPct: 10, pix: { validated: true } });
    // as rotas de pacientes são só da Prefeitura
    expect((await api(ctx, 'GET', '/account/patients', undefined, loja)).status).toBe(404);
  });

  it('frete com o desconto da loja, debitado na hora e devolvido se cancelar antes da coleta', async () => {
    const q = await api(ctx, 'POST', '/account/deliveries/quote', { destination: destino }, loja);
    expect(q.body.priceCents).toBe(Math.max(100, Math.round((q.body.fullPriceCents * 0.9) / 10) * 10));
    const r = await api(ctx, 'POST', '/account/deliveries', pedido(), loja);
    expect(r.status).toBe(201);
    const d = r.body.delivery;
    expect(d).toMatchObject({ kind: 'entrega', paymentMethod: 'conta_loja', priceCents: q.body.priceCents });
    expect(d.deliveryCode).toMatch(/^\d{4}$/);
    expect(d.boardingCode).toMatch(/^\d{4}$/);
    expect(d.destination.address).toContain('Cliente Lúcia');
    expect(await balance()).toBe(10000 - q.body.priceCents);
    expect((await one(`SELECT 1 AS ok FROM ride_offers WHERE ride_id = $1 AND driver_id = $2`, [d.id, carlosId]))).toBeTruthy();

    const c = await api(ctx, 'POST', `/account/deliveries/${d.id}/cancel`, {}, loja);
    expect(c.body.refunded).toBe(true);
    expect(await balance()).toBe(10000);
    const kinds = (await query(`SELECT kind FROM account_ledger WHERE ride_id = $1 ORDER BY id`, [d.id])).map((x) => x.kind);
    expect(kinds).toEqual(['entrega', 'estorno']);
  });

  it('sem saldo suficiente, não pede', async () => {
    await api(ctx, 'POST', `/admin/accounts/${lojaId}/adjust`, { amountCents: -9950, note: 'teste de saldo' }, admin);
    const r = await api(ctx, 'POST', '/account/deliveries', pedido(), loja);
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('saldo_insuficiente');
    await api(ctx, 'POST', `/admin/accounts/${lojaId}/adjust`, { amountCents: 9950, note: 'volta o saldo' }, admin);
  });

  it('recarga pelo Mercado Pago da central entra no saldo', async () => {
    const sem = await api(ctx, 'POST', '/account/store/recharge', { amountCents: 5000 }, loja);
    expect(sem.body.code).toBe('mercadopago_nao_configurado');
    await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: CITY_TOKEN }, admin);
    const r = await api(ctx, 'POST', '/account/store/recharge', { amountCents: 5000 }, loja);
    expect(r.status).toBe(201);
    expect(prefs.at(-1).token).toBe(CITY_TOKEN);
    expect(prefs.at(-1).p.notificationUrl).toMatch(/\/webhooks\/mercadopago\/t\/bauru$/);
    expect(prefs.at(-1).p.backUrl).toMatch(/k=loja$/);
    const before = await balance();
    const id = pay(CITY_TOKEN, r.body.chargeId, 50);
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', id)).toBe(200);
    expect(await balance()).toBe(before + 5000);
    expect(await notify(ctx, '/webhooks/mercadopago/t/bauru', id)).toBe(200); // repetido: não soma de novo
    expect(await balance()).toBe(before + 5000);
  });
});

describe('cobrança do produto na entrega', () => {
  it('Pix pela chave da loja: o motoboy confirma, a loja confere, e só entrega depois de cobrar', async () => {
    const r = await api(ctx, 'POST', '/account/deliveries', pedido({ codAmountCents: 4590 }), loja);
    const d = r.body.delivery;
    expect(d.cod).toMatchObject({ amountCents: 4590, method: null, status: 'pendente', confirmBy: null });
    await coletar(d.id, d.boardingCode);

    const pix = await api(ctx, 'POST', `/rides/${d.id}/cod/pix`, {}, carlos);
    expect(pix.body).toMatchObject({ method: 'pix_chave', pixKey: 'farmacia@central.com.br', holderName: 'Farmácia Central Ltda', amountCents: 4590 });
    const cedo = await api(ctx, 'POST', `/rides/${d.id}/complete`, { deliveryCode: d.deliveryCode }, carlos);
    expect(cedo.body.code).toBe('cobranca_pendente');
    expect((await api(ctx, 'POST', `/rides/${d.id}/cod/confirm`, { method: 'pix_chave' }, carlos)).body.status).toBe('aguardando_loja');
    expect((await api(ctx, 'POST', `/rides/${d.id}/complete`, { deliveryCode: d.deliveryCode }, carlos)).status).toBe(200);

    const conf = await api(ctx, 'POST', `/account/deliveries/${d.id}/cod-confirm`, { received: true }, loja);
    expect(conf.body.codStatus).toBe('confirmado');
    const earn = await api(ctx, 'GET', '/driver/earnings', undefined, carlos);
    expect(earn.body.toReceiveFromCentralCents).toBe(d.priceCents); // frete pago pela loja à central
  });

  it('maquininha sem resposta da loja em 24 h: conta como recebido', async () => {
    const r = await api(ctx, 'POST', '/account/deliveries', pedido({ codAmountCents: 3000 }), loja);
    const d = r.body.delivery;
    await coletar(d.id, d.boardingCode);
    await api(ctx, 'POST', `/rides/${d.id}/cod/confirm`, { method: 'maquininha' }, carlos);
    await api(ctx, 'POST', `/rides/${d.id}/complete`, { deliveryCode: d.deliveryCode }, carlos);

    let list = await api(ctx, 'GET', '/account/deliveries', undefined, loja);
    let item = list.body.deliveries.find((x: any) => x.id === d.id);
    expect(item.cod.status).toBe('aguardando_loja');
    const hours = (new Date(item.cod.confirmBy).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    expect(await autoConfirmCod()).toBe(0); // ainda no prazo
    await query(`UPDATE rides SET cod_paid_at = now() - interval '25 hours' WHERE id = $1`, [d.id]);
    expect(await autoConfirmCod()).toBe(1);
    // conferida, sai das ativas e fica no histórico do dia
    list = await api(ctx, 'GET', '/account/deliveries', undefined, loja);
    expect(list.body.deliveries.find((x: any) => x.id === d.id)).toBeUndefined();
    list = await api(ctx, 'GET', '/account/deliveries?view=dia', undefined, loja);
    item = list.body.deliveries.find((x: any) => x.id === d.id);
    expect(item.cod).toMatchObject({ status: 'confirmado', settledBy: 'automatico', confirmBy: null });
    // fechado: a loja não muda mais
    expect((await api(ctx, 'POST', `/account/deliveries/${d.id}/cod-confirm`, { received: false }, loja)).status).toBe(409);
  });

  it('Pix gerado no Mercado Pago da loja: confirma sozinho quando o cliente paga', async () => {
    const con = await api(ctx, 'PUT', '/account/store/mercadopago', { accessToken: STORE_TOKEN }, loja);
    expect(con.body.connected).toBe(true);
    const r = await api(ctx, 'POST', '/account/deliveries', pedido({ codAmountCents: 12000 }), loja);
    const d = r.body.delivery;
    await coletar(d.id, d.boardingCode);

    const pix = await api(ctx, 'POST', `/rides/${d.id}/cod/pix`, {}, carlos);
    expect(pix.body).toMatchObject({ method: 'pix_mp', status: 'pendente', amountCents: 12000 });
    expect(pix.body.qrCode).toContain('PIX-COPIA-E-COLA');
    const gerado = pixes.at(-1);
    expect(gerado.token).toBe(STORE_TOKEN); // o dinheiro cai na conta da loja
    expect(gerado.p.notificationUrl).toMatch(new RegExp(`/webhooks/mercadopago/loja/${lojaId}$`));
    // de novo: não gera outro Pix
    await api(ctx, 'POST', `/rides/${d.id}/cod/pix`, {}, carlos);
    expect(pixes.length).toBe(1);
    // com Pix do Mercado Pago, o motoboy não pode "confirmar na mão"
    expect((await api(ctx, 'POST', `/rides/${d.id}/cod/confirm`, { method: 'pix_chave' }, carlos)).status).toBe(409);
    expect((await api(ctx, 'POST', `/rides/${d.id}/complete`, { deliveryCode: d.deliveryCode }, carlos)).body.code).toBe('cobranca_pendente');

    payments.get(gerado.id)!.pay.status = 'approved';
    expect(await notify(ctx, `/webhooks/mercadopago/loja/${lojaId}`, gerado.id)).toBe(200);
    expect((await api(ctx, 'GET', `/rides/${d.id}/cod`, undefined, carlos)).body.status).toBe('pago');
    expect((await api(ctx, 'POST', `/rides/${d.id}/complete`, { deliveryCode: d.deliveryCode }, carlos)).status).toBe(200);
  });

  it('maquininha da loja também vale', async () => {
    const r = await api(ctx, 'POST', '/account/deliveries', pedido({ codAmountCents: 3000 }), loja);
    const d = r.body.delivery;
    await coletar(d.id, d.boardingCode);
    expect((await api(ctx, 'POST', `/rides/${d.id}/cod/confirm`, { method: 'maquininha' }, carlos)).body.method).toBe('maquininha');
    expect((await api(ctx, 'POST', `/rides/${d.id}/complete`, { deliveryCode: d.deliveryCode }, carlos)).status).toBe(200);
    const nao = await api(ctx, 'POST', `/account/deliveries/${d.id}/cod-confirm`, { received: false }, loja);
    expect(nao.body.codStatus).toBe('contestado'); // vai para a central resolver
  });
});

describe('conta loja: fatura semanal', () => {
  let op: string, storeId: string;

  it('a central cria uma loja com fatura e limite', async () => {
    const c = await api(ctx, 'POST', '/admin/accounts', {
      name: 'Pizzaria Bom Sabor', kind: 'loja', billingMode: 'fatura', creditLimitCents: 2500,
      address: { ...centro, address: 'Rua Araújo Leite, 500, Centro' },
      operator: { name: 'Caixa da Pizzaria', phone: '14955556666', password: 'pizza1234' },
    }, admin);
    expect(c.status).toBe(201);
    storeId = c.body.account.id;
    op = await login(ctx, '14955556666', 'bauru', 'pizza1234');
    const l = await api(ctx, 'GET', '/admin/accounts?kind=loja', undefined, admin);
    expect(l.body.accounts.map((a: any) => a.name).sort()).toEqual(['Cantina da Praça', 'Farmácia Central', 'Pizzaria Bom Sabor']);
    expect(JSON.stringify(l.body)).not.toContain('mp_access_token_enc');
  });

  it('pede no fiado até o limite; a fatura fecha a semana; vencida bloqueia; paga libera', async () => {
    const a = await api(ctx, 'POST', '/account/deliveries', pedido(), op);
    expect(a.status).toBe(201);
    let n = 1;
    let r = a;
    while (r.status === 201 && n < 10) { r = await api(ctx, 'POST', '/account/deliveries', pedido(), op); n++; }
    expect(r.body.code).toBe('limite_atingido');

    const week = (await one(`SELECT date_trunc('week', now())::date::text AS d`)).d;
    const created = await generateStoreInvoices(week);
    expect(created).toHaveLength(1);
    const inv = created[0];
    const bal = (await one('SELECT balance_cents FROM accounts WHERE id = $1', [storeId])).balance_cents;
    expect(inv.total_cents).toBe(-bal);

    await query(`UPDATE store_invoices SET due_date = current_date - 1 WHERE id = $1`, [inv.id]);
    expect((await api(ctx, 'POST', '/account/deliveries', pedido(), op)).body.code).toBe('fatura_vencida');

    const pago = await api(ctx, 'POST', `/admin/store-invoices/${inv.id}/mark-paid`, {}, admin);
    expect(pago.status).toBe(200);
    expect((await one('SELECT balance_cents FROM accounts WHERE id = $1', [storeId])).balance_cents).toBe(0);
    expect((await api(ctx, 'POST', '/account/deliveries', pedido(), op)).status).toBe(201);
  });
});

describe('fotos', () => {
  it('sem foto do motorista e do veículo aprovadas, o motorista não trabalha', async () => {
    const reg = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true,
      tenant: 'bauru', name: 'Rafael Novo', phone: '14977778888', password: 'rafa1234', role: 'driver',
      driver: { vehicleType: 'moto', vehicle: { plate: 'BAU5E67', model: 'Fan 160', color: 'Preta' }, plan: 'livre' },
    });
    const rafa = reg.body.token;
    const rafaId = reg.body.user.id;
    await api(ctx, 'PATCH', `/admin/drivers/${rafaId}`, { cnhEarOk: true, inssOk: true, criminalRecordOk: true, insuranceAppOk: true, status: 'approved' }, admin);
    await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, rafa);
    let on = await api(ctx, 'POST', '/driver/online', { online: true }, rafa);
    expect(on.status).toBe(403);
    expect(on.body.error).toBe('Envie sua foto e a foto do veículo pelo app');

    expect((await api(ctx, 'POST', '/driver/photos', { which: 'perfil', image: fakeSelfie }, rafa)).body.photoStatus).toBe('pending');
    // só a do perfil não basta para aprovar
    expect((await api(ctx, 'PATCH', `/admin/drivers/${rafaId}`, { photoApproved: true }, admin)).body.code).toBe('fotos_faltando');
    await api(ctx, 'POST', '/driver/photos', { which: 'veiculo', image: fakeSelfie }, rafa);
    on = await api(ctx, 'POST', '/driver/online', { online: true }, rafa);
    expect(on.body.error).toBe('Suas fotos estão em análise pela central');

    await api(ctx, 'PATCH', `/admin/drivers/${rafaId}`, { photoApproved: false }, admin);
    expect((await api(ctx, 'POST', '/driver/online', { online: true }, rafa)).body.error).toContain('recusou suas fotos');

    await api(ctx, 'POST', '/driver/photos', { which: 'perfil', image: fakeSelfie }, rafa);
    await api(ctx, 'POST', '/driver/photos', { which: 'veiculo', image: fakeSelfie }, rafa);
    const ap = await api(ctx, 'PATCH', `/admin/drivers/${rafaId}`, { photoApproved: true }, admin);
    expect(ap.body.driver).toMatchObject({ photoStatus: 'approved', hasPhoto: true, hasVehiclePhoto: true, pendingPhoto: false });
    expect((await api(ctx, 'POST', '/driver/online', { online: true }, rafa)).status).toBe(200);
    await api(ctx, 'POST', '/driver/online', { online: false }, rafa);
  });

  it('o passageiro, o link da família, a loja e a Saúde veem a foto aprovada', async () => {
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, category: 'moto', paymentMethod: 'pix' }, maria);
    const id = r.body.ride.id;
    expect((await api(ctx, 'POST', `/rides/${id}/accept`, {}, carlos)).status).toBe(200);
    const view = await api(ctx, 'GET', `/rides/${id}`, undefined, maria);
    expect(view.body.ride.driver).toMatchObject({ hasPhoto: true, hasVehiclePhoto: true });
    expect((await fetch(`${ctx.base}/rides/${id}/driver-photo`, { headers: { authorization: `Bearer ${maria}` } })).status).toBe(200);
    expect((await fetch(`${ctx.base}/rides/${id}/driver-photo?which=veiculo`, { headers: { authorization: `Bearer ${maria}` } })).status).toBe(200);

    // troca de foto: continua trabalhando, e o cliente vê a aprovada até a central conferir a nova
    const troca = await api(ctx, 'POST', '/driver/photos', { which: 'perfil', image: fakeSelfie }, carlos);
    expect(troca.body).toEqual({ photoStatus: 'approved', photoReview: 'pending' });
    expect((await api(ctx, 'GET', '/driver/me', undefined, carlos)).body.canWork).toBe(true);
    const det = await api(ctx, 'GET', `/admin/drivers/${carlosId}`, undefined, admin);
    expect(det.body.driver).toMatchObject({ photoReview: 'pending', pendingPhoto: true });
    expect((await fetch(`${ctx.base}/admin/drivers/${carlosId}/photo?versao=nova`, { headers: { authorization: `Bearer ${admin}` } })).status).toBe(200);

    // link da família também mostra a foto, só durante a corrida
    const share = await api(ctx, 'GET', `/public/share/${view.body.ride.shareToken}`);
    expect(share.body.driver.hasPhoto).toBe(true);
    expect((await fetch(`${ctx.base}/public/share/${view.body.ride.shareToken}/photo/perfil`)).status).toBe(200);
    await api(ctx, 'POST', `/rides/${id}/cancel`, {}, maria);
    expect((await fetch(`${ctx.base}/public/share/${view.body.ride.shareToken}/photo/perfil`)).status).toBe(404);

    // loja: foto do motoboy que vai buscar o pacote
    const d = (await api(ctx, 'POST', '/account/deliveries', pedido(), loja)).body.delivery;
    const semMotoboy = await fetch(`${ctx.base}/account/trips/${d.id}/driver-photo`, { headers: { authorization: `Bearer ${loja}` } });
    expect(semMotoboy.status).toBe(404);
    await api(ctx, 'POST', `/rides/${d.id}/accept`, {}, carlos);
    const lista = await api(ctx, 'GET', '/account/deliveries', undefined, loja);
    expect(lista.body.deliveries.find((x: any) => x.id === d.id).driver).toMatchObject({ name: 'Carlos Motoboy', hasPhoto: true });
    expect((await fetch(`${ctx.base}/account/trips/${d.id}/driver-photo`, { headers: { authorization: `Bearer ${loja}` } })).status).toBe(200);
    expect((await fetch(`${ctx.base}/account/trips/${d.id}/driver-photo?which=veiculo`, { headers: { authorization: `Bearer ${loja}` } })).status).toBe(200);
    // outra conta não vê
    const saude = await login(ctx, '14900000030');
    expect((await fetch(`${ctx.base}/account/trips/${d.id}/driver-photo`, { headers: { authorization: `Bearer ${saude}` } })).status).toBe(404);
    await api(ctx, 'POST', `/account/deliveries/${d.id}/cancel`, {}, loja);
    await api(ctx, 'PATCH', `/admin/drivers/${carlosId}`, { photoApproved: true }, admin);
  });

  it('comprovante de entrega e logo da loja no link de quem recebe', async () => {
    await api(ctx, 'PUT', '/account/store/logo', { image: fakeSelfie }, loja);
    const r = await api(ctx, 'POST', '/account/deliveries', pedido(), loja);
    const d = r.body.delivery;
    await coletar(d.id, d.boardingCode);
    expect((await api(ctx, 'POST', `/rides/${d.id}/complete`, { deliveryCode: d.deliveryCode }, carlos)).status).toBe(200);
    const share = await api(ctx, 'GET', `/public/share/${d.shareToken}`);
    expect(share.body).toMatchObject({ hasDropoffPhoto: true, store: { name: 'Farmácia Central', hasLogo: true } });
    expect((await fetch(`${ctx.base}/public/share/${d.shareToken}/photo/entrega`)).status).toBe(200);
    expect((await fetch(`${ctx.base}/public/share/${d.shareToken}/photo/logo`)).status).toBe(200);
    expect((await fetch(`${ctx.base}/rides/${d.id}/dropoff-photo`, { headers: { authorization: `Bearer ${loja}` } })).status).toBe(200);
  });

  it('Frete exige foto da carga na saída e na chegada', async () => {
    const pedro = await login(ctx, '14900000023');
    await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, pedro);
    await api(ctx, 'POST', '/driver/online', { online: true }, pedro);
    await api(ctx, 'POST', '/driver/location', { lat: -22.325, lng: -49.088 }, pedro);
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, category: 'frete', paymentMethod: 'cash' }, maria);
    const id = r.body.ride.id;
    await api(ctx, 'POST', `/rides/${id}/accept`, {}, pedro);
    expect((await api(ctx, 'POST', `/rides/${id}/start`, { boardingCode: r.body.ride.boardingCode }, pedro)).body.code).toBe('sem_foto');
    await api(ctx, 'POST', `/rides/${id}/pickup-photo`, { image: fakeSelfie }, pedro);
    expect((await api(ctx, 'POST', `/rides/${id}/start`, { boardingCode: r.body.ride.boardingCode }, pedro)).status).toBe(200);
    expect((await api(ctx, 'POST', `/rides/${id}/complete`, {}, pedro)).body.code).toBe('sem_foto_entrega');
    await api(ctx, 'POST', `/rides/${id}/dropoff-photo`, { image: fakeSelfie }, pedro);
    expect((await api(ctx, 'POST', `/rides/${id}/complete`, {}, pedro)).status).toBe(200);
    const view = await api(ctx, 'GET', `/rides/${id}`, undefined, maria);
    expect(view.body.ride.photos).toEqual({ pickup: true, dropoff: true });
  });
});
