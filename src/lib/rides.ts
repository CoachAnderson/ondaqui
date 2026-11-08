import { randomBytes, randomInt } from 'node:crypto';
import { COMMISSION_OVERDUE_SQL } from './commissions.js';
import { config } from './config.js';
import { sendSms, toE164 } from './sms.js';
import { one, query, type Db, pool } from './db.js';
import { emitTo } from './realtime.js';
import { sqlDistanceKm } from './geo.js';
import { CHANNEL_OFFERS, CHANNEL_UPDATES, pushTo, type Notification } from './push.js';
import { refundDelivery } from './stores.js';
import { releaseCashback } from './cashback.js';
import { prefsSummary, readPrefs } from './prefs.js';
import { moveToRotation, shiftDispatchState, syncFoodOrder } from './food.js';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (c: number) => brl.format(c / 100).replace(/\u00a0/g, ' ');
const plate = (p: string) => (p && p.length === 7 ? `${p.slice(0, 3)}-${p.slice(3)}` : p);

export const ACTIVE_STATUSES = ['requested', 'accepted', 'arrived', 'in_progress'] as const;

/** O que o próprio motorista escolhe atender */
export const DRIVER_OPT_IN = ['pet', 'entrega', 'particular'] as const;
/** O que só o licenciado libera, depois de conferir (documento, veículo, treinamento) */
export const DRIVER_VERIFIED = ['mulher', 'executivo', 'paciente', 'cadeirante', 'escolar'] as const;

/** Antecedência com que uma corrida agendada começa a procurar motorista */
export const SCHEDULE_LEAD_MIN = 20;

export const newBoardingCode = () => String(randomInt(0, 10000)).padStart(4, '0');
export const newDeliveryCode = newBoardingCode;
export const newShareToken = () => randomBytes(12).toString('base64url');

/** Regras que o motorista precisa cumprir para ficar online e receber corridas */
export const DRIVER_CAN_WORK_SQL = `
  u.blocked = false AND d.status = 'approved'
  AND d.photo_status = 'approved' AND d.photo_path IS NOT NULL AND d.vehicle_photo_path IS NOT NULL
  AND d.selfie_checked_at > now() - make_interval(hours => t.selfie_validity_hours)
  AND (p.period_days = 0 OR d.paid_until >= current_date OR d.trial_until >= current_date)
  AND NOT ${COMMISSION_OVERDUE_SQL('d.user_id')}`;

export async function driverWorkStatus(userId: string, db: Db = pool) {
  const r = await one<{
    status: string; blocked: boolean; selfie_ok: boolean; subscription_ok: boolean;
    photo_status: string; photo_review: string | null; has_photos: boolean; sent_photos: boolean; commission_overdue: boolean;
  }>(
    `SELECT d.status, u.blocked, d.photo_status, d.photo_review,
            (d.photo_path IS NOT NULL AND d.vehicle_photo_path IS NOT NULL) AS has_photos,
            (coalesce(d.photo_pending_path, d.photo_path) IS NOT NULL AND coalesce(d.vehicle_pending_path, d.vehicle_photo_path) IS NOT NULL) AS sent_photos,
            coalesce(d.selfie_checked_at > now() - make_interval(hours => t.selfie_validity_hours), false) AS selfie_ok,
            (p.period_days = 0 OR coalesce(d.paid_until >= current_date, false) OR coalesce(d.trial_until >= current_date, false)) AS subscription_ok,
            ${COMMISSION_OVERDUE_SQL('d.user_id')} AS commission_overdue
       FROM drivers d JOIN users u ON u.id = d.user_id
       JOIN tenants t ON t.id = u.tenant_id
       JOIN driver_plans p ON p.tenant_id = u.tenant_id AND p.code = d.plan_code
      WHERE d.user_id = $1`,
    [userId], db,
  );
  if (!r) return { ok: false, reason: 'Cadastro de motorista não encontrado' };
  if (r.blocked || r.status === 'blocked') return { ok: false, reason: 'Conta bloqueada pelo licenciado' };
  if (r.status !== 'approved') return { ok: false, reason: 'Cadastro aguardando aprovação do licenciado' };
  if (!r.subscription_ok) return { ok: false, reason: 'Mensalidade do plano em aberto' };
  if (r.commission_overdue) return { ok: false, reason: 'Comissão da semana vencida. Pague pelo app ou na central' };
  // o passageiro precisa ver quem vai buscá-lo: sem foto aprovada, não recebe corridas
  if (r.photo_status !== 'approved' || !r.has_photos) {
    if (r.photo_review === 'rejected') return { ok: false, reason: 'A central recusou suas fotos. Envie outras pelo app' };
    if (!r.sent_photos) return { ok: false, reason: 'Envie sua foto e a foto do veículo pelo app' };
    return { ok: false, reason: 'Suas fotos estão em análise pela central' };
  }
  if (!r.selfie_ok) return { ok: false, reason: 'Envie a selfie de início de turno' };
  return { ok: true as const, reason: null };
}

/** Corrida com dados do motorista e do passageiro, pronta para responder */
export async function loadRide(rideId: string, db: Db = pool) {
  return one(
    `SELECT r.*,
            coalesce(pt.name, fm.name, pu.name, a.name) AS passenger_name, pt.phone AS patient_phone,
            -- corrida pedida para um parente (Modo família): quem pediu e quem viaja
            CASE WHEN fm.id IS NOT NULL THEN pu.name END AS requester_name,
            fm.phone AS family_phone, fm.relation AS family_relation, fm.notes AS family_notes,
            du.name AS driver_name, du.phone AS driver_phone, d.vehicle_plate, d.vehicle_model, d.vehicle_color,
            d.lat AS driver_lat, d.lng AS driver_lng,
            (d.photo_status = 'approved' AND d.photo_path IS NOT NULL) AS driver_photo_ok,
            (d.photo_status = 'approved' AND d.vehicle_photo_path IS NOT NULL) AS vehicle_photo_ok,
            -- câmera declarada: o passageiro é avisado (a central pode barrar, aí o motorista não pode gravar)
            CASE WHEN d.camera_status IN ('pending', 'approved') THEN d.camera_kind END AS driver_camera,
            c.name AS service_name, a.name AS account_name, a.kind AS account_kind, a.logo_path AS account_logo
       FROM rides r
       LEFT JOIN users pu ON pu.id = r.passenger_id
       LEFT JOIN patients pt ON pt.id = r.patient_id
       LEFT JOIN family_members fm ON fm.id = r.family_member_id
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN users du ON du.id = r.driver_id
       LEFT JOIN drivers d ON d.user_id = r.driver_id
       LEFT JOIN ride_categories c ON c.tenant_id = r.tenant_id AND c.code = r.category_code
      WHERE r.id = $1`,
    [rideId], db,
  );
}

const firstName = (n: string | null) => (n ? n.trim().split(/\s+/)[0] : null);

/**
 * O que cada lado pode ver. O código de embarque só aparece para o passageiro:
 * o motorista precisa pedir o código para iniciar (antigolpe).
 */
export type Viewer = 'passenger' | 'driver' | 'admin' | 'account';

export function rideView(r: any, viewer: Viewer) {
  const assigned = !!r.driver_id && ['accepted', 'arrived', 'in_progress', 'completed'].includes(r.status);
  const base = {
    id: r.id,
    status: r.status,
    category: r.category_code,
    kind: r.kind,
    serviceName: r.service_name,
    scheduledFor: r.scheduled_for,
    hoursBooked: r.hours_booked,
    helpers: r.helpers,
    notes: r.notes,
    delivery: r.kind === 'entrega'
      ? {
          recipientName: r.recipient_name,
          // o telefone de quem recebe só aparece para o motorista depois de aceitar
          recipientPhone: viewer !== 'driver' || assigned ? r.recipient_phone : null,
          packageDesc: r.package_desc,
          hasPickupPhoto: !!r.pickup_photo_path,
        }
      : null,
    // cobrança do produto na entrega (pedido de loja)
    cod: r.cod_amount_cents
      ? {
          amountCents: r.cod_amount_cents, method: r.cod_method, status: r.cod_status,
          // prazo da loja para conferir o Pix na chave ou a maquininha (depois disso conta como recebido)
          confirmBy: r.cod_status === 'aguardando_loja' && r.cod_paid_at
            ? new Date(new Date(r.cod_paid_at).getTime() + config.codConfirmHours * 3_600_000).toISOString() : null,
          settledBy: r.cod_settled_by ?? null,
        }
      : null,
    store: r.account_kind === 'loja' ? { name: r.account_name, hasLogo: !!r.account_logo } : null,
    patient: r.kind === 'paciente'
      ? {
          name: r.passenger_name,
          phone: viewer !== 'driver' || assigned ? r.patient_phone : null,
          companion: r.companion,
          wheelchair: r.wheelchair,
          account: r.account_name,
        }
      : null,
    origin: { lat: r.origin_lat, lng: r.origin_lng, address: r.origin_address },
    destination: { lat: r.dest_lat, lng: r.dest_lng, address: r.dest_address },
    distanceKm: r.distance_km,
    durationMin: r.duration_min,
    routeSource: r.route_source,
    /** traçado da viagem pelas ruas, para desenhar no mapa (polyline, precisão 5) */
    routePolyline: r.route_polyline ?? null,
    priceCents: r.price_cents,
    // cashback: o passageiro paga ao motorista o valor menos o usado; a central acerta a diferença com o motorista
    cashback: {
      usedCents: r.cashback_used_cents ?? 0,
      earnedCents: viewer === 'driver' ? 0 : r.cashback_earned_cents ?? 0,
      payCents: r.price_cents - (r.cashback_used_cents ?? 0) - (r.club_discount_cents ?? 0),
    },
    // preferências da viagem: o motorista vê o resumo ("Música: Sertanejo", "Prefiro silêncio", "Ar ligado")
    tripPrefs: r.trip_prefs ? { ...readPrefs(r.trip_prefs), summary: prefsSummary(readPrefs(r.trip_prefs)) } : null,
    prefsRespected: viewer === 'driver' ? undefined : r.prefs_respected ?? null,
    // Clube: assinante (prioridade no despacho) e quanto deixou de pagar (desconto e dinâmica)
    club: r.club_member ? { discountCents: r.club_discount_cents ?? 0 } : null,
    surge: r.surge,
    paymentMethod: r.payment_method,
    // motorista vê só o primeiro nome do passageiro; loja e paciente aparecem com o nome completo
    passenger: { name: viewer === 'driver' && r.passenger_id ? firstName(r.passenger_name) : r.passenger_name },
    // Modo família: quem viaja é o parente; quem pediu e paga é o titular
    family: r.family_member_id
      ? {
          name: viewer === 'driver' ? firstName(r.passenger_name) : r.passenger_name,
          relation: r.family_relation,
          requestedBy: firstName(r.requester_name),
          notes: r.family_notes ?? null,
          phone: viewer === 'passenger' || viewer === 'admin' ? r.family_phone : undefined,
        }
      : null,
    driver: r.driver_id
      ? {
          name: viewer === 'passenger' ? firstName(r.driver_name) : r.driver_name,
          phone: viewer === 'account' || viewer === 'admin' ? r.driver_phone : undefined,
          vehicle: { plate: r.vehicle_plate, model: r.vehicle_model, color: r.vehicle_color },
          location: r.driver_lat != null ? { lat: r.driver_lat, lng: r.driver_lng } : null,
          hasPhoto: !!r.driver_photo_ok,
          hasVehiclePhoto: !!r.vehicle_photo_ok,
          camera: (r.driver_camera ?? null) as 'video' | 'video_audio' | null,
        }
      : null,
    // comprovantes da carga (Entrega e Frete)
    photos: { pickup: !!r.pickup_photo_path, dropoff: !!r.dropoff_photo_path },
    requestedAt: r.requested_at,
    acceptedAt: r.accepted_at,
    arrivedAt: r.arrived_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
  };
  if (viewer === 'passenger') return { ...base, boardingCode: r.boarding_code, deliveryCode: r.delivery_code, shareToken: r.share_token };
  if (viewer === 'admin') return { ...base, commissionCents: r.commission_cents, licenseFeeCents: r.license_fee_cents, accountId: r.account_id };
  if (viewer === 'account') {
    return {
      ...base, patientId: r.patient_id, returnOf: r.return_of, shareToken: r.share_token,
      // a loja passa o código de coleta ao motoboy e manda o de entrega para o cliente
      ...(r.kind === 'entrega' ? { boardingCode: r.boarding_code, deliveryCode: r.delivery_code } : {}),
    };
  }
  return base;
}

/** Avisa todos os interessados de que a corrida mudou */
export async function notifyRide(rideId: string, opts: { push?: boolean } = {}) {
  const r = await loadRide(rideId);
  if (!r) return;
  // Daqui Food: o andamento da entrega vai para o pedido (cliente e restaurante)
  if (r.food_order_id) await syncFoodOrder(r).catch((e) => console.error('[food] sync', e));
  if (r.passenger_id) emitTo(`user:${r.passenger_id}`, 'ride:updated', rideView(r, 'passenger'));
  if (r.account_id) emitTo(`account:${r.account_id}`, 'ride:updated', rideView(r, 'account'));
  if (r.driver_id) emitTo(`user:${r.driver_id}`, 'ride:updated', rideView(r, 'driver'));
  emitTo(`admin:${r.tenant_id}`, 'ride:updated', rideView(r, 'admin'));
  if (opts.push !== false) void pushRideStatus(r);
}

/** O parente não tem o app: recebe por SMS quem vai buscá-lo, o código de embarque e o link para acompanhar */
async function smsFamily(r: any, car: string) {
  const link = config.painelUrl ? ` Acompanhe: ${config.painelUrl}/acompanhar/${r.share_token}` : '';
  const text = `${firstName(r.requester_name) ?? 'Sua família'} pediu um carro para você. Motorista ${firstName(r.driver_name)}, ${car}. `
    + `Ao entrar, diga o código ${r.boarding_code}.${link}`;
  try {
    await sendSms({ to: toE164(r.family_phone), code: r.boarding_code, tenant: r.tenant_id, text });
  } catch (e) {
    console.error('[família] SMS não enviado:', e instanceof Error ? e.message : e);
  }
}

/** "Você usou R$ 3,00 e ganhou R$ 0,70 de cashback" no aviso de chegada */
function cashbackNote(r: any) {
  const used = r.cashback_used_cents ?? 0;
  const earned = r.cashback_earned_cents ?? 0;
  const club = r.club_discount_cents ?? 0;
  const clubText = club > 0 ? ` O Clube economizou ${money(club)}.` : '';
  if (!used && !earned) return clubText;
  if (used && earned) return `${clubText} Você usou ${money(used)} e ganhou ${money(earned)} de cashback.`;
  return clubText + (used ? ` Você usou ${money(used)} de cashback.` : ` Você ganhou ${money(earned)} de cashback.`);
}

/** Push para quem está com o app fechado. Chamado uma vez a cada mudança de etapa. */
async function pushRideStatus(r: any) {
  const data = { type: 'ride', rideId: r.id };
  const car = r.driver_id ? `${r.vehicle_model} ${r.vehicle_color} · placa ${plate(r.vehicle_plate)}` : '';
  const toPassenger: Partial<Record<string, Notification>> = {
    accepted: { title: 'Motorista a caminho', body: `${firstName(r.driver_name)} · ${car}` },
    arrived: { title: 'Seu motorista chegou', body: `Procure o ${car}. Diga o código de embarque ao entrar.` },
    requested: { title: 'Procurando outro motorista', body: 'O motorista não pôde seguir. Já estamos chamando outro.' },
    completed: { title: 'Você chegou!', body: `Corrida de ${money(r.price_cents)}.${cashbackNote(r)} Conte como foi a viagem.` },
  };
  if (r.kind === 'entrega') {
    Object.assign(toPassenger, {
      arrived: { title: 'Entregador na coleta', body: `${car}. Mostre o pacote e diga o código de coleta.` },
      in_progress: { title: 'Pacote a caminho', body: `${firstName(r.driver_name)} já coletou e está indo entregar.` },
      completed: { title: 'Pacote entregue ✅', body: `Entregue para ${r.recipient_name}.` },
    });
  }
  if (r.kind === 'particular') {
    toPassenger.completed = { title: 'Serviço encerrado', body: `${r.hours_booked} h de motorista particular · ${money(r.price_cents)}.` };
  }
  if (r.status === 'cancelled' && r.cancelled_by === 'sistema' && r.passenger_id) {
    await pushTo(r.passenger_id, { title: 'Nenhum motorista disponível', body: 'Tente pedir de novo em alguns minutos.', data, channelId: CHANNEL_UPDATES });
    return;
  }
  if (r.status === 'cancelled' && ['passageiro', 'central_saude'].includes(r.cancelled_by) && r.driver_id) {
    const who = r.cancelled_by === 'central_saude' ? 'A central da Saúde' : 'O passageiro';
    await pushTo(r.driver_id, { title: 'Corrida cancelada', body: `${who} cancelou. Você já pode receber outra corrida.`, data, channelId: CHANNEL_UPDATES });
    return;
  }
  if (!r.passenger_id) return; // paciente do convênio: quem acompanha é a central da Saúde
  if (r.family_member_id) {
    // Modo família: o titular acompanha cada etapa da viagem do parente
    const who = firstName(r.passenger_name);
    Object.assign(toPassenger, {
      accepted: { title: `Motorista a caminho de ${who}`, body: `${firstName(r.driver_name)} · ${car}` },
      arrived: { title: `O motorista chegou para ${who}`, body: `${car}. ${who} precisa dizer o código de embarque ${r.boarding_code}.` },
      in_progress: { title: `${who} embarcou`, body: `A caminho de ${r.dest_address}. Toque para acompanhar.` },
      completed: { title: `${who} chegou ✅`, body: `Corrida de ${money(r.price_cents)}.${cashbackNote(r)}` },
    });
    if (r.status === 'accepted' && r.family_phone) void smsFamily(r, car);
  }
  const n = toPassenger[r.status];
  if (n) await pushTo(r.passenger_id, { ...n, data, channelId: CHANNEL_UPDATES });
}

/**
 * Envia a oferta para os motoristas aptos mais próximos que ainda não a
 * receberam. O primeiro que aceitar fica com a corrida.
 */
export async function dispatchRide(rideId: string) {
  const ride = await one(
    `SELECT r.*, t.dispatch_radius_km, t.club_priority, c.name AS service_name FROM rides r JOIN tenants t ON t.id = r.tenant_id
       LEFT JOIN ride_categories c ON c.tenant_id = r.tenant_id AND c.code = r.category_code WHERE r.id = $1`,
    [rideId],
  );
  if (!ride || ride.status !== 'requested') return 0;

  // Daqui Food com entregador fixo no turno: a entrega vai só para ele; ocupado, offline ou sem resposta, vai para o rotativo
  let onlyDriver: string | null = null;
  if (ride.shift_id) {
    const s = await shiftDispatchState(ride);
    if (s.state === 'aguardando') return 0;
    if (s.state === 'ofertar') onlyDriver = s.driverId!;
    else { await moveToRotation(rideId); ride.shift_id = null; }
  }

  const radius = Number(ride.dispatch_radius_km);
  // assinante do Clube: a oferta vai para o dobro de motoristas de uma vez e passa na frente das outras
  const priority = !!(ride.club_member && ride.club_priority);
  const dLat = radius / 111;
  const dLng = radius / (111 * Math.cos((ride.origin_lat * Math.PI) / 180));
  const dist = sqlDistanceKm('d.lat', 'd.lng', '$2', '$3');

  const drivers = await query<{ user_id: string; dist: number }>(
    `SELECT * FROM (
       SELECT d.user_id, ${dist} AS dist
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         JOIN tenants t ON t.id = u.tenant_id
         JOIN driver_plans p ON p.tenant_id = u.tenant_id AND p.code = d.plan_code
        WHERE u.tenant_id = $1 AND d.online AND d.vehicle_type = $4
          AND $11::text[] <@ (d.services_opt_in || d.verified)
          AND ${DRIVER_CAN_WORK_SQL}
          AND d.location_at > now() - make_interval(secs => $5)
          AND d.lat BETWEEN $2 - $6 AND $2 + $6
          AND d.lng BETWEEN $3 - $7 AND $3 + $7
          AND NOT EXISTS (SELECT 1 FROM rides x WHERE x.driver_id = d.user_id
                          AND x.status IN ('accepted','arrived','in_progress'))
          AND NOT EXISTS (SELECT 1 FROM ride_offers o WHERE o.ride_id = $8 AND o.driver_id = d.user_id
                          AND o.status <> 'closed')
          -- Clube: motorista com oferta aberta de um assinante não recebe outra oferta até responder
          AND ($12 OR NOT EXISTS (SELECT 1 FROM ride_offers o2 JOIN rides r2 ON r2.id = o2.ride_id
                          WHERE t.club_priority AND o2.driver_id = d.user_id AND o2.status = 'sent' AND r2.status = 'requested' AND r2.club_member))
          AND ($13::uuid IS NULL OR d.user_id = $13)
     ) s
     WHERE s.dist <= $9 OR $13::uuid IS NOT NULL
     ORDER BY s.dist
     LIMIT $10`,
    [ride.tenant_id, ride.origin_lat, ride.origin_lng, ride.vehicle_type, config.driverLocationMaxAgeSec,
     dLat, dLng, rideId, radius, priority ? config.offersPerRound * 2 : config.offersPerRound, ride.requires ?? [], priority, onlyDriver],
  );
  // o fixo está ocupado ou offline: segue para o rotativo agora
  if (onlyDriver && drivers.length === 0) {
    await moveToRotation(rideId);
    return dispatchRide(rideId);
  }

  for (const d of drivers) {
    // oferta encerrada antes (outro aceitou e desistiu) volta a valer
    await query(
      `INSERT INTO ride_offers (ride_id, driver_id) VALUES ($1, $2)
       ON CONFLICT (ride_id, driver_id) DO UPDATE SET status = 'sent', created_at = now()`,
      [rideId, d.user_id],
    );
    emitTo(`user:${d.user_id}`, 'ride:offer', {
      rideId,
      pickupDistanceKm: Math.round(d.dist * 10) / 10,
      origin: { lat: ride.origin_lat, lng: ride.origin_lng, address: ride.origin_address },
      // destino e valor visíveis antes de aceitar (exigido em várias leis municipais)
      destination: { lat: ride.dest_lat, lng: ride.dest_lng, address: ride.dest_address },
      distanceKm: ride.distance_km,
      durationMin: ride.duration_min,
      priceCents: ride.price_cents,
      paymentMethod: ride.payment_method,
      kind: ride.kind,
      serviceName: ride.service_name,
      scheduledFor: ride.scheduled_for,
      hoursBooked: ride.hours_booked,
      helpers: ride.helpers,
      notes: ride.notes,
      packageDesc: ride.package_desc,
      wheelchair: ride.wheelchair,
      companion: ride.companion,
      codAmountCents: ride.cod_amount_cents,
      // entrega do turno de entregador fixo (Daqui Food): já paga pelo turno
      shift: !!onlyDriver,
    });
  }
  // com o app fechado ou a tela apagada, a oferta chega por push
  if (drivers.length) {
    await pushTo(drivers.map((d) => d.user_id), {
      title: onlyDriver ? 'Entrega do seu turno fixo' : `${ride.kind === 'corrida' ? 'Nova corrida' : ride.service_name ?? 'Novo pedido'} · ${money(ride.price_cents)}`,
      body: ride.kind === 'particular'
        ? `${ride.hours_booked} h · buscar em ${ride.origin_address}`
        : `Buscar em ${ride.origin_address} → ${ride.dest_address}`,
      data: { type: 'offer', rideId },
      channelId: CHANNEL_OFFERS,
      ttl: 30, // a oferta perde a validade rápido
    });
  }
  return drivers.length;
}

/**
 * Rodada periódica: oferece de novo as corridas sem motorista e cancela as
 * que passaram do tempo limite de busca.
 */
export async function sweepPendingRides() {
  // agendadas: começam a procurar motorista um pouco antes do horário
  const due = await query<{ id: string }>(
    `SELECT id FROM rides WHERE status = 'scheduled' AND scheduled_for <= now() + make_interval(mins => $1)`,
    [SCHEDULE_LEAD_MIN],
  );
  for (const r of due) {
    try {
      const up = await one(
        `UPDATE rides SET status = 'requested', requested_at = now() WHERE id = $1 AND status = 'scheduled'
          RETURNING passenger_id, (SELECT name FROM ride_categories c WHERE c.tenant_id = rides.tenant_id AND c.code = rides.category_code) AS service`,
        [r.id],
      );
      await notifyRide(r.id, { push: false });
      if (up?.passenger_id) {
        await pushTo(up.passenger_id, {
          title: 'Sua corrida agendada começou', body: `Já estamos chamando os motoristas do ${up.service ?? 'OnDaqui'} mais próximos.`,
          data: { type: 'ride', rideId: r.id }, channelId: CHANNEL_UPDATES,
        });
      }
    } catch (e: any) {
      if (e.code !== '23505') throw e; // passageiro ainda em outra corrida: tenta na próxima rodada
    }
  }

  // sem motorista: imediata desiste depois de alguns minutos; agendada procura até 10 min depois do horário
  const expired = await query<{ id: string }>(
    `UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'sem_motorista', cancelled_by = 'sistema'
      WHERE status = 'requested' AND requested_at < now() - make_interval(mins => $1)
        AND (scheduled_for IS NULL OR scheduled_for < now() - interval '10 minutes')
      RETURNING id`,
    [config.rideSearchTimeoutMin],
  );
  for (const r of expired) {
    await refundDelivery(r.id); // entrega de loja sem motoboy: o frete volta para os créditos
    await releaseCashback(r.id); // passageiro: o cashback reservado volta para o saldo
    await notifyRide(r.id);
  }

  // assinantes do Clube primeiro
  const pending = await query<{ id: string }>(`SELECT id FROM rides WHERE status = 'requested' ORDER BY club_member DESC, requested_at`);
  let offered = 0;
  for (const r of pending) offered += await dispatchRide(r.id);

  // motorista online sem sinal de GPS há muito tempo (fora da cidade, celular sem bateria) fica offline
  const stale = await query<{ user_id: string; tenant_id: string }>(
    `UPDATE drivers d SET online = false
       FROM users u
      WHERE u.id = d.user_id AND d.online
        AND (d.location_at IS NULL OR d.location_at < now() - make_interval(mins => $1))
        AND NOT EXISTS (SELECT 1 FROM rides x WHERE x.driver_id = d.user_id AND x.status IN ('accepted','arrived','in_progress'))
      RETURNING d.user_id, u.tenant_id`,
    [config.driverOfflineAfterMin],
  );
  for (const d of stale) {
    emitTo(`admin:${d.tenant_id}`, 'driver:status', { driverId: d.user_id, online: false });
    emitTo(`user:${d.user_id}`, 'driver:offline', { reason: 'sem_localizacao' });
    await pushTo(d.user_id, {
      title: 'Você ficou offline',
      body: 'Ficamos sem receber sua localização. Abra o app e fique online de novo para receber corridas.',
      data: { type: 'offline' }, channelId: CHANNEL_UPDATES,
    });
  }
  return { expired: expired.length, offered, wentOffline: stale.length };
}

/** Licenciado novo já nasce com categorias e planos sugeridos no documento do produto */
export async function createTenantDefaults(tenantId: string, db: Db) {
  // todos os serviços: Car, Moto, Executivo, Mulher, Pet, Entrega, Particular, Frete e Prefeitura
  await query(`SELECT ondaqui_servicos_padrao($1)`, [tenantId], db);
  await query(
    `INSERT INTO driver_plans (tenant_id, code, name, price_cents, period_days, commission_pct) VALUES
       ($1, 'livre',        'Livre (10% por corrida)', 0,     0,  10),
       ($1, 'semanal',      'Semanal',                 5900,  7,  0),
       ($1, 'profissional', 'Profissional',            19900, 30, 0)`,
    [tenantId], db,
  );
}
