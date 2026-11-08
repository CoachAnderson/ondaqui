import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { pushOutbox } from '../src/lib/push.js';
import { setMercadoPagoGateway, type MercadoPagoGateway, type MpPayment } from '../src/lib/mercadopago.js';
import { ensureSchoolTrips } from '../src/lib/escola.js';

const CITY_TOKEN = 'APP_USR-7777777777777777-cidade-bauru-escola-000000000';
const payments = new Map<string, MpPayment & { token: string }>();
let next = 9_500_000_001;
const fake: MercadoPagoGateway = {
  async createPreference(_t, p) { return { id: 'pref-escola', init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${p.externalReference}` }; },
  async getPayment(token, id) { const x = payments.get(id); if (!x || x.token !== token) throw new Error('404'); return x; },
  async findPaymentsByReference(token, ref) { return [...payments.values()].filter((x) => x.token === token && x.external_reference === ref); },
  async getAccount(token) { if (token === CITY_TOKEN) return { id: '1', nickname: 'CIDADE', site_id: 'MLB' }; throw new Error('401'); },
  async createPixPayment() { throw new Error('não usado'); },
};

let ctx: Ctx;
let admin: string, maria: string, joao: string, ana: string, joaoId: string, anaId: string, mariaId: string;
let schoolId: string, contractId: string, monday: string;
const casa = { lat: -22.3150, lng: -49.0650, address: 'Rua Gustavo Maciel, 300, Bauru' };

beforeAll(async () => {
  setMercadoPagoGateway(fake);
  ctx = await startServer();
  [admin, maria, joao, ana] = await Promise.all([login(ctx, '14900000001'), login(ctx, '14900000010'), login(ctx, '14900000020'), login(ctx, '14900000021')]);
  joaoId = (await one(`SELECT id FROM users WHERE phone = '14900000020'`)).id;
  anaId = (await one(`SELECT id FROM users WHERE phone = '14900000021'`)).id;
  mariaId = (await one(`SELECT id FROM users WHERE phone = '14900000010'`)).id;
  // próxima segunda-feira (dia de aula garantido, qualquer que seja o dia em que o teste roda)
  monday = (await one(`SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date + (8 - extract(isodow FROM (now() AT TIME ZONE 'America/Sao_Paulo')::date))::int)::text AS d`)).d;
  for (const t of [maria, joao]) {
    await api(ctx, 'POST', '/me/push-token', { token: `ExponentPushToken[escola-${t.slice(-12).replace(/[^A-Za-z0-9]/g, 'x')}]`, platform: 'android' }, t);
  }
});
afterAll(async () => { setMercadoPagoGateway(null); await stopServer(ctx); });
beforeEach(() => { pushOutbox.length = 0; });

const pedido = (extra: Record<string, unknown> = {}) => ({
  schoolId, home: casa, legs: 'ida_volta', weekdays: [1, 2, 3, 4, 5], pickupTime: '06:40', returnTime: '12:10',
  studentName: 'Pedro Souza', grade: '5º ano B', notes: 'Entregar só para a avó Lúcia', consent: true, ...extra,
});

describe('Daqui Escola: configuração', () => {
  it('vem desligado', async () => {
    expect((await api(ctx, 'GET', '/escola', undefined, maria)).body.rules.enabled).toBe(false);
  });

  it('a central liga, cadastra a escola e libera o motorista para escolar', async () => {
    const r = await api(ctx, 'PATCH', '/admin/escola', { enabled: true, baseCents: 15000, perKmCents: 3000, commissionPct: 10, graceDays: 5 }, admin);
    expect(r.body.rules).toMatchObject({ enabled: true, baseCents: 15000, perKmCents: 3000, commissionPct: 10 });
    const s = await api(ctx, 'POST', '/admin/escola/schools', { name: 'EE Ernesto Monte', place: { lat: -22.3300, lng: -49.0700, address: 'Rua Araújo Leite, 500, Bauru' } }, admin);
    expect(s.status).toBe(201);
    schoolId = s.body.school.id;
    expect((await api(ctx, 'PATCH', `/admin/drivers/${joaoId}`, { verified: ['escolar'] }, admin)).status).toBe(200);
    const adm = (await api(ctx, 'GET', '/admin/escola', undefined, admin)).body;
    expect(adm.drivers.map((d: any) => d.name)).toEqual(['João Motorista']);
    expect((await api(ctx, 'PATCH', '/admin/escola', { enabled: false }, maria)).status).toBe(403);
  });
});

describe('Daqui Escola: contratar', () => {
  it('os pais veem o preço; sem o consentimento não contrata', async () => {
    const q = await api(ctx, 'POST', '/escola/quote', { schoolId, home: casa, legs: 'ida_volta', weekdays: [1, 2, 3, 4, 5] }, maria);
    expect(q.status).toBe(200);
    expect(q.body.distanceKm).toBeGreaterThan(0);
    expect(q.body.monthlyCents % 100).toBe(0);
    const so = await api(ctx, 'POST', '/escola/quote', { schoolId, home: casa, legs: 'ida', weekdays: [1, 2, 3] }, maria);
    expect(so.body.monthlyCents).toBeLessThan(q.body.monthlyCents);
    let r = await api(ctx, 'POST', '/escola/contracts', pedido({ consent: undefined }), maria);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('responsável');
    r = await api(ctx, 'POST', '/escola/contracts', pedido({ pickupTime: undefined }), maria);
    expect(r.body.code).toBe('sem_horario_ida');
    r = await api(ctx, 'POST', '/escola/contracts', pedido(), maria);
    expect(r.status).toBe(201);
    contractId = r.body.contract.id;
    expect(r.body.contract).toMatchObject({ status: 'solicitado', monthlyCents: q.body.monthlyCents, pickupTime: '06:40', driver: null });
  });

  it('a central escolhe o motorista: só quem é liberado para escolar', async () => {
    let r = await api(ctx, 'POST', `/admin/escola/contracts/${contractId}/assign`, { driverId: anaId }, admin);
    expect(r.body.code).toBe('motorista_nao_escolar');
    r = await api(ctx, 'POST', `/admin/escola/contracts/${contractId}/assign`, { driverId: joaoId, monthlyCents: 29000 }, admin);
    expect(r.status).toBe(200);
    expect(r.body.contract).toMatchObject({ status: 'ativo', monthlyCents: 29000, driver: { name: 'João Motorista' } });
    await new Promise((x) => setTimeout(x, 30));
    expect(pushOutbox.some((m) => m.title === 'Transporte escolar confirmado' && m.body.includes('primeira mensalidade'))).toBe(true);
    expect(pushOutbox.some((m) => m.title === 'Novo aluno no transporte escolar')).toBe(true);
  });

  it('sem pagar, não há viagem; pago pelo Mercado Pago, monta ida e volta no dia de aula', async () => {
    expect(await ensureSchoolTrips(monday)).toBe(0);
    expect((await api(ctx, 'POST', `/escola/contracts/${contractId}/checkout`, {}, maria)).body.code).toBe('mercadopago_nao_configurado');
    await api(ctx, 'PUT', '/admin/mercadopago', { accessToken: CITY_TOKEN }, admin);
    const c = await api(ctx, 'POST', `/escola/contracts/${contractId}/checkout`, {}, maria);
    expect(c.status).toBe(201);
    expect(c.body.amountCents).toBe(29000);
    const id = String(next++);
    payments.set(id, { id, token: CITY_TOKEN, status: 'approved', external_reference: c.body.chargeId, transaction_amount: 290, currency_id: 'BRL' });
    expect((await api(ctx, 'POST', '/escola/sync', {}, maria)).body.applied).toBe(true);
    const v = (await api(ctx, 'GET', '/escola', undefined, maria)).body;
    expect(v.contracts[0].paidUntil).toBeTruthy();
    expect(await ensureSchoolTrips(monday)).toBe(2);
    expect(await ensureSchoolTrips(monday)).toBe(0); // não duplica
    // outro responsável não paga nem vê o contrato da Maria
    const outro = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true, tenant: 'bauru', name: 'Carla Outra', phone: '14966660000', password: 'senha123', role: 'passenger' });
    expect((await api(ctx, 'POST', `/escola/contracts/${contractId}/checkout`, {}, outro.body.token)).status).toBe(404);
    expect((await api(ctx, 'GET', '/escola', undefined, outro.body.token)).body.contracts).toHaveLength(0);
  });

  it('feriado: as viagens do dia saem e não voltam', async () => {
    const r = await api(ctx, 'POST', '/admin/escola/days-off', { from: monday, note: 'Feriado municipal' }, admin);
    expect(r.body.days).toBe(1);
    const t = await query(`SELECT status FROM school_trips WHERE contract_id = $1 AND day = $2::date`, [contractId, monday]);
    expect(t.map((x) => x.status)).toEqual(['cancelado', 'cancelado']);
    await api(ctx, 'DELETE', `/admin/escola/days-off/${monday}`, undefined, admin);
  });
});

describe('Daqui Escola: o dia', () => {
  let ida: string, volta: string;

  beforeAll(async () => {
    // as viagens da segunda viram as de hoje (o motorista só marca as do dia)
    await query(`DELETE FROM school_trips WHERE contract_id = $1 AND day = (now() AT TIME ZONE 'America/Sao_Paulo')::date`, [contractId]);
    await query(`UPDATE school_trips SET day = (now() AT TIME ZONE 'America/Sao_Paulo')::date, status = 'previsto' WHERE contract_id = $1`, [contractId]);
    const t = await query(`SELECT id, leg FROM school_trips WHERE contract_id = $1`, [contractId]);
    ida = t.find((x) => x.leg === 'ida')!.id;
    volta = t.find((x) => x.leg === 'volta')!.id;
  });

  it('o motorista vê a rota do dia com os alunos e o telefone dos pais', async () => {
    const r = (await api(ctx, 'GET', '/driver/escola', undefined, joao)).body;
    expect(r.today.map((t: any) => t.leg)).toEqual(['ida', 'volta']);
    expect(r.today[0]).toMatchObject({ time: '06:40', status: 'previsto', student: { name: 'Pedro Souza', notes: 'Entregar só para a avó Lúcia' }, parent: { name: 'Maria', phone: '14900000010' } });
    expect(r.today[0].from.address).toBe(casa.address);
    expect(r.today[0].to.address).toBe('EE Ernesto Monte');
    expect((await api(ctx, 'GET', '/driver/escola', undefined, ana)).body.today).toHaveLength(0);
  });

  it('embarque e chegada: os pais recebem aviso na hora', async () => {
    expect((await api(ctx, 'POST', `/driver/escola/trips/${ida}/entregue`, {}, joao)).status).toBe(409); // ainda não embarcou
    expect((await api(ctx, 'POST', `/driver/escola/trips/${ida}/embarcou`, {}, ana)).status).toBe(409); // não é a rota dela
    expect((await api(ctx, 'POST', `/driver/escola/trips/${ida}/embarcou`, {}, joao)).status).toBe(200);
    await new Promise((x) => setTimeout(x, 30));
    expect(pushOutbox.some((m) => m.title === 'Pedro embarcou' && m.body.includes('A caminho da escola'))).toBe(true);
    expect((await api(ctx, 'POST', `/driver/escola/trips/${ida}/entregue`, {}, joao)).status).toBe(200);
    await new Promise((x) => setTimeout(x, 30));
    expect(pushOutbox.some((m) => m.title === 'Pedro chegou à escola ✅')).toBe(true);
    const hoje = (await api(ctx, 'GET', '/escola', undefined, maria)).body.today;
    expect(hoje.find((t: any) => t.id === ida)).toMatchObject({ status: 'entregue', driver: { name: 'João' } });
    expect(hoje[0].parent).toBeUndefined();
  });

  it('os pais avisam que não vai na volta; o motorista é avisado', async () => {
    expect((await api(ctx, 'POST', `/escola/trips/${ida}/ausente`, {}, maria)).status).toBe(409); // já aconteceu
    expect((await api(ctx, 'POST', `/escola/trips/${volta}/ausente`, {}, maria)).status).toBe(200);
    await new Promise((x) => setTimeout(x, 30));
    expect(pushOutbox.some((m) => m.title === 'Pedro não vai na volta')).toBe(true);
    expect((await api(ctx, 'POST', `/driver/escola/trips/${volta}/embarcou`, {}, joao)).status).toBe(409);
  });
});

describe('Daqui Escola: dinheiro e encerramento', () => {
  it('pagamento na central e repasse do mês ao motorista, sem a comissão', async () => {
    const r = await api(ctx, 'POST', `/admin/escola/contracts/${contractId}/mark-paid`, { months: 1 }, admin);
    expect(r.status).toBe(200);
    const mes = (await one(`SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS m`)).m;
    const adm = (await api(ctx, 'GET', `/admin/escola?mes=${mes}`, undefined, admin)).body;
    expect(adm.payouts[0]).toMatchObject({ driver_name: 'João Motorista', received_cents: 58000, commission_cents: 5800, amount_cents: 52200, paid_at: null });
    expect((await api(ctx, 'POST', '/admin/escola/payouts', { driverId: joaoId, month: mes }, admin)).status).toBe(200);
    expect((await api(ctx, 'POST', '/admin/escola/payouts', { driverId: joaoId, month: mes }, admin)).status).toBe(409);
  });

  it('a central recusa um pedido que não consegue atender', async () => {
    const c = await api(ctx, 'POST', '/escola/contracts', pedido({ studentName: 'Ana Souza', legs: 'ida', returnTime: undefined }), maria);
    expect((await api(ctx, 'POST', `/admin/escola/contracts/${c.body.contract.id}/refuse`, { note: 'Sem vaga nesse horário' }, admin)).status).toBe(200);
    await new Promise((x) => setTimeout(x, 30));
    expect(pushOutbox.some((m) => m.body.includes('Sem vaga nesse horário'))).toBe(true);
    expect((await api(ctx, 'GET', '/escola', undefined, maria)).body.contracts).toHaveLength(1);
  });

  it('os pais encerram: as próximas viagens saem e o motorista é avisado', async () => {
    await ensureSchoolTrips(monday);
    expect((await api(ctx, 'POST', `/escola/contracts/${contractId}/cancel`, {}, maria)).status).toBe(200);
    const t = await query(`SELECT status FROM school_trips WHERE contract_id = $1 AND day = $2::date`, [contractId, monday]);
    expect(t.every((x) => x.status === 'cancelado')).toBe(true);
    await new Promise((x) => setTimeout(x, 30));
    expect(pushOutbox.some((m) => m.title === 'Transporte escolar encerrado')).toBe(true);
    expect((await api(ctx, 'GET', '/me/export', undefined, maria)).body.transporteEscolar.length).toBe(2);
    expect(mariaId).toBeTruthy();
  });
});
