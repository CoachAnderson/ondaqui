import { Server } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { verifyToken } from './auth.js';
import { one } from './db.js';
import { config } from './config.js';

/**
 * Salas do Socket.IO:
 *  user:<id>        cada pessoa logada (ofertas para o motorista, avisos)
 *  admin:<tenantId> painel do licenciado (mapa, alertas)
 *  ride:<id>        participantes de uma corrida (status, posição do motorista)
 *  account:<id>     central da Saúde de um convênio (viagens dos pacientes)
 */
let io: Server | null = null;

export function attachRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: config.corsOrigins.length ? config.corsOrigins : '*' } });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('nao_autenticado'));
      socket.data.user = verifyToken(token);
      next();
    } catch {
      next(new Error('nao_autenticado'));
    }
  });

  io.on('connection', async (socket) => {
    const u = socket.data.user as ReturnType<typeof verifyToken>;
    socket.join(`user:${u.id}`);
    if (u.role === 'tenant_admin' && u.tenantId) socket.join(`admin:${u.tenantId}`);
    if (u.role === 'account_operator') {
      const a = await one<{ account_id: string | null }>('SELECT account_id FROM users WHERE id = $1', [u.id]).catch(() => undefined);
      if (a?.account_id) socket.join(`account:${a.account_id}`);
    }

    // acompanhar uma corrida (só participantes ou o licenciado dela)
    socket.on('ride:watch', async (rideId: string, ack?: (ok: boolean) => void) => {
      const ride = await one<{ tenant_id: string; passenger_id: string | null; driver_id: string | null; account_ok: boolean }>(
        `SELECT r.tenant_id, r.passenger_id, r.driver_id,
                EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.account_id IS NOT NULL AND u.account_id = r.account_id) AS account_ok
           FROM rides r WHERE r.id = $1`,
        [rideId, u.id],
      ).catch(() => undefined);
      const allowed =
        !!ride &&
        (ride.passenger_id === u.id ||
          ride.driver_id === u.id ||
          ride.account_ok ||
          (u.role === 'tenant_admin' && ride.tenant_id === u.tenantId));
      if (allowed) socket.join(`ride:${rideId}`);
      ack?.(allowed);
    });
  });
  return io;
}

export function emitTo(room: string | string[], event: string, payload: unknown) {
  io?.to(room).emit(event, payload);
}

/** Desconecta os clientes; o servidor HTTP é fechado pelo Fastify. */
export function closeRealtime() {
  io?.disconnectSockets(true);
  io = null;
}
