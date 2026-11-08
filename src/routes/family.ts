import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, phone, uuid } from '../lib/validate.js';
import { loadRide, rideView } from '../lib/rides.js';

/** Quantos parentes um titular pode cadastrar */
export const FAMILY_MAX = 10;

const memberBody = z.object({
  name: z.string().trim().min(2, 'Nome muito curto').max(80),
  phone,
  relation: z.string().trim().min(2).max(30),
  declaredWoman: z.boolean().optional(),
  monthlyLimitCents: z.number().int().min(500).max(1_000_000).nullable().optional(),
  notes: z.string().trim().max(200).nullable().optional(),
});

/** Quanto já foi gasto no mês com corridas para este parente (sem as canceladas) */
export async function familySpentThisMonth(memberId: string) {
  const r = await one<{ spent: number }>(
    `SELECT coalesce(sum(price_cents), 0)::int AS spent FROM rides
      WHERE family_member_id = $1 AND status <> 'cancelled' AND requested_at >= date_trunc('month', now())`,
    [memberId],
  );
  return r?.spent ?? 0;
}

/** Parente do titular, ativo; usado no pedido da corrida */
export async function familyMemberOf(ownerId: string, memberId: string) {
  parse(uuid, memberId);
  const m = await one(`SELECT * FROM family_members WHERE id = $1 AND owner_id = $2 AND active`, [memberId, ownerId]);
  if (!m) throw notFound('Parente não encontrado');
  return m;
}

/** O limite do mês não pode ser ultrapassado com a corrida nova */
export async function checkFamilyLimit(member: any, priceCents: number) {
  if (!member.monthly_limit_cents) return;
  const spent = await familySpentThisMonth(member.id);
  if (spent + priceCents > member.monthly_limit_cents) {
    const left = Math.max(0, member.monthly_limit_cents - spent);
    throw new HttpError(402,
      `Esta corrida passa do limite do mês para ${member.name.split(/\s+/)[0]}. Sobram R$ ${(left / 100).toFixed(2).replace('.', ',')}. Aumente o limite em Família.`,
      'limite_familia');
  }
}

const view = (m: any, spent: number) => ({
  id: m.id, name: m.name, phone: m.phone, relation: m.relation, declaredWoman: m.declared_woman,
  monthlyLimitCents: m.monthly_limit_cents, spentThisMonthCents: spent, notes: m.notes, createdAt: m.created_at,
  lastPickup: m.pickup_lat != null ? { address: m.pickup_address, lat: m.pickup_lat, lng: m.pickup_lng } : null,
});

export async function familyRoutes(app: FastifyInstance) {
  const passenger = { preHandler: requireAuth('passenger') };

  async function mine(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const m = await one(`SELECT * FROM family_members WHERE id = $1 AND owner_id = $2 AND active`, [id, req.auth.id]);
    if (!m) throw notFound('Parente não encontrado');
    return m;
  }

  app.get('/family/members', passenger, async (req) => {
    const rows = await query(`SELECT * FROM family_members WHERE owner_id = $1 AND active ORDER BY name`, [req.auth.id]);
    const members = [];
    for (const m of rows) members.push(view(m, await familySpentThisMonth(m.id)));
    return { members, max: FAMILY_MAX };
  });

  app.post('/family/members', passenger, async (req, reply) => {
    const b = parse(memberBody.extend({
      // LGPD: o titular informa dados de outra pessoa e declara que ela concorda
      consent: z.literal(true, { error: 'Confirme que o parente sabe e concorda com o cadastro' }),
    }), req.body);
    const n = await one(`SELECT count(*)::int AS n FROM family_members WHERE owner_id = $1 AND active`, [req.auth.id]);
    if ((n?.n ?? 0) >= FAMILY_MAX) throw conflict(`Dá para cadastrar até ${FAMILY_MAX} parentes`, 'familia_cheia');
    const me = await one(`SELECT phone FROM users WHERE id = $1`, [req.auth.id]);
    if (me?.phone === b.phone) throw badRequest('Este é o seu próprio celular', 'proprio_celular');
    try {
      const m = await one(
        `INSERT INTO family_members (owner_id, name, phone, relation, declared_woman, monthly_limit_cents, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (owner_id, phone) DO UPDATE SET name = $2, relation = $4, declared_woman = $5, monthly_limit_cents = $6,
                                                      notes = $7, active = true
         RETURNING *`,
        [req.auth.id, b.name, b.phone, b.relation, b.declaredWoman ?? false, b.monthlyLimitCents ?? null, b.notes ?? null],
      );
      reply.code(201);
      return { member: view(m, await familySpentThisMonth(m.id)) };
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Este celular já está na sua família', 'parente_repetido');
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>('/family/members/:id', passenger, async (req) => {
    const m = await mine(req, req.params.id);
    const b = parse(memberBody.partial(), req.body);
    const u = await one(
      `UPDATE family_members SET name = $2, phone = $3, relation = $4, declared_woman = $5, monthly_limit_cents = $6, notes = $7
        WHERE id = $1 RETURNING *`,
      [m.id, b.name ?? m.name, b.phone ?? m.phone, b.relation ?? m.relation, b.declaredWoman ?? m.declared_woman,
       b.monthlyLimitCents === undefined ? m.monthly_limit_cents : b.monthlyLimitCents,
       b.notes === undefined ? m.notes : b.notes],
    );
    return { member: view(u, await familySpentThisMonth(u.id)) };
  });

  // remove o parente e os dados dele (LGPD); as corridas antigas ficam no histórico, sem o nome
  app.delete<{ Params: { id: string } }>('/family/members/:id', passenger, async (req) => {
    const m = await mine(req, req.params.id);
    const busy = await one(
      `SELECT 1 FROM rides WHERE family_member_id = $1 AND status IN ('scheduled','requested','accepted','arrived','in_progress') LIMIT 1`, [m.id],
    );
    if (busy) throw conflict('Este parente tem uma corrida em andamento ou agendada', 'parente_em_corrida');
    await query(`UPDATE rides SET family_member_id = NULL WHERE family_member_id = $1`, [m.id]);
    await query(`DELETE FROM family_members WHERE id = $1`, [m.id]);
    return { ok: true };
  });

  // corridas da família em andamento (o titular acompanha todas, além da dele)
  app.get('/family/rides', passenger, async (req) => {
    const rows = await query(
      `SELECT id FROM rides WHERE passenger_id = $1 AND family_member_id IS NOT NULL
          AND status IN ('requested','accepted','arrived','in_progress') ORDER BY requested_at DESC`,
      [req.auth.id],
    );
    const rides = [];
    for (const r of rows) rides.push(rideView(await loadRide(r.id), 'passenger'));
    return { rides };
  });
}
