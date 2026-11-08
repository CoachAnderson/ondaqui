import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { api, centro, destino, fakeSelfie, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';

let ctx: Ctx;
let admin: string;

beforeAll(async () => {
  ctx = await startServer();
  admin = await login(ctx, '14900000001');
});
afterAll(async () => stopServer(ctx));

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const file = (rel: string) => resolve(config.uploadDir, rel);

describe('política de privacidade', () => {
  it('página pública com os dados da empresa do licenciado e da operadora', async () => {
    const r = await api(ctx, 'GET', '/public/tenants/bauru/privacidade');
    expect(r.status).toBe(200);
    expect(r.body.legal_name).toBe('Mobilidade Bauru Demonstração Ltda');
    expect(r.body.dpo_email).toBe('privacidade@exemplo.com.br');
    expect(r.body.platform.cnpj).toBe('44.607.634/0001-82');
    expect(r.body.services).toMatchObject({ entrega: true, paciente: true, lojas: true });
    expect(r.body.complete).toBe(true);
    expect(r.body.privacy_version).toBe(1);
    expect((await api(ctx, 'GET', '/public/tenants/nao-existe/privacidade')).status).toBe(404);
  });

  it('cadastro só com aceite, que fica registrado com a versão', async () => {
    const base = { tenant: 'bauru', name: 'Lia Nova', phone: '14966665555', password: 'senha123', role: 'passenger' };
    const no = await api(ctx, 'POST', '/auth/register', base);
    expect(no.status).toBe(400);
    expect(no.body.error).toContain('aceite a política de privacidade');
    const ok = await api(ctx, 'POST', '/auth/register', { ...base, acceptPrivacy: true });
    expect(ok.status).toBe(201);
    const me = await api(ctx, 'GET', '/me/privacy', undefined, ok.body.token);
    expect(me.body).toMatchObject({ accepted_version: 1, current_version: 1, mustAccept: false });
    expect(me.body.url).toContain('/privacidade/bauru');
  });

  it('licenciado preenche os dados e publica versão nova, que pede novo aceite', async () => {
    const lia = await login(ctx, '14966665555', 'bauru', 'senha123');
    let r = await api(ctx, 'PATCH', '/admin/privacy', { cnpj: '123' }, admin);
    expect(r.status).toBe(400);
    r = await api(ctx, 'PATCH', '/admin/privacy', { legalName: '', dpoEmail: 'dpo@mobilidadebauru.com.br' }, admin);
    expect(r.status).toBe(200);
    expect(r.body.missing).toEqual(['Razão social']);
    expect((await api(ctx, 'GET', '/public/tenants/bauru/privacidade')).body.complete).toBe(false);
    r = await api(ctx, 'PATCH', '/admin/privacy', { legalName: 'Mobilidade Bauru Ltda' }, admin);
    expect(r.body.missing).toEqual([]);
    expect(r.body.users.accepted).toBe(r.body.users.total);

    r = await api(ctx, 'POST', '/admin/privacy/new-version', {}, admin);
    expect(r.body.privacy_version).toBe(2);
    expect(r.body.users.accepted).toBe(0);

    let me = await api(ctx, 'GET', '/me/privacy', undefined, lia);
    expect(me.body.mustAccept).toBe(true);
    // só vale o aceite da versão atual
    expect((await api(ctx, 'POST', '/me/privacy/accept', { version: 1 }, lia)).status).toBe(409);
    expect((await api(ctx, 'POST', '/me/privacy/accept', { version: 2 }, lia)).status).toBe(200);
    me = await api(ctx, 'GET', '/me/privacy', undefined, lia);
    expect(me.body.mustAccept).toBe(false);
    // só o licenciado mexe nos dados da empresa
    expect((await api(ctx, 'PATCH', '/admin/privacy', { legalName: 'X' }, lia)).status).toBe(403);
  });
});

describe('exclusão da conta pelo app', () => {
  it('passageiro: pede senha, não exclui com corrida em andamento e anonimiza o resto', async () => {
    const reg = await api(ctx, 'POST', '/auth/register', {
      acceptPrivacy: true, tenant: 'bauru', name: 'Bruno Sai', phone: '14933332222', password: 'senha123', role: 'passenger',
    });
    const bruno = reg.body.token;
    const id = reg.body.user.id;
    await api(ctx, 'POST', '/me/push-token', { token: 'ExponentPushToken[bruno-0001]', platform: 'android' }, bruno);

    const agendada = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix', scheduledFor: inMinutes(120) }, bruno);
    expect(agendada.status).toBe(201);
    const agora = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'cash' }, bruno);
    expect(agora.status).toBe(201);

    expect((await api(ctx, 'DELETE', '/me', { password: 'errada' }, bruno)).status).toBe(400);
    const busy = await api(ctx, 'DELETE', '/me', { password: 'senha123' }, bruno);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('corrida_em_andamento');

    await api(ctx, 'POST', `/rides/${agora.body.ride.id}/cancel`, { reason: 'desisti' }, bruno);
    const del = await api(ctx, 'DELETE', '/me', { password: 'senha123' }, bruno);
    expect(del.status).toBe(200);

    const u = await one('SELECT name, phone, deleted_at, blocked FROM users WHERE id = $1', [id]);
    expect(u.name).toBe('Conta excluída');
    expect(u.phone).not.toContain('33332222');
    expect(u.deleted_at).not.toBeNull();
    expect((await one('SELECT count(*)::int AS n FROM push_tokens WHERE user_id = $1', [id])).n).toBe(0);
    expect((await one('SELECT status, cancel_reason FROM rides WHERE id = $1', [agendada.body.ride.id])))
      .toMatchObject({ status: 'cancelled', cancel_reason: 'conta_excluida' });
    // o histórico continua, sem o nome
    expect((await one('SELECT count(*)::int AS n FROM rides WHERE passenger_id = $1', [id])).n).toBe(2);

    // a sessão antiga para de valer e o telefone fica livre
    const after = await api(ctx, 'GET', '/me', undefined, bruno);
    expect(after.status).toBe(401);
    expect(after.body.error).toContain('excluída');
    expect((await api(ctx, 'POST', '/auth/login', { tenant: 'bauru', phone: '14933332222', password: 'senha123' })).status).toBe(401);
    const again = await api(ctx, 'POST', '/auth/register', {
      acceptPrivacy: true, tenant: 'bauru', name: 'Bruno Volta', phone: '14933332222', password: 'senha123', role: 'passenger',
    });
    expect(again.status).toBe(201);
  });

  it('motorista: fotos, selfie e Pix são apagados', async () => {
    const reg = await api(ctx, 'POST', '/auth/register', {
      acceptPrivacy: true, tenant: 'bauru', name: 'Davi Motorista', phone: '14922221111', password: 'davi1234', role: 'driver',
      driver: { vehicle: { plate: 'DAV1D23', model: 'Onix', color: 'Prata' }, pixKey: 'davi@pix.com', pixHolderName: 'Davi M', plan: 'livre' },
    });
    const davi = reg.body.token;
    const id = reg.body.user.id;
    await api(ctx, 'POST', '/driver/photos', { which: 'perfil', image: fakeSelfie }, davi);
    await api(ctx, 'POST', '/driver/photos', { which: 'veiculo', image: fakeSelfie }, davi);
    await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, davi);
    const first = (await one('SELECT selfie_path FROM drivers WHERE user_id = $1', [id])).selfie_path;
    await new Promise((r) => setTimeout(r, 5));
    await api(ctx, 'POST', '/driver/shift-selfie', { image: fakeSelfie }, davi);
    const d = await one('SELECT * FROM drivers WHERE user_id = $1', [id]);
    // só a selfie do turno atual fica guardada
    expect(existsSync(file(first))).toBe(false);
    expect(existsSync(file(d.selfie_path))).toBe(true);
    expect(existsSync(file(d.photo_pending_path))).toBe(true);

    expect((await api(ctx, 'DELETE', '/me', { password: 'davi1234' }, davi)).status).toBe(200);
    const after = await one('SELECT * FROM drivers WHERE user_id = $1', [id]);
    expect(after).toMatchObject({ pix_key: null, photo_pending_path: null, selfie_path: null, online: false, status: 'blocked' });
    for (const p of [d.selfie_path, d.photo_pending_path, d.vehicle_pending_path]) expect(existsSync(file(p))).toBe(false);
  });

  it('foto recusada pela central é apagada do servidor', async () => {
    const reg = await api(ctx, 'POST', '/auth/register', {
      acceptPrivacy: true, tenant: 'bauru', name: 'Eva Motorista', phone: '14911110000', password: 'eva12345', role: 'driver',
      driver: { vehicle: { plate: 'EVA1D23', model: 'HB20', color: 'Branco' }, plan: 'livre' },
    });
    await api(ctx, 'POST', '/driver/photos', { which: 'perfil', image: fakeSelfie }, reg.body.token);
    await api(ctx, 'POST', '/driver/photos', { which: 'veiculo', image: fakeSelfie }, reg.body.token);
    const d = await one('SELECT photo_pending_path FROM drivers WHERE user_id = $1', [reg.body.user.id]);
    await api(ctx, 'PATCH', `/admin/drivers/${reg.body.user.id}`, { photoApproved: false }, admin);
    expect(existsSync(file(d.photo_pending_path))).toBe(false);
  });
});

describe('navegador (painel e app web)', () => {
  it('libera PATCH, PUT e DELETE para o painel', async () => {
    const res = await fetch(`${ctx.base}/me`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'content-type,authorization' },
    });
    const allowed = res.headers.get('access-control-allow-methods') ?? '';
    for (const m of ['PATCH', 'PUT', 'DELETE']) expect(allowed).toContain(m);
  });
});
