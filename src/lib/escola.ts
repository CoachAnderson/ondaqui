import { one, pool, query, type Db } from './db.js';
import { CHANNEL_UPDATES, pushTo } from './push.js';
import { emitTo } from './realtime.js';

/**
 * Daqui Escola: os pais contratam um motorista fixo, liberado pela central para transporte escolar
 * (CTB art. 138: mais de 21 anos, CNH D, curso especializado; veículo vistoriado e autorizado).
 * Mensalidade pelo app ou na central; todo dia de aula o sistema monta as viagens e os pais acompanham.
 */
export const ESCOLA_DAYS = 30;
export const TODAY_SQL = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
const NOW_TIME_SQL = `(now() AT TIME ZONE 'America/Sao_Paulo')::time`;

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
const firstName = (n: string | null) => (n ? n.trim().split(/\s+/)[0] : '');
const hhmm = (t: string | null) => (t ? String(t).slice(0, 5) : null);

/**
 * Preço mensal: base + valor por km da distância casa–escola (ida e volta, 5 dias por semana).
 * Só ida ou só volta: 60%. Menos dias por semana: proporcional (mínimo de 40%). Arredondado para o real.
 */
export function escolaPrice(t: any, distanceKm: number, legs: string, weekdays: number[]) {
  const full = t.escola_base_cents + Math.round(t.escola_per_km_cents * Math.max(1, distanceKm));
  const legFactor = legs === 'ida_volta' ? 1 : 0.6;
  const dayFactor = Math.max(0.4, Math.min(1.2, new Set(weekdays).size / 5));
  return Math.max(100, Math.round((full * legFactor * dayFactor) / 100) * 100);
}

export function escolaRulesOf(t: any) {
  return {
    enabled: !!t.escola_enabled, baseCents: t.escola_base_cents, perKmCents: t.escola_per_km_cents,
    commissionPct: Number(t.escola_commission_pct), graceDays: t.escola_grace_days, days: ESCOLA_DAYS,
  };
}

/**
 * Monta as viagens do dia (pode rodar várias vezes): contratos ativos, com a mensalidade em dia
 * (ou dentro da tolerância), no dia da semana certo e fora dos dias sem aula.
 */
export async function ensureSchoolTrips(day?: string, tenantId?: string, db: Db = pool) {
  const rows = await query<{ id: string }>(
    `WITH d AS (SELECT coalesce($1::date, ${TODAY_SQL}) AS day)
     INSERT INTO school_trips (tenant_id, contract_id, driver_id, day, leg, scheduled_time)
     SELECT c.tenant_id, c.id, c.driver_id, d.day, l.leg, CASE WHEN l.leg = 'ida' THEN c.pickup_time ELSE c.return_time END
       FROM school_contracts c
       JOIN tenants t ON t.id = c.tenant_id
       CROSS JOIN d
       CROSS JOIN LATERAL (SELECT unnest(CASE c.legs WHEN 'ida' THEN ARRAY['ida'] WHEN 'volta' THEN ARRAY['volta'] ELSE ARRAY['ida','volta'] END) AS leg) l
      WHERE c.status = 'ativo' AND c.driver_id IS NOT NULL AND t.active AND t.escola_enabled
        AND ($2::uuid IS NULL OR c.tenant_id = $2)
        AND extract(isodow FROM d.day)::int = ANY(c.weekdays)
        AND c.paid_until IS NOT NULL AND c.paid_until + t.escola_grace_days >= d.day
        AND NOT EXISTS (SELECT 1 FROM school_days_off o WHERE o.tenant_id = c.tenant_id AND o.day = d.day)
     ON CONFLICT (contract_id, day, leg) DO NOTHING RETURNING id`,
    [day ?? null, tenantId ?? null], db,
  );
  return rows.length;
}

/** Viagens com aluno, escola, casa e motorista, para os pais, o motorista e a central */
export async function loadSchoolTrips(where: string, params: unknown[]) {
  return query(
    `SELECT tr.id, tr.day::text AS day, tr.leg, to_char(tr.scheduled_time, 'HH24:MI') AS time, tr.status, tr.boarded_at, tr.delivered_at, tr.absent_by,
            c.id AS contract_id, c.student_name, c.grade, c.notes, c.home_address, c.home_lat, c.home_lng, c.parent_id,
            s.name AS school_name, s.address AS school_address, s.lat AS school_lat, s.lng AS school_lng,
            pu.name AS parent_name, pu.phone AS parent_phone,
            du.id AS driver_id, du.name AS driver_name, d.vehicle_model, d.vehicle_color, d.vehicle_plate,
            CASE WHEN d.location_at > now() - interval '2 minutes' THEN d.lat END AS driver_lat,
            CASE WHEN d.location_at > now() - interval '2 minutes' THEN d.lng END AS driver_lng,
            (d.photo_status = 'approved' AND d.photo_path IS NOT NULL) AS driver_photo_ok
       FROM school_trips tr
       JOIN school_contracts c ON c.id = tr.contract_id
       JOIN schools s ON s.id = c.school_id
       JOIN users pu ON pu.id = c.parent_id
       LEFT JOIN users du ON du.id = tr.driver_id
       LEFT JOIN drivers d ON d.user_id = tr.driver_id
      WHERE ${where}
      ORDER BY tr.day, tr.scheduled_time, c.student_name`,
    params,
  );
}

/** O que cada um vê da viagem: os pais não veem o telefone de outros pais; o motorista vê o dos pais do aluno */
export function schoolTripView(r: any, viewer: 'parent' | 'driver' | 'admin') {
  const live = r.status === 'embarcou' || r.status === 'previsto';
  return {
    id: r.id, day: r.day, leg: r.leg, time: r.time, status: r.status, boardedAt: r.boarded_at, deliveredAt: r.delivered_at, absentBy: r.absent_by,
    contractId: r.contract_id,
    student: { name: viewer === 'driver' ? r.student_name : r.student_name, grade: r.grade, notes: r.notes },
    from: r.leg === 'ida' ? { address: r.home_address, lat: r.home_lat, lng: r.home_lng } : { address: r.school_name, lat: r.school_lat, lng: r.school_lng },
    to: r.leg === 'ida' ? { address: r.school_name, lat: r.school_lat, lng: r.school_lng } : { address: r.home_address, lat: r.home_lat, lng: r.home_lng },
    school: { name: r.school_name, address: r.school_address },
    parent: viewer === 'parent' ? undefined : { name: viewer === 'driver' ? firstName(r.parent_name) : r.parent_name, phone: r.parent_phone },
    driver: r.driver_id
      ? {
          name: viewer === 'parent' ? firstName(r.driver_name) : r.driver_name,
          vehicle: { model: r.vehicle_model, color: r.vehicle_color, plate: r.vehicle_plate },
          hasPhoto: !!r.driver_photo_ok,
          location: viewer !== 'driver' && live && r.driver_lat != null ? { lat: r.driver_lat, lng: r.driver_lng } : null,
        }
      : null,
  };
}

const LEG_TEXT = {
  embarcou: { ida: (n: string) => [`${n} embarcou`, 'A caminho da escola. Toque para acompanhar.'], volta: (n: string) => [`${n} saiu da escola`, 'A caminho de casa. Toque para acompanhar.'] },
  entregue: { ida: (n: string) => [`${n} chegou à escola ✅`, ''], volta: (n: string) => [`${n} chegou em casa ✅`, ''] },
  ausente: { ida: (n: string) => [`${n} não estava no embarque`, 'O motorista seguiu a rota. Se foi engano, fale com ele ou com a central.'], volta: (n: string) => [`${n} não estava na saída da escola`, 'O motorista seguiu a rota. Fale com a escola ou com a central.'] },
} as const;

/** O motorista marca embarque, chegada ou ausência; os pais recebem aviso na hora */
export async function driverMarkTrip(driverId: string, tripId: string, action: 'embarcou' | 'entregue' | 'ausente') {
  const from = action === 'entregue' ? ['embarcou'] : ['previsto'];
  const t = await one(
    `UPDATE school_trips SET status = $3,
            boarded_at = CASE WHEN $3 = 'embarcou' THEN now() ELSE boarded_at END,
            delivered_at = CASE WHEN $3 = 'entregue' THEN now() ELSE delivered_at END,
            absent_by = CASE WHEN $3 = 'ausente' THEN 'motorista' ELSE absent_by END
      WHERE id = $1 AND driver_id = $2 AND status = ANY($4::text[]) AND day = ${TODAY_SQL}
      RETURNING id, contract_id, leg, (SELECT parent_id FROM school_contracts c WHERE c.id = contract_id) AS parent_id,
                (SELECT student_name FROM school_contracts c WHERE c.id = contract_id) AS student_name`,
    [tripId, driverId, action, from],
  );
  if (!t) return null;
  const [title, body] = LEG_TEXT[action][t.leg as 'ida' | 'volta'](firstName(t.student_name));
  const at = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  emitTo(`user:${t.parent_id}`, 'escola:trip', { id: t.id, status: action });
  await pushTo(t.parent_id, { title, body: body ? `${at}. ${body}` : `Às ${at}.`, channelId: CHANNEL_UPDATES, data: { type: 'escola', tripId: t.id } })
    .catch(() => {});
  return t;
}

/** Os pais avisam que o filho não vai (antes do embarque); o motorista recebe aviso */
export async function parentAbsent(parentId: string, tripId: string) {
  const t = await one(
    `UPDATE school_trips tr SET status = 'ausente', absent_by = 'pais'
       FROM school_contracts c
      WHERE tr.id = $1 AND c.id = tr.contract_id AND c.parent_id = $2 AND tr.status = 'previsto' AND tr.day >= ${TODAY_SQL}
      RETURNING tr.id, tr.driver_id, tr.leg, tr.day::text AS day, to_char(tr.scheduled_time, 'HH24:MI') AS time, c.student_name`,
    [tripId, parentId],
  );
  if (!t) return null;
  if (t.driver_id) {
    emitTo(`user:${t.driver_id}`, 'escola:trip', { id: t.id, status: 'ausente' });
    await pushTo(t.driver_id, {
      title: `${firstName(t.student_name)} não vai ${t.leg === 'ida' ? 'para a escola' : 'na volta'}`,
      body: `Aviso dos pais para a viagem das ${t.time}. Pule este embarque.`, channelId: CHANNEL_UPDATES, data: { type: 'escola' },
    }).catch(() => {});
  }
  return t;
}

/** Mensalidade paga: soma 30 dias ao que vencer por último (ou a partir de hoje) e registra para o repasse */
export async function extendSchoolContract(db: Db, contractId: string, months: number, amountCents: number, extra: { chargeId?: string; by?: string } = {}) {
  const r = await one<{ paid_until: string; period_start: string; tenant_id: string; driver_id: string | null }>(
    `UPDATE school_contracts SET paid_until = greatest(coalesce(paid_until, ${TODAY_SQL} - 1), ${TODAY_SQL} - 1) + $2::int
      WHERE id = $1
      RETURNING paid_until::text, (paid_until - $2::int + 1)::text AS period_start, tenant_id, driver_id`,
    [contractId, ESCOLA_DAYS * months], db,
  );
  if (!r) return null;
  await query(
    `INSERT INTO school_payments (tenant_id, contract_id, driver_id, amount_cents, period_start, period_end, charge_id, registered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [r.tenant_id, contractId, r.driver_id, amountCents, r.period_start, r.paid_until, extra.chargeId ?? null, extra.by ?? null], db,
  );
  return r.paid_until;
}

export async function reverseSchoolPayment(db: Db, contractId: string, chargeId: string) {
  await query(`UPDATE school_contracts SET paid_until = paid_until - $2::int WHERE id = $1 AND paid_until IS NOT NULL`, [contractId, ESCOLA_DAYS], db);
  await query(`DELETE FROM school_payments WHERE charge_id = $1`, [chargeId], db);
}

/** Repasse do mês: o que entrou de cada motorista, menos a comissão da central */
export async function schoolPayouts(tenantId: string, month: string) {
  return query(
    `SELECT u.id AS driver_id, u.name AS driver_name, d.pix_key, d.pix_holder_name, d.pix_validated,
            sum(p.amount_cents)::int AS received_cents, count(DISTINCT p.contract_id)::int AS contracts,
            round(sum(p.amount_cents) * t.escola_commission_pct / 100)::int AS commission_cents,
            (sum(p.amount_cents) - round(sum(p.amount_cents) * t.escola_commission_pct / 100))::int AS amount_cents,
            po.paid_at
       FROM school_payments p
       JOIN tenants t ON t.id = p.tenant_id
       JOIN users u ON u.id = p.driver_id
       LEFT JOIN drivers d ON d.user_id = u.id
       LEFT JOIN school_payouts po ON po.driver_id = u.id AND po.month = $2::date
      WHERE p.tenant_id = $1 AND date_trunc('month', p.created_at AT TIME ZONE 'America/Sao_Paulo')::date = $2::date
      GROUP BY u.id, u.name, d.pix_key, d.pix_holder_name, d.pix_validated, t.escola_commission_pct, po.paid_at
      ORDER BY u.name`,
    [tenantId, month],
  );
}

/** Avisa os pais 3 dias antes, no dia e no dia seguinte ao vencimento da mensalidade */
export async function sendSchoolReminders() {
  const rows = await query<{ id: string; parent_id: string; student_name: string; due: string; days_left: number; monthly_cents: number; grace: number }>(
    `SELECT c.id, c.parent_id, c.student_name, c.paid_until::text AS due, (c.paid_until - ${TODAY_SQL}) AS days_left, c.monthly_cents, t.escola_grace_days AS grace
       FROM school_contracts c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.status = 'ativo' AND t.active AND t.escola_enabled AND c.paid_until IS NOT NULL
        AND (c.paid_until - ${TODAY_SQL}) IN (3, 0, -1)
        AND NOT EXISTS (SELECT 1 FROM billing_reminders b WHERE b.user_id = c.parent_id AND b.kind = 'escola-' || (c.paid_until - ${TODAY_SQL}) || '-' || c.id
                        AND b.ref_date = c.paid_until)`,
  );
  for (const r of rows) {
    await query(`INSERT INTO billing_reminders (user_id, kind, ref_date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [r.parent_id, `escola-${r.days_left}-${r.id}`, r.due]);
    const n = firstName(r.student_name);
    const body = r.days_left > 0 ? `A mensalidade do transporte de ${n} vence em ${r.days_left} dias (${brl(r.monthly_cents)}). Pague pelo app.`
      : r.days_left === 0 ? `A mensalidade do transporte de ${n} vence hoje. Pague pelo app.`
      : `A mensalidade do transporte de ${n} venceu. O transporte segue por mais ${r.grace} dias; pague pelo app para não interromper.`;
    await pushTo(r.parent_id, { title: 'Transporte escolar', body, channelId: CHANNEL_UPDATES, data: { type: 'escola' } }).catch(() => {});
  }
  return rows.length;
}

/** Rodada de hora em hora: viagens do dia e avisos de mensalidade */
export async function runSchoolJobs() {
  const trips = await ensureSchoolTrips();
  const reminders = await sendSchoolReminders();
  return { trips, reminders };
}

export { NOW_TIME_SQL, hhmm };
