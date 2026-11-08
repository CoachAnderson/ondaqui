import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, centro, destino, login, startServer, stopServer, type Ctx } from './helpers.js';
import { config } from '../src/lib/config.js';
import { one } from '../src/lib/db.js';
import { clearRouteCache } from '../src/lib/routing.js';

// OSRM simulado: responde como o osrm-routed de verdade
let osrm: Server;
let osrmUrl = '';
let calls: string[] = [];
let reply: { status?: number; delayMs?: number; body: unknown } = { body: {} };

const ok = (meters: number, seconds: number, snap = 5) => ({
  code: 'Ok',
  routes: [{ distance: meters, duration: seconds }],
  waypoints: [{ distance: snap }, { distance: snap }],
});

let ctx: Ctx;
let maria: string;

beforeAll(async () => {
  osrm = createServer((req, res) => {
    calls.push(req.url ?? '');
    setTimeout(() => {
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    }, reply.delayMs ?? 0);
  });
  await new Promise<void>((r) => osrm.listen(0, '127.0.0.1', () => r()));
  osrmUrl = `http://127.0.0.1:${(osrm.address() as { port: number }).port}`;
  ctx = await startServer();
  maria = await login(ctx, '14900000010');
});
afterAll(async () => {
  config.routingUrl = '';
  osrm.closeAllConnections();
  osrm.close();
  await stopServer(ctx);
});
beforeEach(() => {
  calls = [];
  clearRouteCache();
  config.routingUrl = osrmUrl;
  config.routingTimeoutMs = 1500;
});

const quote = (extra: Record<string, unknown> = {}) =>
  api(ctx, 'POST', '/rides/quote', { origin: centro, destination: destino, category: 'carro', ...extra }, maria);

describe('rotas reais pelas ruas (OSRM)', () => {
  it('sem serviço de rotas configurado, usa a estimativa', async () => {
    config.routingUrl = '';
    const q = await quote();
    expect(q.body.routeSource).toBe('estimativa');
    expect(calls).toHaveLength(0);
  });

  it('usa a distância e o tempo pelas ruas no preço', async () => {
    reply = { body: ok(7300, 600) };
    const q = await quote();
    expect(q.body).toMatchObject({ routeSource: 'rota', distanceKm: 7.3, durationMin: 13 }); // 10 min × 1,3 de trânsito
    // R$ 4,00 + 7,3 km × R$ 1,80 + 13 min × R$ 0,30 = R$ 21,04 → R$ 21,00
    expect(q.body.priceCents).toBe(2100);
    expect(calls[0]).toContain(`/route/v1/driving/${centro.lng},${centro.lat};${destino.lng},${destino.lat}`);
  });

  it('a cotação e o pedido usam a mesma rota, sem perguntar duas vezes', async () => {
    reply = { body: ok(7300, 600) };
    const q = await quote();
    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, category: 'carro', paymentMethod: 'pix' }, maria);
    expect(r.status).toBe(201);
    expect(r.body.ride.priceCents).toBe(q.body.priceCents);
    expect(r.body.ride.routeSource).toBe('rota');
    expect(calls).toHaveLength(1);
    expect((await one('SELECT route_source FROM rides WHERE id = $1', [r.body.ride.id])).route_source).toBe('rota');
    await api(ctx, 'POST', `/rides/${r.body.ride.id}/cancel`, {}, maria);
  });

  it('sem rota possível, volta para a estimativa', async () => {
    reply = { body: { code: 'NoRoute', routes: [] } };
    expect((await quote()).body.routeSource).toBe('estimativa');
  });

  it('endereço fora do mapa de rotas (longe de qualquer rua conhecida) usa a estimativa', async () => {
    reply = { body: ok(7300, 600, 2500) };
    expect((await quote()).body.routeSource).toBe('estimativa');
  });

  it('serviço de rotas lento ou fora do ar não trava o pedido', async () => {
    config.routingTimeoutMs = 200;
    reply = { body: ok(7300, 600), delayMs: 1500 };
    const t = Date.now();
    const q = await quote();
    expect(q.status).toBe(200);
    expect(q.body.routeSource).toBe('estimativa');
    expect(Date.now() - t).toBeLessThan(1200);

    config.routingUrl = 'http://127.0.0.1:1'; // nada escutando
    expect((await quote()).body.routeSource).toBe('estimativa');
  });

  it('todos os serviços usam a rota; o Particular continua por hora', async () => {
    reply = { body: ok(5000, 480) };
    const all = await api(ctx, 'POST', '/rides/quotes', { origin: centro, destination: destino, hours: 2 }, maria);
    const by = Object.fromEntries(all.body.quotes.map((x: any) => [x.category, x]));
    expect(by.moto).toMatchObject({ distanceKm: 5, routeSource: 'rota' });
    expect(by.particular.priceCents).toBe(9000);
  });
});

describe('rota desenhada no mapa', () => {
  // polyline de exemplo do Google (3 pontos): _p~iF~ps|U_ulLnnqC_mqNvxq`@
  const LINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

  it('o traçado do OSRM vem na cotação, fica na corrida e vai para o link da família', async () => {
    reply = { body: { ...ok(4200, 600), routes: [{ distance: 4200, duration: 600, geometry: LINE }] } };
    const q = await quote();
    expect(q.body.routePolyline).toBe(LINE);
    expect(calls[0]).toContain('geometries=polyline');

    const r = await api(ctx, 'POST', '/rides', { origin: centro, destination: destino, category: 'carro', paymentMethod: 'pix' }, maria);
    expect(r.body.ride.routePolyline).toBe(LINE);
    const joaoId = (await one(`SELECT id FROM users WHERE phone = '14900000020'`)).id;
    const row = await one(`UPDATE rides SET driver_id = $2, status = 'accepted' WHERE id = $1 RETURNING share_token`, [r.body.ride.id, joaoId]);
    const share = await api(ctx, 'GET', `/public/share/${row.share_token}`);
    expect(share.body.route).toMatchObject({ polyline: LINE, from: { lat: centro.lat }, to: { lat: destino.lat } });

    // caminho do motorista até o embarque
    await one(`UPDATE drivers SET lat = -22.3150, lng = -49.0700 WHERE user_id = $1 RETURNING user_id`, [joaoId]);
    reply = { body: { ...ok(1500, 240), routes: [{ distance: 1500, duration: 240, geometry: 'abc' }] } };
    const pick = await api(ctx, 'GET', `/rides/${r.body.ride.id}/pickup-route`, undefined, maria);
    expect(pick.body).toMatchObject({ polyline: 'abc', distanceKm: 1.5, source: 'rota' });
    await one(`UPDATE rides SET status = 'cancelled' WHERE id = $1 RETURNING id`, [r.body.ride.id]);
  });

  it('sem o serviço de rotas, não há traçado (o mapa mostra só os pontos)', async () => {
    config.routingUrl = '';
    const q = await quote();
    expect(q.body.routePolyline).toBeNull();
  });
});
