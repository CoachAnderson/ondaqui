import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, login, startServer, stopServer, type Ctx } from './helpers.js';
import { config } from '../src/lib/config.js';
import { query } from '../src/lib/db.js';
import { smsOutbox, toE164 } from '../src/lib/sms.js';

let ctx: Ctx;

beforeAll(async () => {
  ctx = await startServer();
  config.phoneVerification = true;
});
afterAll(async () => { config.phoneVerification = false; await stopServer(ctx); });
beforeEach(() => { smsOutbox.length = 0; });

const lastCode = () => smsOutbox.at(-1)!.code;
// libera o reenvio sem esperar 60 segundos
const skipWait = (phone: string) => query(`UPDATE phone_codes SET created_at = created_at - interval '2 minutes' WHERE phone = $1`, [phone]);

describe('confirmar o celular no cadastro', () => {
  const novo = { acceptPrivacy: true, tenant: 'bauru', name: 'Gabi Nova', phone: '(14) 98888-1111', password: 'senha123', role: 'passenger' };

  it('a cidade avisa o app que precisa de código', async () => {
    expect((await api(ctx, 'GET', '/public/tenants/bauru')).body.phoneVerification).toBe(true);
  });

  it('sem código não cadastra; com o código certo, cadastra e marca o celular como confirmado', async () => {
    let r = await api(ctx, 'POST', '/auth/register', novo);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('codigo_obrigatorio');

    r = await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone: novo.phone, purpose: 'cadastro' });
    expect(r.status).toBe(200);
    expect(smsOutbox).toHaveLength(1);
    expect(smsOutbox[0].to).toBe('5514988881111');
    expect(smsOutbox[0].text).toContain('OnDaqui Bauru');
    expect(smsOutbox[0].code).toMatch(/^\d{6}$/);

    // pedir de novo logo em seguida: precisa esperar
    r = await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone: novo.phone, purpose: 'cadastro' });
    expect(r.status).toBe(429);

    const wrong = lastCode() === '000000' ? '111111' : '000000';
    r = await api(ctx, 'POST', '/auth/register', { ...novo, code: wrong });
    expect(r.body.code).toBe('codigo_incorreto');
    r = await api(ctx, 'POST', '/auth/register', { ...novo, code: lastCode() });
    expect(r.status).toBe(201);
    // o código só vale uma vez
    const again = await api(ctx, 'POST', '/auth/register', { ...novo, phone: '14988881111', code: lastCode() });
    expect(again.status).toBe(409);
  });

  it('não manda código de cadastro para telefone que já tem conta', async () => {
    const r = await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone: '14900000010', purpose: 'cadastro' });
    expect(r.status).toBe(409);
    expect(smsOutbox).toHaveLength(0);
  });

  it('5 tentativas erradas derrubam o código', async () => {
    const phone = '14977770000';
    await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone, purpose: 'cadastro' });
    const right = lastCode();
    const wrong = right === '123456' ? '654321' : '123456';
    const body = { acceptPrivacy: true, tenant: 'bauru', name: 'Teste Força', phone, password: 'senha123', role: 'passenger' };
    let r;
    for (let i = 0; i < 5; i++) r = await api(ctx, 'POST', '/auth/register', { ...body, code: wrong });
    expect(r!.body.code).toBe('codigo_bloqueado');
    r = await api(ctx, 'POST', '/auth/register', { ...body, code: right });
    expect(r.body.code).toBe('codigo_vencido');
  });

  it('limite de 5 códigos por hora para o mesmo número', async () => {
    const phone = '14966660000';
    for (let i = 0; i < 5; i++) {
      expect((await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone, purpose: 'cadastro' })).status).toBe(200);
      await skipWait(phone);
      await query(`UPDATE phone_codes SET created_at = now() - interval '61 seconds' WHERE phone = $1 AND created_at > now() - interval '61 seconds'`, [phone]);
    }
    const r = await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone, purpose: 'cadastro' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('limite_codigos');
  });
});

describe('esqueci minha senha', () => {
  it('troca a senha com o código, entra na conta e derruba as sessões antigas', async () => {
    const old = await login(ctx, '14900000010');
    expect((await api(ctx, 'GET', '/me', undefined, old)).status).toBe(200);

    const r = await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone: '14900000010', purpose: 'senha' });
    expect(r.status).toBe(200);
    expect(smsOutbox[0].text).toContain('senha nova');

    const fail = await api(ctx, 'POST', '/auth/reset-password', { tenant: 'bauru', phone: '14900000010', code: '99999', password: 'novaSenha1' });
    expect(fail.status).toBe(400);
    await new Promise((res) => setTimeout(res, 1100)); // a sessão antiga é de um segundo anterior
    const ok = await api(ctx, 'POST', '/auth/reset-password', { tenant: 'bauru', phone: '14900000010', code: lastCode(), password: 'novaSenha1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe('passenger');

    expect((await api(ctx, 'GET', '/me', undefined, ok.body.token)).status).toBe(200);
    const gone = await api(ctx, 'GET', '/me', undefined, old);
    expect(gone.status).toBe(401);
    expect(gone.body.error).toContain('senha foi trocada');
    expect((await api(ctx, 'POST', '/auth/login', { tenant: 'bauru', phone: '14900000010', password: 'ondaqui123' })).status).toBe(401);
    await login(ctx, '14900000010', 'bauru', 'novaSenha1');
  });

  it('número sem conta: responde igual e não envia nada', async () => {
    const r = await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone: '14912345678', purpose: 'senha' });
    expect(r.status).toBe(200);
    expect(smsOutbox).toHaveLength(0);
    const x = await api(ctx, 'POST', '/auth/reset-password', { tenant: 'bauru', phone: '14912345678', code: '123456', password: 'qualquer1' });
    expect(x.status).toBe(400);
  });

  it('funciona para o licenciado no painel', async () => {
    await api(ctx, 'POST', '/auth/code', { tenant: 'bauru', phone: '14900000001', purpose: 'senha' });
    const ok = await api(ctx, 'POST', '/auth/reset-password', { tenant: 'bauru', phone: '14900000001', code: lastCode(), password: 'painel123' });
    expect(ok.body.user.role).toBe('tenant_admin');
  });

  it('formato internacional do celular', () => {
    expect(toE164('14999990000')).toBe('5514999990000');
    expect(toE164('5514999990000')).toBe('5514999990000');
  });
});
