import type { FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { buildApp } from '../src/app.js';
import { pool, query } from '../src/lib/db.js';
import { seed } from '../src/seed.js';

export interface Ctx { app: FastifyInstance; base: string; sockets: Socket[] }

export async function startServer(): Promise<Ctx> {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  return { app, base: `http://127.0.0.1:${addr.port}`, sockets: [] };
}

export async function stopServer(ctx: Ctx) {
  ctx.sockets.forEach((s) => s.disconnect());
  await ctx.app.close();
  await pool.end();
}

export async function api(ctx: Ctx, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(ctx.base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** tenant null = login do master */
export async function login(ctx: Ctx, phone: string, tenant: string | null = 'bauru', password = 'ondaqui123') {
  const r = await api(ctx, 'POST', '/auth/login', { tenant: tenant ?? undefined, phone, password });
  if (r.status !== 200) throw new Error(`login falhou: ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

export async function connect(ctx: Ctx, token: string) {
  const s = ioClient(ctx.base, { auth: { token }, transports: ['websocket'], forceNew: true });
  ctx.sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.on('connect', () => resolve());
    s.on('connect_error', reject);
  });
  return s;
}

export function nextEvent<T = any>(s: Socket, event: string, ms = 3000) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`evento ${event} não chegou`)), ms);
    s.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

/** JPEG mínimo válido o bastante para a checagem de formato */
export const fakeSelfie = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]).toString('base64');

export const centro = { lat: -22.3246, lng: -49.0871, address: 'Praça Rui Barbosa, Centro, Bauru' };
export const destino = { lat: -22.3440, lng: -49.0520, address: 'Av. Getúlio Vargas, Bauru' };
