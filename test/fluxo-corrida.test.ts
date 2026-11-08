import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, centro, connect, destino, fakeSelfie, login, nextEvent, startServer, stopServer, type Ctx } from './helpers.js';
import { one } from '../src/lib/db.js';

let ctx: Ctx;
let passenger: string, joao: string, ana: string, admin: string;

beforeAll(async () => {
  ctx = await startServer();
  [passenger, joao, ana, admin] = await Promise.all([
    login(ctx, '14900000010'), login(ctx, '14900000020'), login(ctx, '14900000021'), login(ctx, '14900000001'),
  ]);
});
afterAll(async () => stopServer(ctx));

describe('corrida do pedido ao pagamento', () => {
  let rideId: string;
  let boardingCode: string;

  it('mostra a marca e as categorias da cidade', async () => {
    const r = await api(ctx, 'GET', '/public/tenants/bauru');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('OnDaqui Bauru');
    expect(r.body.categories.map((c: any) => c.code)).toContain('carro');
    expect(r.body.plans.map((p: any) => p.code)).toEqual(['livre', 'semanal', 'profissional']);
  });

  it('motorista sem selfie do turno não consegue ficar online', async () => {
    const r = await api(ctx, 'POST', '/driver/online', { online: true }, joao);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/selfie/i);
  });

  it('motorista envia selfie, fica online e manda localização', async () => {
    for (const t of [joao, ana]) {
      expect((await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, t)).status).toBe(200);
      expect((await api(ctx, 'POST', '/driver/online', { online: true }, t)).status).toBe(200);
    }
    // João mais perto do passageiro que Ana
    await api(ctx, 'POST', '/driver/location', { lat: -22.3200, lng: -49.0850 }, joao);
    await api(ctx, 'POST', '/driver/location', { lat: -22.3400, lng: -49.0700 }, ana);
    const me = await api(ctx, 'GET', '/driver/me', undefined, joao);
    expect(me.body.canWork).toBe(true);
  });

  it('passageiro recebe preço fechado antes de pedir', async () => {
    const r = await api(ctx, 'POST', '/rides/quote', { origin: centro, destination: destino, category: 'carro' }, passenger);
    expect(r.status).toBe(200);
    expect(r.body.priceCents).toBeGreaterThanOrEqual(900);
    expect(r.body.priceCents % 10).toBe(0);
    expect(r.body.distanceKm).toBeGreaterThan(3);
  });

  it('não aceita pedido fora da área da cidade', async () => {
    const r = await api(ctx, 'POST', '/rides/quote', { origin: centro, destination: { lat: -23.55, lng: -46.63 } }, passenger);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('fora_da_area');
  });

  it('pedido chega como oferta para os motoristas próximos', async () => {
    const sJoao = await connect(ctx, joao);
    const sAna = await connect(ctx, ana);
    const offerJoao = nextEvent(sJoao, 'ride:offer');
    const offerAna = nextEvent(sAna, 'ride:offer');

    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, category: 'carro', paymentMethod: 'pix' }, passenger);
    expect(r.status).toBe(201);
    expect(r.body.driversNotified).toBe(2);
    rideId = r.body.ride.id;
    boardingCode = r.body.ride.boardingCode;
    expect(boardingCode).toMatch(/^\d{4}$/);
    expect(r.body.ride.shareToken).toBeTruthy();

    const o = await offerJoao;
    await offerAna;
    expect(o.rideId).toBe(rideId);
    expect(o.destination.address).toBe(destino.address); // destino visível antes de aceitar

    // app que estava fechado recupera a oferta aberta
    const pend = await api(ctx, 'GET', '/driver/offers', undefined, joao);
    expect(pend.body.offers.map((x: any) => x.rideId)).toEqual([rideId]);
    expect(pend.body.offers[0].pickupDistanceKm).toBeGreaterThan(0);
  });

  it('passageiro não pode pedir duas corridas ao mesmo tempo', async () => {
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'cash' }, passenger);
    expect(r.status).toBe(409);
  });

  it('o primeiro motorista que aceita fica com a corrida', async () => {
    const a = await api(ctx, 'POST', `/rides/${rideId}/accept`, {}, joao);
    expect(a.status).toBe(200);
    expect(a.body.ride.boardingCode).toBeUndefined(); // motorista não vê o código
    const b = await api(ctx, 'POST', `/rides/${rideId}/accept`, {}, ana);
    expect(b.status).toBe(409);
  });

  it('passageiro vê o Pix validado do motorista com aviso antigolpe', async () => {
    const r = await api(ctx, 'GET', `/rides/${rideId}/payment`, undefined, passenger);
    expect(r.body.available).toBe(true);
    expect(r.body.holderName).toBe('João Motorista');
    expect(r.body.warning).toMatch(/Nunca pague por link/);
  });

  it('link compartilhado mostra motorista e posição ao vivo', async () => {
    const ride = await api(ctx, 'GET', `/rides/${rideId}`, undefined, passenger);
    const share = await api(ctx, 'GET', `/public/share/${ride.body.ride.shareToken}`);
    expect(share.status).toBe(200);
    expect(share.body.driver.name).toBe('João');
    expect(share.body.driver.location).not.toBeNull();
  });

  it('corrida só começa com o código de embarque certo', async () => {
    await api(ctx, 'POST', `/rides/${rideId}/arrived`, {}, joao);
    const wrong = boardingCode === '0000' ? '1111' : '0000';
    const bad = await api(ctx, 'POST', `/rides/${rideId}/start`, { boardingCode: wrong }, joao);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('codigo_invalido');
    const ok = await api(ctx, 'POST', `/rides/${rideId}/start`, { boardingCode }, joao);
    expect(ok.status).toBe(200);
  });

  it('botão de emergência avisa a central na hora', async () => {
    const sAdmin = await connect(ctx, admin);
    const alert = nextEvent(sAdmin, 'alert:panic');
    const r = await api(ctx, 'POST', `/rides/${rideId}/panic`, { lat: -22.33, lng: -49.07 }, passenger);
    expect(r.status).toBe(201);
    const a = await alert;
    expect(a.rideId).toBe(rideId);
    expect(a.vehicle).toBe('BAU1A23');
    const list = await api(ctx, 'GET', '/admin/alerts', undefined, admin);
    expect(list.body.alerts).toHaveLength(1);
    expect((await api(ctx, 'POST', `/admin/alerts/${a.id}/resolve`, { note: 'Passageira bem' }, admin)).status).toBe(200);
  });

  it('plano Profissional: motorista fica com 100% da corrida', async () => {
    const r = await api(ctx, 'POST', `/rides/${rideId}/complete`, {}, joao);
    expect(r.status).toBe(200);
    expect(r.body.commissionCents).toBe(0);
    expect(r.body.driverReceivesCents).toBe(r.body.priceCents);
    expect((await api(ctx, 'POST', `/rides/${rideId}/rate`, { stars: 5 }, passenger)).status).toBe(200);
  });

  it('plano Livre: licenciado recebe 10% da corrida', async () => {
    await api(ctx, 'POST', '/driver/online', { online: false }, joao);
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'cash' }, passenger);
    const id = r.body.ride.id;
    await api(ctx, 'POST', `/rides/${id}/accept`, {}, ana);
    await api(ctx, 'POST', `/rides/${id}/start`, { boardingCode: r.body.ride.boardingCode }, ana);
    const done = await api(ctx, 'POST', `/rides/${id}/complete`, {}, ana);
    expect(done.body.commissionCents).toBe(Math.round(done.body.priceCents * 0.1));
    const earn = await api(ctx, 'GET', '/driver/earnings?days=1', undefined, ana);
    expect(earn.body.netCents).toBe(done.body.driverReceivesCents);
  });

  it('motorista que desiste devolve a corrida para a fila', async () => {
    await api(ctx, 'POST', '/driver/online', { online: true }, joao);
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'cash' }, passenger);
    const id = r.body.ride.id;
    await api(ctx, 'POST', `/rides/${id}/accept`, {}, ana);
    expect((await api(ctx, 'POST', `/rides/${id}/cancel`, { reason: 'pneu furado' }, ana)).status).toBe(200);
    const ride = await api(ctx, 'GET', `/rides/${id}`, undefined, passenger);
    expect(ride.body.ride.status).toBe('requested');
    expect((await api(ctx, 'POST', `/rides/${id}/accept`, {}, joao)).status).toBe(200);
    expect((await api(ctx, 'POST', `/rides/${id}/cancel`, {}, passenger)).status).toBe(200);
  });

  it('licenciado vê o resumo do dia', async () => {
    const r = await api(ctx, 'GET', '/admin/overview', undefined, admin);
    expect(r.body.rides_today).toBe(2);
    expect(r.body.drivers_online).toBe(2);
    expect(r.body.open_alerts).toBe(0);
  });
});

describe('regras do licenciado', () => {
  it('tarifa dinâmica não passa do teto', async () => {
    const r = await api(ctx, 'PATCH', '/admin/settings', { currentSurge: 2 }, admin);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('acima_do_teto');
    expect((await api(ctx, 'PATCH', '/admin/settings', { currentSurge: 1.2 }, admin)).status).toBe(200);
    await api(ctx, 'PATCH', '/admin/settings', { currentSurge: 1 }, admin);
  });

  it('só aprova motorista com os documentos da lei conferidos e registra mensalidade', async () => {
    const reg = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true,
      tenant: 'bauru', name: 'Carlos Novo', phone: '(14) 99000-1234', password: 'segredo1', role: 'driver',
      driver: { vehicle: { plate: 'ABC1D23', model: 'Gol', color: 'Preto' }, pixKey: 'carlos@pix.com', pixHolderName: 'Carlos Novo', plan: 'profissional' },
    });
    expect(reg.status).toBe(201);
    const id = reg.body.user.id;
    const carlos = reg.body.token;

    expect((await api(ctx, 'POST', '/driver/online', { online: true }, carlos)).status).toBe(403);

    const semDocs = await api(ctx, 'PATCH', `/admin/drivers/${id}`, { status: 'approved' }, admin);
    expect(semDocs.status).toBe(400);
    expect(semDocs.body.code).toBe('documentos_pendentes');

    const ok = await api(ctx, 'PATCH', `/admin/drivers/${id}`,
      { status: 'approved', cnhEarOk: true, inssOk: true, criminalRecordOk: true, insuranceAppOk: true, pixValidated: true }, admin);
    expect(ok.status).toBe(200);
    expect(ok.body.driver.pix.validated).toBe(true);

    const pay = await api(ctx, 'POST', `/admin/drivers/${id}/payments`, { periods: 1 }, admin);
    expect(pay.status).toBe(201);
    expect(pay.body.amountCents).toBe(19900);
    // pagou durante o mês grátis: o período pago começa depois dele
    // mês grátis + 30 dias pagos, contados pela data do banco (evita erro perto da meia-noite)
    const expected = (await one(`SELECT (current_date + 60)::text AS d`))!.d;
    expect(pay.body.paidUntil).toBe(expected);
  });

  it('não deixa o mesmo telefone se cadastrar duas vezes na cidade', async () => {
    const r = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true,
      tenant: 'bauru', name: 'Maria de Novo', phone: '14900000010', password: 'segredo1', role: 'passenger',
    });
    expect(r.status).toBe(409);
  });
});

describe('várias cidades (white label)', () => {
  it('master cria um licenciado novo, pronto para operar', async () => {
    const master = await login(ctx, '11900000000', null);
    const r = await api(ctx, 'POST', '/master/tenants', {
      slug: 'marilia', name: 'OnDaqui Marília', cityLabel: 'Marília',
      admin: { name: 'Central Marília', phone: '14911112222', password: 'marilia123' },
    }, master);
    expect(r.status).toBe(201);
    const pub = await api(ctx, 'GET', '/public/tenants/marilia');
    // nasce com todos os serviços; o Daqui Prefeitura (pacientes) não aparece para o passageiro
    expect(pub.body.categories.map((c: any) => c.code)).toEqual(
      ['carro', 'moto', 'executivo', 'mulher', 'pet', 'entrega', 'entrega-carro', 'particular', 'frete']);
    const list = await api(ctx, 'GET', '/master/tenants', undefined, master);
    expect(list.body.tenants.map((t: any) => t.slug)).toEqual(['bauru', 'marilia']);
    expect(list.body.tenants[0].license_fee_month_cents).toBe(40); // 2 corridas x R$ 0,20
  });

  it('licenciado de uma cidade não enxerga dados de outra', async () => {
    const adminMarilia = await login(ctx, '14911112222', 'marilia', 'marilia123');
    const drivers = await api(ctx, 'GET', '/admin/drivers', undefined, adminMarilia);
    expect(drivers.body.drivers).toHaveLength(0);
    const rides = await api(ctx, 'GET', '/admin/rides', undefined, adminMarilia);
    expect(rides.body.rides).toHaveLength(0);
  });

  it('passageiro não acessa área do licenciado nem do master', async () => {
    expect((await api(ctx, 'GET', '/admin/overview', undefined, passenger)).status).toBe(403);
    expect((await api(ctx, 'GET', '/master/tenants', undefined, passenger)).status).toBe(403);
    expect((await api(ctx, 'GET', '/admin/overview')).status).toBe(401);
  });
});
