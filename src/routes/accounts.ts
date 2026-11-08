import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { hashPassword, requireAuth } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, phone, place, uuid } from '../lib/validate.js';
import { dispatchRide, loadRide, newBoardingCode, newShareToken, notifyRide, rideView } from '../lib/rides.js';
import { emitTo } from '../lib/realtime.js';
import { checkSchedule, computeQuote } from './rides.js';
import { sendImage } from '../lib/images.js';

/**
 * Daqui Prefeitura — transporte de pacientes por convênio.
 * O licenciado cadastra o convênio (ex.: Secretaria Municipal de Saúde) e os operadores.
 * O operador cadastra pacientes, agenda as viagens (ida e volta) e acompanha tudo ao vivo.
 * No fim do mês sai o relatório para a Prefeitura pagar a central, que repassa aos motoristas.
 */

type Params = { Params: { id: string } };

const operatorSchema = z.object({
  name: z.string().trim().min(3).max(80),
  phone,
  password: z.string().min(8).max(100),
});

const accountSchema = z.object({
  name: z.string().trim().min(3).max(120),
  document: z.string().trim().max(30).optional(),
  contactName: z.string().trim().max(80).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  // conta loja (Daqui Entrega)
  kind: z.enum(['prefeitura', 'loja']).default('prefeitura'),
  address: place.optional(),
  billingMode: z.enum(['prepago', 'fatura']).optional(),
  creditLimitCents: z.number().int().min(0).max(10_000_000).optional(),
  discountPct: z.number().min(0).max(50).optional(),
});

const patientSchema = z.object({
  name: z.string().trim().min(3).max(100),
  phone,
  document: z.string().trim().max(30).optional(),
  home: place,
  wheelchair: z.boolean().default(false),
  needsCompanion: z.boolean().default(false),
  notes: z.string().trim().max(300).optional(),
});

// destino salvo (hospital, UBS) vai com o nome: "Hospital Estadual — Av. ..."
const namedPlace = place.extend({ name: z.string().trim().max(80).optional() })
  .transform(({ name, ...p }) => ({ ...p, address: name && !p.address.startsWith(name) ? `${name} — ${p.address}`.slice(0, 200) : p.address }));

const tripSchema = z.object({
  patientId: uuid,
  origin: namedPlace.optional(),     // padrão: endereço do paciente
  destination: namedPlace,
  scheduledFor: z.string().datetime({ offset: true }).optional(),
  returnAt: z.string().datetime({ offset: true }).optional(), // volta já agendada
  companion: z.boolean().optional(),
  wheelchair: z.boolean().optional(),
  notes: z.string().trim().max(300).optional(),
});

const monthSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'use AAAA-MM').optional() });

const currentMonth = () => new Date().toISOString().slice(0, 7);

// ---------- relatório mensal (licenciado e operador veem o mesmo) ----------
export async function accountReport(accountId: string, month: string, internal = false) {
  const start = `${month}-01`;
  const rows = await query(
    `SELECT r.id, r.completed_at, r.scheduled_for, r.origin_address, r.dest_address, r.distance_km, r.price_cents,
            r.commission_cents, r.companion, r.wheelchair, pt.name AS patient, pt.document AS patient_document,
            du.name AS driver, d.vehicle_plate
       FROM rides r
       JOIN patients pt ON pt.id = r.patient_id
       LEFT JOIN users du ON du.id = r.driver_id
       LEFT JOIN drivers d ON d.user_id = r.driver_id
      WHERE r.account_id = $1 AND r.status = 'completed'
        AND r.completed_at >= $2::date AND r.completed_at < ($2::date + interval '1 month')
      ORDER BY r.completed_at`,
    [accountId, start],
  );
  const cancelled = await one(
    `SELECT count(*)::int AS n FROM rides WHERE account_id = $1 AND status = 'cancelled'
        AND requested_at >= $2::date AND requested_at < ($2::date + interval '1 month')`,
    [accountId, start],
  );
  type DriverTotal = { driver: string; plate: string; trips: number; totalCents: number; commissionCents?: number; netCents?: number };
  const byDriver = new Map<string, DriverTotal>();
  for (const r of rows) {
    const k = `${r.driver}|${r.vehicle_plate}`;
    const cur: DriverTotal = byDriver.get(k) ?? { driver: r.driver, plate: r.vehicle_plate, trips: 0, totalCents: 0 };
    cur.trips += 1;
    cur.totalCents += r.price_cents;
    // só o licenciado vê: o repasse ao motorista já sem a comissão do plano dele
    if (internal) {
      cur.commissionCents = (cur.commissionCents ?? 0) + (r.commission_cents ?? 0);
      cur.netCents = cur.totalCents - (cur.commissionCents ?? 0);
    }
    byDriver.set(k, cur);
  }
  for (const r of rows) delete r.commission_cents;
  return {
    month,
    trips: rows.length,
    totalCents: rows.reduce((s, r) => s + r.price_cents, 0),
    distanceKm: Math.round(rows.reduce((s, r) => s + Number(r.distance_km), 0) * 10) / 10,
    patients: new Set(rows.map((r) => r.patient)).size,
    cancelled: cancelled!.n,
    byDriver: [...byDriver.values()].sort((a, b) => b.totalCents - a.totalCents),
    rows,
  };
}

function reportCsv(rep: Awaited<ReturnType<typeof accountReport>>, accountName: string) {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    // evita fórmulas ao abrir no Excel e escapa aspas
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const lines = [
    [`Relatório de transporte de pacientes — ${accountName} — ${rep.month}`],
    [],
    ['Data', 'Paciente', 'Documento', 'Saída', 'Destino', 'Km', 'Acompanhante', 'Cadeirante', 'Motorista', 'Placa', 'Valor (R$)'],
    ...rep.rows.map((r: any) => [
      new Date(r.completed_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      r.patient, r.patient_document, r.origin_address, r.dest_address, String(r.distance_km).replace('.', ','),
      r.companion ? 'sim' : 'não', r.wheelchair ? 'sim' : 'não', r.driver, r.vehicle_plate, money(r.price_cents),
    ]),
    [],
    ['Total de viagens', rep.trips],
    ['Valor total (R$)', money(rep.totalCents)],
  ];
  return '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
}

async function sendReport(reply: FastifyReply, accountId: string, month: string, csv: boolean, internal = false) {
  const acc = await one('SELECT name FROM accounts WHERE id = $1', [accountId]);
  const rep = await accountReport(accountId, month, internal);
  if (!csv) return { account: acc?.name, ...rep };
  reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="pacientes-${month}.csv"`);
  return reportCsv(rep, acc?.name ?? '');
}

export async function accountRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAuth('tenant_admin') };
  const operator = { preHandler: requireAuth('account_operator') };

  async function accountOfTenant(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const a = await one('SELECT * FROM accounts WHERE id = $1 AND tenant_id = $2', [id, req.auth.tenantId]);
    if (!a) throw notFound('Convênio não encontrado');
    return a;
  }

  async function createOperator(tenantId: string, accountId: string, o: z.infer<typeof operatorSchema>, db?: any) {
    const exists = await one('SELECT 1 FROM users WHERE tenant_id = $1 AND phone = $2', [tenantId, o.phone], db);
    if (exists) throw conflict('Este telefone já tem cadastro nesta cidade', 'telefone_em_uso');
    return one(
      `INSERT INTO users (tenant_id, role, name, phone, password_hash, account_id)
       VALUES ($1,'account_operator',$2,$3,$4,$5) RETURNING id, name, phone`,
      [tenantId, o.name, o.phone, await hashPassword(o.password), accountId], db,
    );
  }

  // ================= licenciado =================

  app.get<{ Querystring: { kind?: string } }>('/admin/accounts', admin, async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(['prefeitura', 'loja']).optional() }), req.query);
    const rows = await query(
      `SELECT a.*,
              (SELECT count(*) FROM patients p WHERE p.account_id = a.id AND p.active)::int AS patients,
              (SELECT count(*) FROM rides r WHERE r.account_id = a.id AND r.status = 'completed'
                 AND r.completed_at >= date_trunc('month', now()))::int AS trips_month,
              (SELECT coalesce(sum(price_cents), 0) FROM rides r WHERE r.account_id = a.id AND r.status = 'completed'
                 AND r.completed_at >= date_trunc('month', now()))::int AS total_month_cents,
              (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'phone', u.phone, 'blocked', u.blocked))
                 FROM users u WHERE u.account_id = a.id) AS operators,
              (SELECT count(*) FROM rides r WHERE r.account_id = a.id AND r.kind = 'entrega' AND r.status = 'completed'
                 AND r.completed_at >= date_trunc('month', now()))::int AS deliveries_month,
              (SELECT coalesce(sum(total_cents), 0) FROM store_invoices i WHERE i.account_id = a.id AND i.status = 'open')::int AS open_invoices_cents,
              (a.mp_access_token_enc IS NOT NULL) AS mp_connected, (a.logo_path IS NOT NULL) AS has_logo
         FROM accounts a WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.kind = $2) ORDER BY a.created_at`,
      [req.auth.tenantId, kind ?? null],
    );
    // nunca devolve os tokens criptografados
    return { accounts: rows.map(({ mp_access_token_enc, mp_webhook_secret_enc, logo_path, ...r }) => ({ ...r, operators: r.operators ?? [] })) };
  });

  app.post('/admin/accounts', admin, async (req, reply) => {
    const b = parse(accountSchema.extend({ operator: operatorSchema }), req.body);
    const acc = await tx(async (db) => {
      const a = await one(
        `INSERT INTO accounts (tenant_id, name, document, contact_name, contact_phone, kind, address, lat, lng,
                               billing_mode, credit_limit_cents, discount_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, name, kind`,
        [req.auth.tenantId, b.name, b.document ?? null, b.contactName ?? null, b.contactPhone ?? null, b.kind,
         b.address?.address ?? null, b.address?.lat ?? null, b.address?.lng ?? null,
         b.billingMode ?? 'prepago', b.creditLimitCents ?? 0, b.discountPct ?? 0], db,
      );
      await createOperator(req.auth.tenantId!, a.id, b.operator, db);
      return a;
    });
    reply.code(201);
    return { account: acc };
  });

  app.patch<Params>('/admin/accounts/:id', admin, async (req) => {
    const a = await accountOfTenant(req, req.params.id);
    const b = parse(accountSchema.partial().omit({ kind: true }).extend({
      active: z.boolean().optional(), pixValidated: z.boolean().optional(),
    }), req.body);
    if (b.pixValidated && !a.pix_key) throw badRequest('A loja não cadastrou chave Pix');
    return {
      account: await one(
        `UPDATE accounts SET name = coalesce($2, name), document = coalesce($3, document), contact_name = coalesce($4, contact_name),
                contact_phone = coalesce($5, contact_phone), active = coalesce($6, active),
                billing_mode = coalesce($7, billing_mode), credit_limit_cents = coalesce($8, credit_limit_cents),
                discount_pct = coalesce($9, discount_pct), pix_validated = coalesce($10, pix_validated),
                address = coalesce($11, address), lat = coalesce($12, lat), lng = coalesce($13, lng)
          WHERE id = $1
          RETURNING id, name, kind, active, billing_mode, credit_limit_cents, discount_pct, pix_key, pix_holder_name, pix_validated, balance_cents`,
        [a.id, b.name ?? null, b.document ?? null, b.contactName ?? null, b.contactPhone ?? null, b.active ?? null,
         b.billingMode ?? null, b.creditLimitCents ?? null, b.discountPct ?? null, b.pixValidated ?? null,
         b.address?.address ?? null, b.address?.lat ?? null, b.address?.lng ?? null],
      ),
    };
  });

  app.post<Params>('/admin/accounts/:id/operators', admin, async (req, reply) => {
    const a = await accountOfTenant(req, req.params.id);
    const op = await createOperator(req.auth.tenantId!, a.id, parse(operatorSchema, req.body));
    reply.code(201);
    return { operator: op };
  });

  app.get<Params & { Querystring: { month?: string } }>('/admin/accounts/:id/report', admin, async (req, reply) => {
    const a = await accountOfTenant(req, req.params.id);
    const { month } = parse(monthSchema, req.query);
    return sendReport(reply, a.id, month ?? currentMonth(), false, true);
  });

  app.get<Params & { Querystring: { month?: string } }>('/admin/accounts/:id/report.csv', admin, async (req, reply) => {
    const a = await accountOfTenant(req, req.params.id);
    const { month } = parse(monthSchema, req.query);
    return sendReport(reply, a.id, month ?? currentMonth(), true);
  });

  // ================= operador do convênio (central da Saúde) =================

  // as rotas de pacientes são só do convênio da Prefeitura (a loja tem as suas em stores.ts)
  async function myAccount(req: FastifyRequest, kind: 'prefeitura' | null = 'prefeitura') {
    const a = await one(
      `SELECT a.* FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [req.auth.id],
    );
    if (!a || (kind && a.kind !== kind)) throw notFound('Convênio não encontrado');
    if (!a.active) throw badRequest('Este convênio está desativado. Fale com a central do OnDaqui.', 'convenio_inativo');
    return a;
  }

  async function patientOf(accountId: string, id: string) {
    parse(uuid, id);
    const p = await one('SELECT * FROM patients WHERE id = $1 AND account_id = $2', [id, accountId]);
    if (!p) throw notFound('Paciente não encontrado');
    return p;
  }

  async function tripOf(req: FastifyRequest, accountId: string, id: string) {
    parse(uuid, id);
    const r = await loadRide(id);
    if (!r || r.account_id !== accountId || r.tenant_id !== req.auth.tenantId) throw notFound('Viagem não encontrada');
    return r;
  }

  const patientRow = (p: any) => ({
    id: p.id, name: p.name, phone: p.phone, document: p.document,
    home: { lat: p.lat, lng: p.lng, address: p.address },
    wheelchair: p.wheelchair, needsCompanion: p.needs_companion, notes: p.notes, active: p.active,
  });

  // foto do motorista (e do veículo) para a loja e para a central da Saúde: só aprovada e só com a corrida em andamento
  app.get<Params & { Querystring: { which?: string } }>('/account/trips/:id/driver-photo', operator, async (req, reply) => {
    const a = await myAccount(req, null);
    const r = await tripOf(req, a.id, req.params.id);
    if (!r.driver_id || !['accepted', 'arrived', 'in_progress', 'completed'].includes(r.status)) throw notFound('Foto indisponível');
    const d = await one('SELECT photo_path, vehicle_photo_path, photo_status FROM drivers WHERE user_id = $1', [r.driver_id]);
    if (d?.photo_status !== 'approved') throw notFound('Foto indisponível');
    return sendImage(reply, req.query.which === 'veiculo' ? d.vehicle_photo_path : d.photo_path);
  });

  app.get('/account/me', operator, async (req) => {
    const a = await myAccount(req, null);
    return { account: { id: a.id, name: a.name, kind: a.kind } };
  });

  app.get<{ Querystring: { q?: string } }>('/account/patients', operator, async (req) => {
    const a = await myAccount(req);
    const q = (req.query.q ?? '').trim();
    const rows = await query(
      `SELECT * FROM patients WHERE account_id = $1 AND active
          AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%' OR document ILIKE '%' || $2 || '%')
        ORDER BY name LIMIT 200`,
      [a.id, q],
    );
    return { patients: rows.map(patientRow) };
  });

  app.post('/account/patients', operator, async (req, reply) => {
    const a = await myAccount(req);
    const b = parse(patientSchema, req.body);
    const p = await one(
      `INSERT INTO patients (account_id, name, phone, document, address, lat, lng, wheelchair, needs_companion, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [a.id, b.name, b.phone, b.document ?? null, b.home.address, b.home.lat, b.home.lng, b.wheelchair, b.needsCompanion, b.notes ?? null],
    );
    reply.code(201);
    return { patient: patientRow(p) };
  });

  app.patch<Params>('/account/patients/:id', operator, async (req) => {
    const a = await myAccount(req);
    const p = await patientOf(a.id, req.params.id);
    const b = parse(patientSchema.partial().extend({ active: z.boolean().optional() }), req.body);
    const u = await one(
      `UPDATE patients SET name = $2, phone = $3, document = $4, address = $5, lat = $6, lng = $7,
              wheelchair = $8, needs_companion = $9, notes = $10, active = $11 WHERE id = $1 RETURNING *`,
      [p.id, b.name ?? p.name, b.phone ?? p.phone, b.document ?? p.document, b.home?.address ?? p.address,
       b.home?.lat ?? p.lat, b.home?.lng ?? p.lng, b.wheelchair ?? p.wheelchair, b.needsCompanion ?? p.needs_companion,
       b.notes ?? p.notes, b.active ?? p.active],
    );
    return { patient: patientRow(u) };
  });

  // destinos frequentes (hospital, UBS, clínica)
  app.get('/account/places', operator, async (req) => {
    const a = await myAccount(req);
    return { places: await query('SELECT id, name, address, lat, lng FROM account_places WHERE account_id = $1 ORDER BY name', [a.id]) };
  });

  app.post('/account/places', operator, async (req, reply) => {
    const a = await myAccount(req);
    const b = parse(place.extend({ name: z.string().trim().min(2).max(80) }), req.body);
    reply.code(201);
    return {
      place: await one(
        `INSERT INTO account_places (account_id, name, address, lat, lng) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, address, lat, lng`,
        [a.id, b.name, b.address, b.lat, b.lng],
      ),
    };
  });

  app.delete<Params>('/account/places/:id', operator, async (req) => {
    const a = await myAccount(req);
    parse(uuid, req.params.id);
    await query('DELETE FROM account_places WHERE id = $1 AND account_id = $2', [req.params.id, a.id]);
    return { ok: true };
  });

  async function createTrip(req: FastifyRequest, accountId: string, patient: any, t: {
    origin: z.infer<typeof place>; destination: z.infer<typeof place>; scheduledFor?: string;
    companion: boolean; wheelchair: boolean; notes?: string | null; returnOf?: string | null;
  }) {
    const q = await computeQuote(req.auth.tenantId!, {
      origin: t.origin, destination: t.destination, category: 'paciente', scheduledFor: t.scheduledFor,
    }, ['paciente']);
    const requires = [...q.requires, ...(t.wheelchair ? ['cadeirante'] : [])];
    const ride = await one(
      `INSERT INTO rides (tenant_id, passenger_id, patient_id, account_id, created_by, category_code, kind, vehicle_type, requires,
          status, scheduled_for, origin_lat, origin_lng, origin_address, dest_lat, dest_lng, dest_address,
          distance_km, duration_min, price_cents, surge, payment_method, boarding_code, share_token, license_fee_cents,
          companion, wheelchair, notes, return_of, route_source, route_polyline)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'convenio',$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING id`,
      [req.auth.tenantId, patient.id, accountId, req.auth.id, q.category, q.kind, q.vehicleType, requires,
       q.scheduledFor ? 'scheduled' : 'requested', q.scheduledFor,
       t.origin.lat, t.origin.lng, t.origin.address, t.destination.lat, t.destination.lng, t.destination.address,
       q.distanceKm, q.durationMin, q.priceCents, q.surge, newBoardingCode(), newShareToken(), q.licenseFeeCents,
       t.companion, t.wheelchair, t.notes ?? null, t.returnOf ?? null, q.routeSource, q.routePolyline],
    );
    if (!q.scheduledFor) await dispatchRide(ride!.id);
    const full = await loadRide(ride!.id);
    emitTo(`admin:${req.auth.tenantId}`, 'ride:updated', rideView(full, 'admin'));
    emitTo(`account:${accountId}`, 'ride:updated', rideView(full, 'account'));
    return rideView(full, 'account');
  }

  app.post('/account/trips/quote', operator, async (req) => {
    const a = await myAccount(req);
    const b = parse(tripSchema.pick({ patientId: true, origin: true, destination: true }), req.body);
    const p = await patientOf(a.id, b.patientId);
    const origin = b.origin ?? { lat: p.lat, lng: p.lng, address: p.address };
    const q = await computeQuote(req.auth.tenantId!, { origin, destination: b.destination, category: 'paciente' }, ['paciente']);
    return { priceCents: q.priceCents, distanceKm: q.distanceKm, durationMin: q.durationMin, roundTripCents: q.priceCents * 2 };
  });

  app.post('/account/trips', operator, async (req, reply) => {
    const a = await myAccount(req);
    const b = parse(tripSchema, req.body);
    const p = await patientOf(a.id, b.patientId);
    const origin = b.origin ?? { lat: p.lat, lng: p.lng, address: p.address };
    const backAt = b.returnAt ? checkSchedule(b.returnAt) : null;
    if (backAt && b.scheduledFor && backAt <= new Date(b.scheduledFor)) throw badRequest('A volta precisa ser depois da ida', 'volta_antes');
    const common = {
      companion: b.companion ?? p.needs_companion, wheelchair: b.wheelchair ?? p.wheelchair, notes: b.notes ?? p.notes,
    };
    const ida = await createTrip(req, a.id, p, { origin, destination: b.destination, scheduledFor: b.scheduledFor, ...common });
    const volta = backAt
      ? await createTrip(req, a.id, p, { origin: b.destination, destination: origin, scheduledFor: b.returnAt, returnOf: ida.id, ...common })
      : null;
    reply.code(201);
    return { trip: ida, returnTrip: volta };
  });

  // paciente liberado na consulta: chama a volta agora (ou agenda)
  app.post<Params>('/account/trips/:id/return', operator, async (req, reply) => {
    const a = await myAccount(req);
    const r = await tripOf(req, a.id, req.params.id);
    const b = parse(z.object({ scheduledFor: z.string().datetime({ offset: true }).optional() }), req.body ?? {});
    const already = await one(`SELECT 1 FROM rides WHERE return_of = $1 AND status <> 'cancelled'`, [r.id]);
    if (already) throw conflict('A volta desta viagem já foi pedida', 'volta_existente');
    const p = await patientOf(a.id, r.patient_id);
    const trip = await createTrip(req, a.id, p, {
      origin: { lat: r.dest_lat, lng: r.dest_lng, address: r.dest_address },
      destination: { lat: r.origin_lat, lng: r.origin_lng, address: r.origin_address },
      scheduledFor: b.scheduledFor, companion: r.companion, wheelchair: r.wheelchair, notes: r.notes, returnOf: r.id,
    });
    reply.code(201);
    return { trip };
  });

  app.get<{ Querystring: { view?: string; day?: string } }>('/account/trips', operator, async (req) => {
    const a = await myAccount(req);
    const { view, day } = parse(z.object({
      view: z.enum(['ativas', 'agendadas', 'dia']).default('ativas'),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.query);
    const where = view === 'ativas' ? `status IN ('requested','accepted','arrived','in_progress')`
      : view === 'agendadas' ? `status = 'scheduled'`
      : `coalesce(scheduled_for, requested_at) >= $2::date AND coalesce(scheduled_for, requested_at) < $2::date + 1`;
    const params: unknown[] = [a.id];
    if (view === 'dia') params.push(day ?? new Date().toISOString().slice(0, 10));
    const rows = await query(
      `SELECT id FROM rides WHERE account_id = $1 AND ${where} ORDER BY coalesce(scheduled_for, requested_at) LIMIT 300`, params,
    );
    const trips = [];
    for (const r of rows) trips.push(rideView(await loadRide(r.id), 'account'));
    return { trips };
  });

  app.post<Params>('/account/trips/:id/cancel', operator, async (req) => {
    const a = await myAccount(req);
    const r = await tripOf(req, a.id, req.params.id);
    if (!['scheduled', 'requested', 'accepted', 'arrived'].includes(r.status)) throw conflict('Esta viagem não pode mais ser cancelada');
    await query(
      `UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'central_saude', cancel_reason = 'cancelada_pela_saude'
        WHERE id = $1`, [r.id],
    );
    await query(`UPDATE ride_offers SET status = 'closed' WHERE ride_id = $1 AND status = 'sent'`, [r.id]);
    await notifyRide(r.id);
    return { ok: true };
  });

  app.get<{ Querystring: { month?: string } }>('/account/report', operator, async (req, reply) => {
    const a = await myAccount(req);
    const { month } = parse(monthSchema, req.query);
    return sendReport(reply, a.id, month ?? currentMonth(), false);
  });

  app.get<{ Querystring: { month?: string } }>('/account/report.csv', operator, async (req, reply) => {
    const a = await myAccount(req);
    const { month } = parse(monthSchema, req.query);
    return sendReport(reply, a.id, month ?? currentMonth(), true);
  });

  // usado pelo mapa do painel do operador
  app.get('/account/map', operator, async (req) => {
    const a = await myAccount(req);
    const rows = await query(
      `SELECT id FROM rides WHERE account_id = $1 AND status IN ('requested','accepted','arrived','in_progress')`, [a.id],
    );
    const trips = [];
    for (const r of rows) trips.push(rideView(await loadRide(r.id), 'account'));
    return { trips };
  });
}
