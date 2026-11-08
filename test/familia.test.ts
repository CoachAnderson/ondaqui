import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, centro, destino, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { pushOutbox } from '../src/lib/push.js';
import { smsOutbox } from '../src/lib/sms.js';
import { notifyRide } from '../src/lib/rides.js';

let ctx: Ctx;
let maria: string, joao: string, joaoId: string;
let mae: any;

beforeAll(async () => {
  ctx = await startServer();
  maria = await login(ctx, '14900000010');
  joao = await login(ctx, '14900000020');
  joaoId = (await one(`SELECT id FROM users WHERE phone = '14900000020'`)).id;
  await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[maria-familia-01]', platform: 'android' }, maria);
});
afterAll(async () => stopServer(ctx));
beforeEach(() => { pushOutbox.length = 0; smsOutbox.length = 0; });

const pedir = (extra: Record<string, unknown> = {}, token = maria) =>
  api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix', ...extra }, token);

/** o motorista aceita (o despacho é testado em outro arquivo) e as notificações saem */
async function aceitar(rideId: string, status = 'accepted') {
  await query(`UPDATE rides SET driver_id = $2, status = $3, accepted_at = now() WHERE id = $1`, [rideId, joaoId, status]);
  await notifyRide(rideId);
  await new Promise((r) => setTimeout(r, 50));
}

describe('modo família: cadastro', () => {
  it('cadastra parente com aceite, sem repetir e sem o próprio celular', async () => {
    const base = { name: 'Dona Lúcia Souza', phone: '(14) 98111-2222', relation: 'mãe', declaredWoman: true, monthlyLimitCents: 5000, notes: 'Usa bengala, precisa de ajuda para entrar' };
    let r = await api(ctx, 'POST', '/family/members', base, maria);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('concorda');
    r = await api(ctx, 'POST', '/family/members', { ...base, consent: true }, maria);
    expect(r.status).toBe(201);
    mae = r.body.member;
    expect(mae).toMatchObject({ name: 'Dona Lúcia Souza', phone: '14981112222', monthlyLimitCents: 5000, spentThisMonthCents: 0 });
    r = await api(ctx, 'POST', '/family/members', { ...base, phone: '14900000010', consent: true }, maria);
    expect(r.body.code).toBe('proprio_celular');
    expect((await api(ctx, 'GET', '/family/members', undefined, maria)).body.members).toHaveLength(1);
    // outra pessoa não vê nem usa o parente da Maria
    const outro = await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true, tenant: 'bauru', name: 'Pedro Outro', phone: '14944443333', password: 'senha123', role: 'passenger' });
    expect((await api(ctx, 'GET', '/family/members', undefined, outro.body.token)).body.members).toHaveLength(0);
    expect((await pedir({ familyMemberId: mae.id }, outro.body.token)).status).toBe(404);
  });
});

describe('modo família: corrida para o parente', () => {
  let rideId: string;

  it('pede para a mãe enquanto tem a própria corrida; o motorista vê quem viaja e as observações', async () => {
    const minha = await pedir();
    expect(minha.status).toBe(201);
    const dela = await pedir({ familyMemberId: mae.id });
    expect(dela.status).toBe(201);
    rideId = dela.body.ride.id;
    expect(dela.body.ride.family).toMatchObject({ name: 'Dona Lúcia Souza', relation: 'mãe', requestedBy: 'Maria', phone: '14981112222' });
    // a própria continua sendo a "corrida atual"; a da mãe aparece em Família
    expect((await api(ctx, 'GET', '/rides/current', undefined, maria)).body.ride.id).toBe(minha.body.ride.id);
    expect((await api(ctx, 'GET', '/family/rides', undefined, maria)).body.rides.map((r: any) => r.id)).toEqual([rideId]);
    // a mãe não pode ter duas corridas ao mesmo tempo
    expect((await pedir({ familyMemberId: mae.id })).body.code).toBe('corrida_ativa');
    await api(ctx, 'POST', `/rides/${minha.body.ride.id}/cancel`, { reason: 'teste' }, maria);

    await aceitar(rideId);
    const v = await api(ctx, 'GET', `/rides/${rideId}`, undefined, joao);
    expect(v.body.ride.passenger.name).toBe('Dona');
    expect(v.body.ride.family).toMatchObject({ name: 'Dona', requestedBy: 'Maria', notes: 'Usa bengala, precisa de ajuda para entrar' });
    expect(v.body.ride.family.phone).toBeUndefined();
  });

  it('a mãe recebe SMS com motorista, código e link; a Maria acompanha cada etapa por push', async () => {
    expect(smsOutbox).toHaveLength(0); // o SMS saiu no aceite, no teste anterior
    await query(`UPDATE rides SET status = 'requested', driver_id = NULL WHERE id = $1`, [rideId]);
    await aceitar(rideId);
    const code = (await one(`SELECT boarding_code FROM rides WHERE id = $1`, [rideId])).boarding_code;
    expect(smsOutbox).toHaveLength(1);
    expect(smsOutbox[0].to).toBe('5514981112222');
    expect(smsOutbox[0].text).toContain('Maria pediu um carro para você');
    expect(smsOutbox[0].text).toContain(`código ${code}`);
    expect(pushOutbox.at(-1)!.title).toBe('Motorista a caminho de Dona');

    await query(`UPDATE rides SET status = 'in_progress' WHERE id = $1`, [rideId]); await notifyRide(rideId);
    await query(`UPDATE rides SET status = 'completed', completed_at = now() WHERE id = $1`, [rideId]); await notifyRide(rideId);
    await new Promise((r) => setTimeout(r, 50));
    const titles = pushOutbox.map((m) => m.title);
    expect(titles).toContain('Dona embarcou');
    expect(titles).toContain('Dona chegou ✅');
  });

  it('limite do mês por parente', async () => {
    const spent = (await api(ctx, 'GET', '/family/members', undefined, maria)).body.members[0].spentThisMonthCents;
    expect(spent).toBeGreaterThan(0);
    await api(ctx, 'PATCH', `/family/members/${mae.id}`, { monthlyLimitCents: spent + 500 }, maria);
    const r = await pedir({ familyMemberId: mae.id });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('limite_familia');
    expect(r.body.error).toContain('Sobram R$ 5,00');
    await api(ctx, 'PATCH', `/family/members/${mae.id}`, { monthlyLimitCents: null }, maria);
    expect((await pedir({ familyMemberId: mae.id })).status).toBe(201);
  });

  it('Daqui Mulher para a mãe usa o cadastro dela; parente com corrida não sai da lista', async () => {
    const q = await api(ctx, 'POST', '/rides/quote', { origin: centro, destination: destino, category: 'mulher', familyMemberId: mae.id }, maria);
    expect(q.status).toBe(200);
    expect((await api(ctx, 'DELETE', `/family/members/${mae.id}`, undefined, maria)).body.code).toBe('parente_em_corrida');
  });

  it('o chat do motorista é com quem pediu', async () => {
    const active = (await api(ctx, 'GET', '/family/rides', undefined, maria)).body.rides[0];
    await aceitar(active.id);
    const c = await api(ctx, 'GET', `/rides/${active.id}/messages`, undefined, joao);
    expect(c.body.with).toBe('Maria');
  });

  it('remover o parente apaga os dados dele; o histórico fica sem o nome', async () => {
    const active = (await api(ctx, 'GET', '/family/rides', undefined, maria)).body.rides;
    for (const r of active) await api(ctx, 'POST', `/rides/${r.id}/cancel`, { reason: 'teste' }, maria);
    expect((await api(ctx, 'DELETE', `/family/members/${mae.id}`, undefined, maria)).status).toBe(200);
    expect((await one('SELECT count(*)::int AS n FROM family_members WHERE id = $1', [mae.id])).n).toBe(0);
    expect((await one('SELECT count(*)::int AS n FROM rides WHERE family_member_id IS NOT NULL')).n).toBe(0);
    expect((await api(ctx, 'GET', '/family/members', undefined, maria)).body.members).toHaveLength(0);
  });
});
