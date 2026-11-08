import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, query } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { conflict, forbidden } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { emitTo } from '../lib/realtime.js';
import { CHANNEL_UPDATES, pushTo } from '../lib/push.js';
import { rideFor } from './rides.js';

type Params = { Params: { id: string } };

/** Enquanto dá para conversar: do aceite até o fim da corrida */
const OPEN = ['accepted', 'arrived', 'in_progress'];
/** Respostas prontas (o app mostra como botões) */
export const QUICK_REPLIES = {
  cliente: ['Estou saindo agora', 'Estou no local', 'Pode buzinar', 'Me espere um minuto, por favor'],
  motorista: ['Estou chegando', 'Cheguei', 'Estou em frente', 'Trânsito parado, já chego'],
};
export const CHAT_RETENTION_DAYS = 30;

const firstName = (n: string | null) => (n ? n.trim().split(/\s+/)[0] : '');
/** Modo família: no chat, o motorista fala com quem pediu (o titular), não com o parente que viaja */
const clientName = (r: any) => (r.requester_name ? firstName(r.requester_name) : firstName(r.passenger_name));

/** Apaga as conversas de corridas encerradas há mais de 30 dias (LGPD: guardar só o necessário) */
export async function purgeOldMessages() {
  const r = await query(
    `DELETE FROM ride_messages m USING rides r
      WHERE r.id = m.ride_id AND r.status IN ('completed', 'cancelled')
        AND coalesce(r.completed_at, r.cancelled_at, r.requested_at) < now() - make_interval(days => $1)
      RETURNING m.id`,
    [CHAT_RETENTION_DAYS],
  );
  return r.length;
}

export async function chatRoutes(app: FastifyInstance) {
  // passageiro, motorista, loja ou central da Saúde da corrida; o licenciado só lê (ocorrências)
  const anyone = { preHandler: requireAuth('passenger', 'driver', 'account_operator', 'tenant_admin') };

  async function chatFor(req: any, id: string) {
    const { r, viewer } = await rideFor(req, id);
    const side = viewer === 'driver' ? 'motorista' : viewer === 'admin' ? null : 'cliente';
    return { r, viewer, side: side as 'cliente' | 'motorista' | null };
  }

  app.get<Params>('/rides/:id/messages', anyone, async (req) => {
    const { r, side } = await chatFor(req, req.params.id);
    const rows = await query(
      `SELECT id, sender_side, body, created_at, read_at FROM ride_messages WHERE ride_id = $1 ORDER BY created_at LIMIT 300`,
      [r.id],
    );
    return {
      messages: rows.map((m) => ({ id: m.id, side: m.sender_side, mine: m.sender_side === side, body: m.body, at: m.created_at, read: !!m.read_at })),
      open: OPEN.includes(r.status) && !!r.driver_id && side !== null,
      quickReplies: side ? QUICK_REPLIES[side] : [],
      with: side === 'cliente' ? firstName(r.driver_name) : side === 'motorista' ? clientName(r) : null,
    };
  });

  app.post<Params>('/rides/:id/messages', { ...anyone, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { r, side } = await chatFor(req, req.params.id);
    if (!side) throw forbidden('A central só acompanha a conversa');
    if (!r.driver_id || !OPEN.includes(r.status)) throw conflict('O chat abre quando o motorista aceita e fecha no fim da corrida', 'chat_fechado');
    const { body } = parse(z.object({ body: z.string().trim().min(1, 'Escreva a mensagem').max(500, 'Mensagem muito longa') }), req.body);
    const m = await one(
      `INSERT INTO ride_messages (ride_id, sender_id, sender_side, body) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [r.id, req.auth.id, side, body],
    );
    const payload = { rideId: r.id, id: m.id, side, body, at: m.created_at };
    // quem está do outro lado recebe na hora (e por push, se o app estiver fechado)
    const others = side === 'motorista'
      ? [r.passenger_id ? `user:${r.passenger_id}` : null, r.account_id ? `account:${r.account_id}` : null].filter(Boolean) as string[]
      : [`user:${r.driver_id}`];
    emitTo([...others, `user:${req.auth.id}`], 'ride:message', payload);
    const pushTarget = side === 'motorista' ? r.passenger_id : r.driver_id;
    if (pushTarget) {
      const from = side === 'motorista' ? `Motorista ${firstName(r.driver_name)}` : clientName(r) || 'Cliente';
      await pushTo(pushTarget, {
        title: from, body: body.length > 120 ? `${body.slice(0, 117)}…` : body,
        channelId: CHANNEL_UPDATES, data: { type: 'ride_message', rideId: r.id },
      }).catch(() => {});
    }
    reply.code(201);
    return { message: { id: m.id, side, mine: true, body, at: m.created_at, read: false } };
  });

  // marca como lidas as mensagens do outro lado
  app.post<Params>('/rides/:id/messages/read', anyone, async (req) => {
    const { r, side } = await chatFor(req, req.params.id);
    if (!side) return { ok: true };
    const n = await query(
      `UPDATE ride_messages SET read_at = now() WHERE ride_id = $1 AND sender_side <> $2 AND read_at IS NULL RETURNING id`,
      [r.id, side],
    );
    return { ok: true, read: n.length };
  });
}

