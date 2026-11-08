import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, centro, destino, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { sweepPendingRides } from '../src/lib/rides.js';

let ctx: Ctx;
let maria: string, joao: string, ana: string, carlos: string, pedro: string, admin: string, saude: string;
const ids: Record<string, string> = {};

/** Quem recebeu a oferta desta corrida */
const offeredTo = async (rideId: string) =>
  (await query(
    `SELECT u.name FROM ride_offers o JOIN users u ON u.id = o.driver_id WHERE o.ride_id = $1 AND o.status = 'sent' ORDER BY u.name`,
    [rideId],
  )).map((r) => r.name.split(' ')[0]);

const cancel = (id: string, token = maria) => api(ctx, 'POST', `/rides/${id}/cancel`, {}, token);
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

async function online(token: string, lat: number, lng: number) {
  await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, token);
  expect((await api(ctx, 'POST', '/driver/online', { online: true }, token)).status).toBe(200);
  await api(ctx, 'POST', '/driver/location', { lat, lng }, token);
}

beforeAll(async () => {
  ctx = await startServer();
  [maria, joao, ana, carlos, pedro, admin, saude] = await Promise.all([
    login(ctx, '14900000010'), login(ctx, '14900000020'), login(ctx, '14900000021'),
    login(ctx, '14900000022'), login(ctx, '14900000023'), login(ctx, '14900000001'), login(ctx, '14900000030'),
  ]);
  await online(joao, -22.321, -49.085);
  await online(ana, -22.322, -49.086);
  await online(carlos, -22.323, -49.087);
  await online(pedro, -22.324, -49.088);
  for (const r of await query('SELECT id, name FROM users')) ids[r.name.split(' ')[0]] = r.id;
});
afterAll(async () => stopServer(ctx));

describe('catálogo de serviços', () => {
  it('mostra o preço de todos os serviços do passageiro de uma vez', async () => {
    const r = await api(ctx, 'POST', '/rides/quotes', { origin: centro, destination: destino, hours: 3, helpers: 2 }, maria);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.quotes.map((q: any) => [q.category, q]));
    expect(Object.keys(by)).toEqual(['carro', 'moto', 'executivo', 'mulher', 'pet', 'entrega', 'entrega-carro', 'particular', 'frete']);
    expect(by.particular.priceCents).toBe(13500); // 3 h × R$ 45
    expect(by.pet.priceCents).toBe(by.carro.priceCents + 500);
    expect(by.frete.extraCents).toBe(6000); // 2 ajudantes × R$ 30
    expect(by.executivo.priceCents).toBeGreaterThan(by.carro.priceCents);
    expect(by.moto.priceCents).toBeLessThan(by.carro.priceCents);
  });

  it('passageiro não pede o serviço de pacientes da Prefeitura', async () => {
    const r = await api(ctx, 'POST', '/rides/quote', { origin: centro, destination: destino, category: 'paciente' }, maria);
    expect(r.body.code).toBe('servico_indisponivel');
  });
});

describe('cada serviço chama só os motoristas certos', () => {
  const pedir = async (category: string, extra: Record<string, unknown> = {}, token = maria) =>
    api(ctx, 'POST', '/rides', { origin: centro, destination: destino, category, paymentMethod: 'pix', ...extra }, token);

  it('Daqui Car: carros (não moto nem utilitário)', async () => {
    const r = await pedir('carro');
    expect(r.status).toBe(201);
    expect(await offeredTo(r.body.ride.id)).toEqual(['Ana', 'João']);
    await cancel(r.body.ride.id);
  });

  it('Daqui Moto: só moto', async () => {
    const r = await pedir('moto');
    expect(await offeredTo(r.body.ride.id)).toEqual(['Carlos']);
    await cancel(r.body.ride.id);
  });

  it('Daqui Executivo: só carro liberado como executivo', async () => {
    const r = await pedir('executivo');
    expect(await offeredTo(r.body.ride.id)).toEqual(['João']);
    await cancel(r.body.ride.id);
  });

  it('Daqui Mulher: só motorista mulher conferida, e só para passageira', async () => {
    const r = await pedir('mulher');
    expect(r.status).toBe(201);
    expect(await offeredTo(r.body.ride.id)).toEqual(['Ana']);
    await cancel(r.body.ride.id);

    const reg = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true, tenant: 'bauru', name: 'Paulo Passageiro', phone: '14955554444', password: 'senha123', role: 'passenger' });
    const paulo = reg.body.token;
    const no = await pedir('mulher', {}, paulo);
    expect(no.status).toBe(403);
    expect(no.body.error).toContain('Sou mulher');
  });

  it('Daqui Pet: só quem aceita pet; o motorista escolhe no app', async () => {
    let r = await pedir('pet', { notes: 'Cachorro de porte médio' });
    expect(await offeredTo(r.body.ride.id)).toEqual(['João']);
    await cancel(r.body.ride.id);
    // Ana passa a aceitar pet
    const s = await api(ctx, 'PUT', '/driver/services', { services: ['entrega', 'pet'] }, ana);
    expect(s.body.services).toEqual(['entrega', 'pet']);
    r = await pedir('pet');
    expect(await offeredTo(r.body.ride.id)).toEqual(['Ana', 'João']);
    await cancel(r.body.ride.id);
    // motorista não se autolibera para serviços que a central confere
    expect((await api(ctx, 'PUT', '/driver/services', { services: ['mulher'] }, joao)).status).toBe(400);
  });

  it('Daqui Frete: utilitário, com ajudantes no preço', async () => {
    const r = await pedir('frete', { helpers: 1, notes: 'Geladeira e fogão' });
    expect(await offeredTo(r.body.ride.id)).toEqual(['Pedro']);
    expect(r.body.ride.helpers).toBe(1);
    await cancel(r.body.ride.id);
  });

  it('licenciado libera um serviço conferido para o motorista', async () => {
    const p = await api(ctx, 'PATCH', `/admin/drivers/${ids['Ana']}`, { verified: ['mulher', 'executivo'] }, admin);
    expect(p.body.driver.verified).toEqual(['mulher', 'executivo']);
    const r = await pedir('executivo');
    expect(await offeredTo(r.body.ride.id)).toEqual(['Ana', 'João']);
    await cancel(r.body.ride.id);
  });
});

describe('Daqui Entrega', () => {
  let rideId: string, coleta: string, entrega: string, share: string;

  it('remetente informa quem recebe e o pacote', async () => {
    const sem = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, category: 'entrega', paymentMethod: 'pix' }, maria);
    expect(sem.body.code).toBe('dados_entrega');
    const r = await api(ctx, 'POST', '/rides', {
      origin: centro, destination: destino, category: 'entrega', paymentMethod: 'pix',
      delivery: { recipientName: 'Lúcia Recebedora', recipientPhone: '14933332222', packageDesc: 'Documentos em envelope' },
    }, maria);
    expect(r.status).toBe(201);
    rideId = r.body.ride.id;
    coleta = r.body.ride.boardingCode;
    entrega = r.body.ride.deliveryCode;
    share = r.body.ride.shareToken;
    expect(entrega).toMatch(/^\d{4}$/);
    expect(await offeredTo(rideId)).toEqual(['Carlos']);
  });

  it('o link para quem recebe mostra o código de entrega', async () => {
    const p = await api(ctx, 'GET', `/public/share/${share}`);
    expect(p.body.delivery).toEqual({ recipientName: 'Lúcia Recebedora', code: entrega });
  });

  it('motoboy coleta com foto e código, e só entrega com o código de quem recebe', async () => {
    const acc = await api(ctx, 'POST', `/rides/${rideId}/accept`, {}, carlos);
    expect(acc.status).toBe(200);
    expect(acc.body.ride.delivery.recipientPhone).toBe('14933332222');
    expect(acc.body.ride.deliveryCode).toBeUndefined(); // o motoboy não vê o código de entrega
    await api(ctx, 'POST', `/rides/${rideId}/arrived`, {}, carlos);

    const semFoto = await api(ctx, 'POST', `/rides/${rideId}/start`, { boardingCode: coleta }, carlos);
    expect(semFoto.body.code).toBe('sem_foto');
    expect((await api(ctx, 'POST', `/rides/${rideId}/pickup-photo`, { image: fakeSelfie }, carlos)).status).toBe(200);
    expect((await api(ctx, 'POST', `/rides/${rideId}/start`, { boardingCode: coleta }, carlos)).status).toBe(200);

    const semComprovante = await api(ctx, 'POST', `/rides/${rideId}/complete`, { deliveryCode: entrega }, carlos);
    expect(semComprovante.body.code).toBe('sem_foto_entrega');
    expect((await api(ctx, 'POST', `/rides/${rideId}/dropoff-photo`, { image: fakeSelfie }, carlos)).status).toBe(200);
    const errado = await api(ctx, 'POST', `/rides/${rideId}/complete`, { deliveryCode: entrega === '0000' ? '1111' : '0000' }, carlos);
    expect(errado.body.code).toBe('codigo_invalido');
    expect((await api(ctx, 'POST', `/rides/${rideId}/complete`, { deliveryCode: entrega }, carlos)).status).toBe(200);

    const foto = await fetch(`${ctx.base}/rides/${rideId}/pickup-photo`, { headers: { authorization: `Bearer ${maria}` } });
    expect(foto.status).toBe(200);
  });
});

describe('Daqui Particular (por hora)', () => {
  it('reserva por horas, só para quem atende por hora, e pode estender', async () => {
    const r = await api(ctx, 'POST', '/rides', { origin: centro, category: 'particular', hours: 3, paymentMethod: 'card' }, maria);
    expect(r.status).toBe(201);
    expect(r.body.ride.priceCents).toBe(13500);
    expect(r.body.ride.destination.address).toBe('Roteiro combinado com o motorista');
    expect(await offeredTo(r.body.ride.id)).toEqual(['João']);
    const ext = await api(ctx, 'POST', `/rides/${r.body.ride.id}/extend`, { hours: 1 }, maria);
    expect(ext.body.ride).toMatchObject({ hoursBooked: 4, priceCents: 18000 });
    await cancel(r.body.ride.id);
  });
});

describe('corrida agendada', () => {
  it('fica agendada e só chama motoristas perto do horário, com preço sem dinâmica', async () => {
    await query(`UPDATE tenants SET current_surge = 1.5 WHERE slug = 'bauru'`);
    const agora = await api(ctx, 'POST', '/rides/quote', { origin: centro, destination: destino }, maria);
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix', scheduledFor: inMinutes(90) }, maria);
    await query(`UPDATE tenants SET current_surge = 1 WHERE slug = 'bauru'`);
    expect(r.status).toBe(201);
    expect(r.body.ride.status).toBe('scheduled');
    expect(r.body.ride.priceCents).toBeLessThan(agora.body.priceCents);
    expect(await offeredTo(r.body.ride.id)).toEqual([]);
    expect((await api(ctx, 'GET', '/rides/scheduled', undefined, maria)).body.rides).toHaveLength(1);

    // o passageiro pode pedir outra corrida agora, mesmo com uma agendada
    const now = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix' }, maria);
    expect(now.status).toBe(201);
    await cancel(now.body.ride.id);

    await sweepPendingRides();
    expect((await one('SELECT status FROM rides WHERE id = $1', [r.body.ride.id])).status).toBe('scheduled');
    await query(`UPDATE rides SET scheduled_for = now() + interval '15 minutes' WHERE id = $1`, [r.body.ride.id]);
    await sweepPendingRides();
    expect((await one('SELECT status FROM rides WHERE id = $1', [r.body.ride.id])).status).toBe('requested');
    expect(await offeredTo(r.body.ride.id)).toEqual(['Ana', 'João']);
    await cancel(r.body.ride.id);
  });

  it('recusa horário em cima da hora', async () => {
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix', scheduledFor: inMinutes(5) }, maria);
    expect(r.body.code).toBe('agendamento_cedo');
  });
});

describe('Daqui Prefeitura (transporte de pacientes)', () => {
  let benedita: any, jose: any, hospital: any, idaId: string;

  it('a central da Saúde vê os pacientes e os destinos do convênio', async () => {
    const p = await api(ctx, 'GET', '/account/patients', undefined, saude);
    expect(p.status).toBe(200);
    benedita = p.body.patients.find((x: any) => x.name.startsWith('Benedita'));
    jose = p.body.patients.find((x: any) => x.name.startsWith('José'));
    hospital = (await api(ctx, 'GET', '/account/places', undefined, saude)).body.places.find((x: any) => x.name.startsWith('Hospital'));
    expect(benedita.wheelchair).toBe(true);
    expect((await api(ctx, 'GET', '/account/patients', undefined, maria)).status).toBe(403);
  });

  it('cadeirante só vai para motorista com veículo adaptado', async () => {
    const r = await api(ctx, 'POST', '/account/trips', { patientId: benedita.id, destination: hospital }, saude);
    expect(r.status).toBe(201);
    expect(r.body.trip).toMatchObject({ kind: 'paciente', paymentMethod: 'convenio', status: 'requested' });
    expect(r.body.trip.patient).toMatchObject({ name: 'Benedita Souza', wheelchair: true, companion: true });
    expect(await offeredTo(r.body.trip.id)).toEqual(['João']);
    expect((await api(ctx, 'POST', `/account/trips/${r.body.trip.id}/cancel`, {}, saude)).status).toBe(200);
  });

  it('ida agora e volta agendada; o motorista leva o paciente sem código e a central acompanha', async () => {
    const r = await api(ctx, 'POST', '/account/trips', {
      patientId: jose.id, destination: hospital, returnAt: inMinutes(240),
    }, saude);
    expect(r.status).toBe(201);
    idaId = r.body.trip.id;
    expect(r.body.returnTrip.status).toBe('scheduled');
    expect(r.body.returnTrip.origin.address).toBe(`${hospital.name} — ${hospital.address}`);
    // José não é cadeirante: qualquer motorista liberado para pacientes (só João)
    expect(await offeredTo(idaId)).toEqual(['João']);

    const acc = await api(ctx, 'POST', `/rides/${idaId}/accept`, {}, joao);
    expect(acc.body.ride.patient).toMatchObject({ name: 'José da Silva', phone: '14988887777' });
    // a central da Saúde vê a foto do motorista e do veículo para avisar o paciente
    const foto = await fetch(`${ctx.base}/account/trips/${idaId}/driver-photo`, { headers: { authorization: `Bearer ${saude}` } });
    expect(foto.status).toBe(200);
    expect(foto.headers.get('content-type')).toBe('image/png');
    expect((await api(ctx, 'POST', `/rides/${idaId}/start`, {}, joao)).status).toBe(200);
    expect((await api(ctx, 'POST', `/rides/${idaId}/complete`, {}, joao)).status).toBe(200);

    const ativas = await api(ctx, 'GET', '/account/trips?view=agendadas', undefined, saude);
    expect(ativas.body.trips).toHaveLength(1);
    expect((await api(ctx, 'POST', `/account/trips/${idaId}/return`, {}, saude)).body.code).toBe('volta_existente');
  });

  it('relatório do mês para a Prefeitura, com repasse por motorista e planilha', async () => {
    const rep = await api(ctx, 'GET', '/account/report', undefined, saude);
    expect(rep.body).toMatchObject({ trips: 1, patients: 1, cancelled: 1 });
    expect(rep.body.byDriver[0]).toMatchObject({ driver: 'João Motorista', trips: 1 });
    const csv = await fetch(`${ctx.base}/account/report.csv`, { headers: { authorization: `Bearer ${saude}` } });
    const text = await csv.text();
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(text).toContain('José da Silva');
    expect(text).toContain('Hospital Estadual de Bauru');
    const earn = await api(ctx, 'GET', '/driver/earnings', undefined, joao);
    expect(earn.body.toReceiveFromCentralCents).toBe(rep.body.totalCents);
  });

  it('o licenciado vê o convênio e cria outro com operador', async () => {
    const l = await api(ctx, 'GET', '/admin/accounts', undefined, admin);
    expect(l.body.accounts[0]).toMatchObject({ trips_month: 1, patients: 2 });
    const c = await api(ctx, 'POST', '/admin/accounts', {
      name: 'Secretaria de Assistência Social',
      operator: { name: 'Operadora Social', phone: '14944443333', password: 'social1234' },
    }, admin);
    expect(c.status).toBe(201);
    const op = await login(ctx, '14944443333', 'bauru', 'social1234');
    expect((await api(ctx, 'GET', '/account/patients', undefined, op)).body.patients).toHaveLength(0);
  });
});
