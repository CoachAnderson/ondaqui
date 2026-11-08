import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { api, centro, destino, login, startServer, stopServer, type Ctx } from './helpers.js';
import { one, query } from '../src/lib/db.js';
import { csvCell } from '../src/lib/csv.js';

let ctx: Ctx;
let admin: string;

beforeAll(async () => {
  ctx = await startServer();
  admin = await login(ctx, '14900000001');
});
afterAll(async () => stopServer(ctx));

async function download(path: string, token: string) {
  const res = await fetch(ctx.base + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), body: new Uint8Array(await res.arrayBuffer()) };
}

describe('exportação dos dados da cidade', () => {
  it('ZIP com as planilhas, sem senhas, e registrado', async () => {
    // nome malicioso: não pode virar fórmula no Excel
    await api(ctx, 'POST', '/auth/register', { acceptPrivacy: true, tenant: 'bauru', name: '=HYPERLINK("http://x")', phone: '14955550000', password: 'senha123', role: 'passenger' });
    const maria = await login(ctx, '14900000010');
    await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, paymentMethod: 'pix' }, maria);

    const r = await download('/admin/export', admin);
    expect(r.status).toBe(200);
    expect(r.type).toBe('application/zip');
    expect(r.disposition).toMatch(/bauru-dados-\d{4}-\d{2}-\d{2}\.zip/);
    const files = unzipSync(r.body);
    expect(Object.keys(files).sort()).toEqual(['LEIA-ME.txt', 'anuncios.csv', 'cashback.csv', 'clube.csv', 'comissoes.csv', 'corridas.csv', 'dados.json', 'escola.csv', 'food_pedidos.csv', 'food_turnos.csv', 'lojas_e_convenios.csv',
      'mensalidades.csv', 'motoristas.csv', 'pacientes.csv', 'passageiros.csv', 'repasses_cashback.csv']);

    const passageiros = strFromU8(files['passageiros.csv']);
    // BOM do UTF-8 (o Excel abre os acentos certos)
    expect([...files['passageiros.csv'].slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(passageiros).toContain('Maria Passageira');
    expect(passageiros).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(strFromU8(files['motoristas.csv'])).toContain('BAU1A23');
    expect(strFromU8(files['corridas.csv'])).toContain('Praça Rui Barbosa');
    expect(strFromU8(files['lojas_e_convenios.csv'])).toContain('Farmácia Central');
    expect(strFromU8(files['pacientes.csv']).split('\r\n').length).toBeGreaterThan(2);

    const json = strFromU8(files['dados.json']);
    expect(json).not.toMatch(/password|mp_access_token|\$2[aby]\$/);
    const data = JSON.parse(json);
    expect(data.cidade.slug).toBe('bauru');
    expect(data.motoristas.length).toBe(4);

    const log = await api(ctx, 'GET', '/admin/exports', undefined, admin);
    expect(log.body.exports).toHaveLength(1);
    expect(log.body.exports[0].by_role).toBe('tenant_admin');
  });

  it('só o licenciado da cidade e o dono da plataforma exportam', async () => {
    const joao = await login(ctx, '14900000020');
    expect((await download('/admin/export', joao)).status).toBe(403);
    const saude = await login(ctx, '14900000030');
    expect((await download('/admin/export', saude)).status).toBe(403);

    const master = await login(ctx, '11900000000', null);
    const t = await one(`SELECT id FROM tenants WHERE slug = 'bauru'`);
    const r = await download(`/master/tenants/${t.id}/export`, master);
    expect(r.status).toBe(200);
    expect(Object.keys(unzipSync(r.body))).toContain('corridas.csv');
    expect((await download(`/master/tenants/${t.id}/export`, admin)).status).toBe(403);
  });

  it('cidade suspensa ainda consegue levar os dados', async () => {
    await query(`UPDATE tenants SET active = false, suspended_reason = 'inadimplencia' WHERE slug = 'bauru'`);
    expect((await download('/admin/export', admin)).status).toBe(200);
    await query(`UPDATE tenants SET active = true, suspended_reason = NULL WHERE slug = 'bauru'`);
  });
});

describe('cópia dos dados do titular', () => {
  it('passageira recebe só os próprios dados', async () => {
    const maria = await login(ctx, '14900000010');
    const r = await api(ctx, 'GET', '/me/export', undefined, maria);
    expect(r.status).toBe(200);
    expect(r.body.conta).toMatchObject({ nome: 'Maria Passageira', celular: '14900000010', tipo: 'passageiro' });
    expect(r.body.sobre).toContain('Mobilidade Bauru Demonstração Ltda');
    expect(r.body.corridas.length).toBeGreaterThan(0);
    expect(r.body.corridas.every((c: any) => c.as_role === 'passageiro' && c.commission_cents === null)).toBe(true);
    expect(r.body.motorista).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/password|\$2[aby]\$/);
    expect((await one(`SELECT count(*)::int AS n FROM data_exports WHERE kind = 'titular'`)).n).toBe(1);
  });

  it('motorista recebe veículo, plano e Pix', async () => {
    const ana = await login(ctx, '14900000021');
    const r = await api(ctx, 'GET', '/me/export', undefined, ana);
    expect(r.body.conta.tipo).toBe('motorista');
    expect(r.body.motorista).toMatchObject({ vehicle_plate: 'BAU2B34', plan_code: 'livre' });
    expect(r.body.motorista.photo_path).toBeUndefined();
  });

  it('célula de planilha protegida contra fórmula', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('Ana "Bia"')).toBe('"Ana ""Bia"""');
  });
});
