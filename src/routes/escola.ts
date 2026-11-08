import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, place, uuid } from '../lib/validate.js';
import { insideBox } from '../lib/geo.js';
import { routeTrip } from '../lib/routing.js';
import { CHANNEL_UPDATES, pushTo } from '../lib/push.js';
import { emitTo } from '../lib/realtime.js';
import { createSchoolCharge, syncCharge, tenantMpToken } from '../lib/billing.js';
import {
  TODAY_SQL, driverMarkTrip, ensureSchoolTrips, escolaPrice, escolaRulesOf, extendSchoolContract, loadSchoolTrips, parentAbsent,
  schoolPayouts, schoolTripView,
} from '../lib/escola.js';

type Params = { Params: { id: string } };
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'horário no formato 06:45');
const weekdays = z.array(z.number().int().min(1).max(6)).min(1, 'Escolha os dias').max(6);
const legs = z.enum(['ida', 'volta', 'ida_volta']);

const quoteBody = z.object({ schoolId: z.string().uuid(), home: place, legs, weekdays });
const contractBody = quoteBody.extend({
  studentName: z.string().trim().min(3, 'Nome do aluno').max(80),
  grade: z.string().trim().max(40).optional(),
  pickupTime: time.optional(),   // saída de casa (ida)
  returnTime: time.optional(),   // saída da escola (volta)
  notes: z.string().trim().max(300).optional(),
  // LGPD, art. 14: dados de criança só com consentimento específico de um dos pais ou responsável
  consent: z.literal(true, { error: 'Para contratar, confirme que você é o responsável e autoriza o uso dos dados do aluno' }),
});

const firstName = (n: string) => n.trim().split(/\s+/)[0];

function contractView(c: any) {
  return {
    id: c.id, studentName: c.student_name, grade: c.grade, status: c.status, legs: c.legs, weekdays: c.weekdays,
    pickupTime: c.pickup_time ? String(c.pickup_time).slice(0, 5) : null, returnTime: c.return_time ? String(c.return_time).slice(0, 5) : null,
    home: { address: c.home_address, lat: c.home_lat, lng: c.home_lng }, distanceKm: Number(c.distance_km), monthlyCents: c.monthly_cents,
    notes: c.notes, paidUntil: c.paid_until ? String(c.paid_until).slice(0, 10) : null, overdue: !!c.overdue, adminNote: c.admin_note,
    school: { id: c.school_id, name: c.school_name, address: c.school_address },
    driver: c.driver_id ? { id: c.driver_id, name: c.driver_name, vehicle: { model: c.vehicle_model, color: c.vehicle_color, plate: c.vehicle_plate } } : null,
    createdAt: c.created_at,
  };
}

const CONTRACT_SQL = `
  SELECT c.*, s.name AS school_name, s.address AS school_address, du.name AS driver_name, d.vehicle_model, d.vehicle_color, d.vehicle_plate,
         pu.name AS parent_name, pu.phone AS parent_phone,
         (c.status = 'ativo' AND (c.paid_until IS NULL OR c.paid_until < ${TODAY_SQL})) AS overdue
    FROM school_contracts c JOIN schools s ON s.id = c.school_id JOIN users pu ON pu.id = c.parent_id
    LEFT JOIN users du ON du.id = c.driver_id LEFT JOIN drivers d ON d.user_id = c.driver_id`;

export async function escolaRoutes(app: FastifyInstance) {
  const parent = { preHandler: requireAuth('passenger') };
  const driver = { preHandler: requireAuth('driver') };
  const admin = { preHandler: requireAuth('tenant_admin') };

  async function tenantOf(id: string) {
    return one(`SELECT * FROM tenants WHERE id = $1`, [id]);
  }

  async function quote(tenantId: string, b: z.infer<typeof quoteBody>) {
    const t = await tenantOf(tenantId);
    if (!t.escola_enabled) throw badRequest('O transporte escolar ainda não está disponível nesta cidade', 'escola_desligada');
    const s = await one(`SELECT * FROM schools WHERE id = $1 AND tenant_id = $2 AND active`, [b.schoolId, tenantId]);
    if (!s) throw notFound('Escola não encontrada');
    if (!insideBox(b.home, t)) throw badRequest(`Endereço fora da área de atendimento do ${t.name}`, 'fora_da_area');
    const trip = await routeTrip(b.home, { lat: s.lat, lng: s.lng });
    const km = Math.round(trip.distanceKm * 10) / 10;
    return { school: s, distanceKm: km, monthlyCents: escolaPrice(t, km, b.legs, b.weekdays) };
  }

  // ================= pais =================
  app.get('/escola', parent, async (req) => {
    const t = await tenantOf(req.auth.tenantId!);
    const schools = await query(`SELECT id, name, address, lat, lng FROM schools WHERE tenant_id = $1 AND active ORDER BY name`, [t.id]);
    const contracts = await query(`${CONTRACT_SQL} WHERE c.parent_id = $1 AND c.status <> 'encerrado' AND c.status <> 'recusado' ORDER BY c.created_at`, [req.auth.id]);
    await ensureSchoolTrips(undefined, t.id);
    const trips = await loadSchoolTrips(`c.parent_id = $1 AND tr.day = ${TODAY_SQL}`, [req.auth.id]);
    return {
      rules: { enabled: !!t.escola_enabled, graceDays: t.escola_grace_days }, schools,
      contracts: contracts.map(contractView), today: trips.map((r) => schoolTripView(r, 'parent')),
      available: !!(await tenantMpToken(t.id)),
    };
  });

  app.post('/escola/quote', parent, async (req) => {
    const r = await quote(req.auth.tenantId!, parse(quoteBody, req.body));
    return { distanceKm: r.distanceKm, monthlyCents: r.monthlyCents };
  });

  app.post('/escola/contracts', parent, async (req, reply) => {
    const b = parse(contractBody, req.body);
    if (b.legs !== 'volta' && !b.pickupTime) throw badRequest('Informe o horário de saída de casa', 'sem_horario_ida');
    if (b.legs !== 'ida' && !b.returnTime) throw badRequest('Informe o horário de saída da escola', 'sem_horario_volta');
    const q = await quote(req.auth.tenantId!, b);
    const c = await one(
      `INSERT INTO school_contracts (tenant_id, parent_id, student_name, grade, school_id, home_address, home_lat, home_lng, legs, weekdays,
                                     pickup_time, return_time, distance_km, monthly_cents, notes, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now()) RETURNING id`,
      [req.auth.tenantId, req.auth.id, b.studentName, b.grade ?? null, b.schoolId, b.home.address, b.home.lat, b.home.lng, b.legs,
       [...new Set(b.weekdays)].sort(), b.legs !== 'volta' ? b.pickupTime : null, b.legs !== 'ida' ? b.returnTime : null,
       q.distanceKm, q.monthlyCents, b.notes ?? null],
    );
    emitTo(`admin:${req.auth.tenantId}`, 'escola:request', { contractId: c.id });
    reply.code(201);
    return { contract: contractView((await one(`${CONTRACT_SQL} WHERE c.id = $1`, [c.id]))) };
  });

  async function myContract(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const c = await one(`${CONTRACT_SQL} WHERE c.id = $1 AND c.parent_id = $2`, [id, req.auth.id]);
    if (!c) throw notFound('Contrato não encontrado');
    return c;
  }

  // os pais encerram (a mensalidade já paga não é devolvida pelo app: fale com a central)
  app.post<Params>('/escola/contracts/:id/cancel', parent, async (req) => {
    const c = await myContract(req, req.params.id);
    if (['encerrado', 'recusado'].includes(c.status)) throw conflict('Este contrato já foi encerrado');
    await query(`UPDATE school_contracts SET status = 'encerrado', ended_at = now() WHERE id = $1`, [c.id]);
    await query(`UPDATE school_trips SET status = 'cancelado' WHERE contract_id = $1 AND status = 'previsto' AND day >= ${TODAY_SQL}`, [c.id]);
    emitTo(`admin:${req.auth.tenantId}`, 'escola:request', { contractId: c.id });
    if (c.driver_id) {
      await pushTo(c.driver_id, { title: 'Transporte escolar encerrado', body: `Os pais de ${firstName(c.student_name)} encerraram o contrato.`, channelId: CHANNEL_UPDATES, data: { type: 'escola' } }).catch(() => {});
    }
    return { ok: true };
  });

  app.post<Params>('/escola/contracts/:id/checkout', parent, async (req, reply) => {
    parse(uuid, req.params.id);
    const r = await createSchoolCharge(req.params.id, req.auth.id, req.auth.tenantId!);
    reply.code(201);
    return r;
  });

  app.post('/escola/sync', parent, async (req) => {
    const pending = await query<{ id: string }>(
      `SELECT id FROM charges WHERE passenger_id = $1 AND kind = 'escola' AND status IN ('pending', 'rejected', 'expired')
         AND created_at > now() - interval '72 hours' ORDER BY created_at DESC LIMIT 5`,
      [req.auth.id],
    );
    const results = [];
    for (const c of pending) {
      try { results.push(await syncCharge(c.id)); } catch { results.push('erro'); }
    }
    return { applied: results.includes('aplicado'), pending: results.includes('pendente') };
  });

  // "hoje ele não vai": avisa o motorista antes do embarque
  app.post<Params>('/escola/trips/:id/ausente', parent, async (req) => {
    parse(uuid, req.params.id);
    const t = await parentAbsent(req.auth.id, req.params.id);
    if (!t) throw conflict('Esta viagem já começou ou não existe');
    return { ok: true };
  });

  // ================= motorista =================
  app.get('/driver/escola', driver, async (req) => {
    await ensureSchoolTrips(undefined, req.auth.tenantId!);
    const trips = await loadSchoolTrips(`tr.driver_id = $1 AND tr.day = ${TODAY_SQL}`, [req.auth.id]);
    const contracts = await query(`${CONTRACT_SQL} WHERE c.driver_id = $1 AND c.status = 'ativo' ORDER BY c.pickup_time NULLS LAST, c.student_name`, [req.auth.id]);
    return {
      today: trips.map((r) => schoolTripView(r, 'driver')),
      students: contracts.map((c) => ({ ...contractView(c), parent: { name: firstName(c.parent_name), phone: c.parent_phone }, driver: undefined, monthlyCents: undefined })),
    };
  });

  for (const action of ['embarcou', 'entregue', 'ausente'] as const) {
    app.post<Params>(`/driver/escola/trips/:id/${action}`, driver, async (req) => {
      parse(uuid, req.params.id);
      const t = await driverMarkTrip(req.auth.id, req.params.id, action);
      if (!t) throw conflict('Ação indisponível para esta viagem');
      return { ok: true };
    });
  }

  // ================= central =================
  async function adminView(tenantId: string, month?: string) {
    const t = await tenantOf(tenantId);
    await ensureSchoolTrips(undefined, tenantId);
    const m = month ?? (await one<{ m: string }>(`SELECT date_trunc('month', ${TODAY_SQL})::date::text AS m`))!.m;
    return {
      rules: escolaRulesOf(t),
      mercadopago: !!t.mp_access_token_enc,
      schools: await query(
        `SELECT s.*, (SELECT count(*) FROM school_contracts c WHERE c.school_id = s.id AND c.status = 'ativo')::int AS students
           FROM schools s WHERE s.tenant_id = $1 ORDER BY s.active DESC, s.name`, [tenantId]),
      contracts: (await query(`${CONTRACT_SQL} WHERE c.tenant_id = $1 AND c.status <> 'recusado' ORDER BY (c.status = 'solicitado') DESC, c.status, c.student_name`, [tenantId]))
        .map((c) => ({ ...contractView(c), parent: { name: c.parent_name, phone: c.parent_phone } })),
      drivers: await query(
        `SELECT u.id, u.name, d.vehicle_model, d.vehicle_plate,
                (SELECT count(*) FROM school_contracts c WHERE c.driver_id = u.id AND c.status = 'ativo')::int AS students
           FROM drivers d JOIN users u ON u.id = d.user_id
          WHERE u.tenant_id = $1 AND d.status = 'approved' AND NOT u.blocked AND u.deleted_at IS NULL AND 'escolar' = ANY(d.verified)
          ORDER BY u.name`, [tenantId]),
      today: (await loadSchoolTrips(`tr.tenant_id = $1 AND tr.day = ${TODAY_SQL}`, [tenantId])).map((r) => schoolTripView(r, 'admin')),
      daysOff: await query(`SELECT day::text AS day, note FROM school_days_off WHERE tenant_id = $1 AND day >= ${TODAY_SQL} - 30 ORDER BY day`, [tenantId]),
      month: m,
      payouts: await schoolPayouts(tenantId, m),
    };
  }

  app.get<{ Querystring: { mes?: string } }>('/admin/escola', admin, async (req) => {
    const mes = req.query.mes ? parse(z.string().regex(/^\d{4}-\d{2}$/), req.query.mes) : undefined;
    return adminView(req.auth.tenantId!, mes ? `${mes}-01` : undefined);
  });

  app.patch('/admin/escola', admin, async (req) => {
    const b = parse(z.object({
      enabled: z.boolean().optional(),
      baseCents: z.number().int().min(0).max(1_000_000).optional(),
      perKmCents: z.number().int().min(0).max(100_000).optional(),
      commissionPct: z.number().min(0).max(50).optional(),
      graceDays: z.number().int().min(0).max(30).optional(),
    }), req.body);
    await query(
      `UPDATE tenants SET escola_enabled = coalesce($2, escola_enabled), escola_base_cents = coalesce($3, escola_base_cents),
              escola_per_km_cents = coalesce($4, escola_per_km_cents), escola_commission_pct = coalesce($5, escola_commission_pct),
              escola_grace_days = coalesce($6, escola_grace_days) WHERE id = $1`,
      [req.auth.tenantId, b.enabled ?? null, b.baseCents ?? null, b.perKmCents ?? null, b.commissionPct ?? null, b.graceDays ?? null],
    );
    return adminView(req.auth.tenantId!);
  });

  app.post('/admin/escola/schools', admin, async (req, reply) => {
    const b = parse(z.object({ name: z.string().trim().min(3).max(100), place }), req.body);
    const s = await one(
      `INSERT INTO schools (tenant_id, name, address, lat, lng) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.auth.tenantId, b.name, b.place.address, b.place.lat, b.place.lng],
    );
    reply.code(201);
    return { school: s };
  });

  app.patch<Params>('/admin/escola/schools/:id', admin, async (req) => {
    parse(uuid, req.params.id);
    const b = parse(z.object({ name: z.string().trim().min(3).max(100).optional(), active: z.boolean().optional() }), req.body);
    const s = await one(
      `UPDATE schools SET name = coalesce($3, name), active = coalesce($4, active) WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [req.params.id, req.auth.tenantId, b.name ?? null, b.active ?? null],
    );
    if (!s) throw notFound('Escola não encontrada');
    return { school: s };
  });

  async function contractOfTenant(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const c = await one(`${CONTRACT_SQL} WHERE c.id = $1 AND c.tenant_id = $2`, [id, req.auth.tenantId]);
    if (!c) throw notFound('Contrato não encontrado');
    return c;
  }

  // a central escolhe o motorista (só os liberados para transporte escolar) e pode ajustar a mensalidade
  app.post<Params>('/admin/escola/contracts/:id/assign', admin, async (req) => {
    const c = await contractOfTenant(req, req.params.id);
    const b = parse(z.object({ driverId: z.string().uuid(), monthlyCents: z.number().int().min(100).max(1_000_000).optional() }), req.body);
    if (!['solicitado', 'ativo', 'pausado'].includes(c.status)) throw conflict('Este contrato está encerrado');
    const d = await one(
      `SELECT u.id, u.name FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE u.id = $1 AND u.tenant_id = $2 AND d.status = 'approved' AND NOT u.blocked AND 'escolar' = ANY(d.verified)`,
      [b.driverId, req.auth.tenantId],
    );
    if (!d) throw badRequest('Escolha um motorista liberado para transporte escolar (CNH D, curso e autorização conferidos)', 'motorista_nao_escolar');
    await tx(async (db) => {
      await query(
        `UPDATE school_contracts SET driver_id = $2, monthly_cents = coalesce($3, monthly_cents), status = 'ativo', started_at = coalesce(started_at, now())
          WHERE id = $1`,
        [c.id, d.id, b.monthlyCents ?? null], db,
      );
      // viagens já montadas passam para o motorista novo
      await query(`UPDATE school_trips SET driver_id = $2 WHERE contract_id = $1 AND status = 'previsto' AND day >= ${TODAY_SQL}`, [c.id, d.id], db);
    });
    const firstPay = !c.paid_until;
    await pushTo(c.parent_id, {
      title: 'Transporte escolar confirmado',
      body: `${firstName(d.name)} vai levar ${firstName(c.student_name)}.${firstPay ? ' Pague a primeira mensalidade pelo app para começar.' : ''}`,
      channelId: CHANNEL_UPDATES, data: { type: 'escola' },
    }).catch(() => {});
    await pushTo(d.id, {
      title: 'Novo aluno no transporte escolar',
      body: `${firstName(c.student_name)}, ${c.school_name}. Veja os horários no app.`, channelId: CHANNEL_UPDATES, data: { type: 'escola' },
    }).catch(() => {});
    emitTo(`user:${c.parent_id}`, 'escola:updated', { contractId: c.id });
    return { contract: contractView(await one(`${CONTRACT_SQL} WHERE c.id = $1`, [c.id])) };
  });

  for (const [action, status] of [['refuse', 'recusado'], ['pause', 'pausado'], ['resume', 'ativo'], ['end', 'encerrado']] as const) {
    app.post<Params>(`/admin/escola/contracts/:id/${action}`, admin, async (req) => {
      const c = await contractOfTenant(req, req.params.id);
      const { note } = parse(z.object({ note: z.string().trim().max(200).optional() }), req.body ?? {});
      const allowed: Record<string, string[]> = { refuse: ['solicitado'], pause: ['ativo'], resume: ['pausado'], end: ['ativo', 'pausado', 'solicitado'] };
      if (!allowed[action].includes(c.status)) throw conflict('Ação indisponível para este contrato');
      if (action === 'resume' && !c.driver_id) throw conflict('Escolha um motorista primeiro');
      await query(
        `UPDATE school_contracts SET status = $2, admin_note = coalesce($3, admin_note), ended_at = CASE WHEN $2 IN ('encerrado','recusado') THEN now() ELSE ended_at END
          WHERE id = $1`,
        [c.id, status, note ?? null],
      );
      if (status !== 'ativo') {
        await query(`UPDATE school_trips SET status = 'cancelado' WHERE contract_id = $1 AND status = 'previsto' AND day >= ${TODAY_SQL}`, [c.id]);
      }
      const msg: Record<string, string> = {
        refuse: `A central não conseguiu atender o transporte de ${firstName(c.student_name)}${note ? `: ${note}` : '.'}`,
        pause: `O transporte de ${firstName(c.student_name)} foi pausado pela central${note ? `: ${note}` : '.'}`,
        resume: `O transporte de ${firstName(c.student_name)} voltou.`,
        end: `O transporte de ${firstName(c.student_name)} foi encerrado pela central${note ? `: ${note}` : '.'}`,
      };
      await pushTo(c.parent_id, { title: 'Transporte escolar', body: msg[action], channelId: CHANNEL_UPDATES, data: { type: 'escola' } }).catch(() => {});
      emitTo(`user:${c.parent_id}`, 'escola:updated', { contractId: c.id });
      return { ok: true, status };
    });
  }

  // mensalidade recebida na central (dinheiro, Pix direto)
  app.post<Params>('/admin/escola/contracts/:id/mark-paid', admin, async (req) => {
    const c = await contractOfTenant(req, req.params.id);
    const { months } = parse(z.object({ months: z.number().int().min(1).max(12).default(1) }), req.body ?? {});
    if (!['ativo', 'pausado'].includes(c.status)) throw conflict('Escolha o motorista antes de registrar pagamento');
    const until = await tx((db) => extendSchoolContract(db, c.id, months, c.monthly_cents * months, { by: req.auth.id }));
    emitTo(`user:${c.parent_id}`, 'escola:paid', { contractId: c.id, until });
    return { paidUntil: until };
  });

  app.post('/admin/escola/days-off', admin, async (req) => {
    const b = parse(z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().trim().max(80).optional(),
    }), req.body);
    const r = await query(
      `INSERT INTO school_days_off (tenant_id, day, note)
       SELECT $1, g::date, $4 FROM generate_series($2::date, coalesce($3::date, $2::date), interval '1 day') g
        WHERE coalesce($3::date, $2::date) - $2::date <= 120
       ON CONFLICT (tenant_id, day) DO UPDATE SET note = EXCLUDED.note RETURNING day`,
      [req.auth.tenantId, b.from, b.to ?? null, b.note ?? null],
    );
    if (r.length === 0) throw badRequest('Período inválido (até 120 dias de uma vez)');
    // viagens já montadas nesses dias saem
    await query(
      `UPDATE school_trips SET status = 'cancelado' WHERE tenant_id = $1 AND status = 'previsto' AND day BETWEEN $2::date AND coalesce($3::date, $2::date)`,
      [req.auth.tenantId, b.from, b.to ?? null],
    );
    return { days: r.length };
  });

  app.delete<{ Params: { day: string } }>('/admin/escola/days-off/:day', admin, async (req) => {
    const day = parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), req.params.day);
    await query(`DELETE FROM school_days_off WHERE tenant_id = $1 AND day = $2::date`, [req.auth.tenantId, day]);
    return { ok: true };
  });

  // repasse do mês ao motorista: a central paga por Pix e dá baixa aqui
  app.post('/admin/escola/payouts', admin, async (req) => {
    const b = parse(z.object({ driverId: z.string().uuid(), month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
    const rows = await schoolPayouts(req.auth.tenantId!, `${b.month}-01`);
    const p = rows.find((r) => r.driver_id === b.driverId);
    if (!p) throw notFound('Nada a repassar a este motorista no mês');
    const r = await one(
      `INSERT INTO school_payouts (tenant_id, driver_id, month, received_cents, commission_cents, amount_cents, registered_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7) ON CONFLICT (driver_id, month) DO NOTHING RETURNING *`,
      [req.auth.tenantId, b.driverId, `${b.month}-01`, p.received_cents, p.commission_cents, p.amount_cents, req.auth.id],
    );
    if (!r) throw conflict('Este repasse já foi registrado');
    await pushTo(b.driverId, {
      title: 'Repasse do transporte escolar', body: `A central registrou o pagamento de R$ ${(p.amount_cents / 100).toFixed(2).replace('.', ',')} do mês.`,
      channelId: CHANNEL_UPDATES, data: { type: 'escola' },
    }).catch(() => {});
    return { payout: r };
  });
}
