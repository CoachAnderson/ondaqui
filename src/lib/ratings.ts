import { one, query, pool, type Db } from './db.js';
import { CHANNEL_UPDATES, pushTo } from './push.js';
import { emitTo } from './realtime.js';

/**
 * Nota do motorista (termos do motorista, cláusula 6.2): média abaixo de 4,5 nas últimas 50 avaliações
 * gera um aviso com orientação, antes de qualquer medida. Só conta com pelo menos 10 avaliações, e o
 * aviso não se repete por 7 dias.
 */
export const RATING = { below: 4.5, window: 50, minRatings: 10, cooldownDays: 7 };

/** Média das últimas avaliações que os passageiros deram ao motorista */
export async function driverRating(driverId: string, db: Db = pool) {
  const r = await one<{ average: string | null; ratings: number }>(
    `SELECT round(avg(s)::numeric, 2) AS average, count(*)::int AS ratings FROM (
       SELECT driver_rating AS s FROM rides
        WHERE driver_id = $1 AND driver_rating IS NOT NULL
        ORDER BY completed_at DESC NULLS LAST LIMIT $2) last`,
    [driverId, RATING.window], db,
  );
  // preferências da viagem: das últimas corridas em que o passageiro respondeu, quantas foram respeitadas
  const p = await one<{ asked: number; respected: number }>(
    `SELECT count(*)::int AS asked, count(*) FILTER (WHERE prefs_respected)::int AS respected FROM (
       SELECT prefs_respected FROM rides WHERE driver_id = $1 AND prefs_respected IS NOT NULL
        ORDER BY completed_at DESC NULLS LAST LIMIT $2) last`,
    [driverId, RATING.window], db,
  );
  return {
    average: r?.average != null ? Number(r.average) : null, ratings: r?.ratings ?? 0,
    prefs: { asked: p?.asked ?? 0, respected: p?.respected ?? 0 },
  };
}

/** Confere a nota depois de cada avaliação e avisa o motorista (e a central) quando cair */
export async function checkDriverRating(driverId: string) {
  const { average, ratings } = await driverRating(driverId);
  if (average == null || ratings < RATING.minRatings || average >= RATING.below) return null;
  const recent = await one(
    `SELECT 1 FROM driver_rating_alerts WHERE driver_id = $1 AND created_at > now() - make_interval(days => $2)`,
    [driverId, RATING.cooldownDays],
  );
  if (recent) return null;
  const alert = await one(
    `INSERT INTO driver_rating_alerts (tenant_id, driver_id, average, ratings)
     SELECT tenant_id, id, $2, $3 FROM users WHERE id = $1 RETURNING *`,
    [driverId, average, ratings],
  );
  if (!alert) return null;
  const nota = average.toFixed(2).replace('.', ',');
  emitTo(`user:${driverId}`, 'driver:rating-alert', { average, ratings });
  emitTo(`admin:${alert.tenant_id}`, 'driver:rating-alert', { driverId, average, ratings });
  await pushTo(driverId, {
    title: 'Sua nota caiu',
    body: `Sua média nas últimas ${ratings} avaliações é ${nota}. Veja no app como melhorar.`,
    channelId: CHANNEL_UPDATES, data: { type: 'rating_alert' },
  }).catch(() => {});
  return alert;
}

/** Último aviso ainda valendo (30 dias) para o app do motorista */
export async function openRatingAlert(driverId: string, db: Db = pool) {
  return one(
    `SELECT id, average, ratings, created_at, acknowledged_at FROM driver_rating_alerts
      WHERE driver_id = $1 AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 1`,
    [driverId], db,
  );
}

export async function acknowledgeRatingAlerts(driverId: string) {
  await query(`UPDATE driver_rating_alerts SET acknowledged_at = now() WHERE driver_id = $1 AND acknowledged_at IS NULL`, [driverId]);
}
