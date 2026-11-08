import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, query } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { parse, uuid } from '../lib/validate.js';
import { removeImages, saveImage, sendImage } from '../lib/images.js';

/**
 * Anúncios: comércios da cidade anunciam no app, vendidos pelo licenciado.
 * Lugares: "inicio" (tela inicial do passageiro), "corrida" (durante a viagem) e "motorista" (app do motorista).
 * Sempre marcados como "Publicidade". Nada de rastrear quem viu: só a contagem por dia de vezes que apareceu e foi tocado.
 */
export const PLACEMENTS = ['inicio', 'corrida', 'motorista'] as const;
type Placement = (typeof PLACEMENTS)[number];

const TODAY = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

const adBody = z.object({
  advertiser: z.string().trim().min(2).max(60),
  title: z.string().trim().min(3).max(60),
  body: z.string().trim().max(140).nullable().optional(),
  ctaLabel: z.string().trim().max(24).nullable().optional(),
  // só endereço seguro: site, WhatsApp (wa.me), Instagram, cardápio digital
  link: z.string().trim().max(300).regex(/^https:\/\/[^\s]+\.[^\s]+$/, 'Use um endereço que comece com https://').nullable().optional(),
  placements: z.array(z.enum(PLACEMENTS)).min(1, 'Escolha onde o anúncio aparece'),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  weight: z.number().int().min(1).max(10).default(1),
  priceCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  active: z.boolean().optional(),
});

function adView(a: any) {
  return {
    id: a.id, advertiser: a.advertiser, title: a.title, body: a.body, ctaLabel: a.cta_label, link: a.link,
    hasImage: !!a.image_path, placements: a.placements,
  };
}

/** Escolhe um anúncio no ar para o lugar, sorteado pelo peso, e conta a exibição */
async function pickAd(tenantId: string, placement: Placement) {
  const ads = await query(
    `SELECT * FROM ads WHERE tenant_id = $1 AND active AND $2 = ANY(placements)
        AND starts_on <= ${TODAY} AND (ends_on IS NULL OR ends_on >= ${TODAY})`,
    [tenantId, placement],
  );
  if (ads.length === 0) return null;
  let n = Math.random() * ads.reduce((s, a) => s + a.weight, 0);
  const ad = ads.find((a) => (n -= a.weight) < 0) ?? ads[0];
  await query(
    `INSERT INTO ad_stats (ad_id, day, placement, impressions) VALUES ($1, ${TODAY}, $2, 1)
     ON CONFLICT (ad_id, day, placement) DO UPDATE SET impressions = ad_stats.impressions + 1`,
    [ad.id, placement],
  );
  return ad;
}

export async function adRoutes(app: FastifyInstance) {
  const viewer = { preHandler: requireAuth('passenger', 'driver') };
  const admin = { preHandler: requireAuth('tenant_admin') };

  // ---------- quem vê: passageiro e motorista ----------
  app.get<{ Querystring: { lugar?: string } }>('/ads', viewer, async (req) => {
    const placement = parse(z.enum(PLACEMENTS), req.query.lugar ?? (req.auth.role === 'driver' ? 'motorista' : 'inicio'));
    // motorista só vê os anúncios feitos para motoristas; passageiro, os da tela inicial e da viagem
    if ((placement === 'motorista') !== (req.auth.role === 'driver')) return { ad: null };
    const ad = await pickAd(req.auth.tenantId!, placement);
    return { ad: ad ? adView(ad) : null };
  });

  app.post<{ Params: { id: string } }>('/ads/:id/click', viewer, async (req) => {
    parse(uuid, req.params.id);
    const { lugar } = parse(z.object({ lugar: z.enum(PLACEMENTS) }), req.body ?? {});
    const ad = await one(`SELECT id, link FROM ads WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth.tenantId]);
    if (!ad) throw notFound('Anúncio não encontrado');
    await query(
      `INSERT INTO ad_stats (ad_id, day, placement, clicks) VALUES ($1, ${TODAY}, $2, 1)
       ON CONFLICT (ad_id, day, placement) DO UPDATE SET clicks = ad_stats.clicks + 1`,
      [ad.id, lugar],
    );
    return { link: ad.link };
  });

  app.get<{ Params: { id: string } }>('/ads/:id/image', { preHandler: requireAuth('passenger', 'driver', 'tenant_admin') }, async (req, reply) => {
    parse(uuid, req.params.id);
    const ad = await one(`SELECT image_path FROM ads WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth.tenantId]);
    if (!ad) throw notFound('Anúncio não encontrado');
    return sendImage(reply, ad.image_path, 'Imagem');
  });

  // ---------- licenciado ----------
  async function adOf(req: FastifyRequest, id: string) {
    parse(uuid, id);
    const a = await one(`SELECT * FROM ads WHERE id = $1 AND tenant_id = $2`, [id, req.auth.tenantId]);
    if (!a) throw notFound('Anúncio não encontrado');
    return a;
  }

  app.get('/admin/ads', admin, async (req) => {
    const ads = await query(
      `SELECT a.*, (a.active AND a.starts_on <= ${TODAY} AND (a.ends_on IS NULL OR a.ends_on >= ${TODAY})) AS live,
              coalesce(s.impressions, 0)::int AS impressions, coalesce(s.clicks, 0)::int AS clicks,
              coalesce(w.impressions, 0)::int AS impressions_7d, coalesce(w.clicks, 0)::int AS clicks_7d
         FROM ads a
         LEFT JOIN LATERAL (SELECT sum(impressions) AS impressions, sum(clicks) AS clicks FROM ad_stats WHERE ad_id = a.id) s ON true
         LEFT JOIN LATERAL (SELECT sum(impressions) AS impressions, sum(clicks) AS clicks FROM ad_stats
                             WHERE ad_id = a.id AND day > ${TODAY} - 7) w ON true
        WHERE a.tenant_id = $1 ORDER BY live DESC, a.created_at DESC`,
      [req.auth.tenantId],
    );
    return {
      ads: ads.map((a) => ({
        ...adView(a), startsOn: a.starts_on, endsOn: a.ends_on, weight: a.weight, priceCents: a.price_cents, active: a.active, live: a.live,
        impressions: a.impressions, clicks: a.clicks, impressions7d: a.impressions_7d, clicks7d: a.clicks_7d, createdAt: a.created_at,
      })),
    };
  });

  app.post('/admin/ads', admin, async (req, reply) => {
    const b = parse(adBody, req.body);
    const a = await one(
      `INSERT INTO ads (tenant_id, advertiser, title, body, cta_label, link, placements, starts_on, ends_on, weight, price_cents, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, ${TODAY}),$9,$10,$11,coalesce($12, true),$13) RETURNING *`,
      [req.auth.tenantId, b.advertiser, b.title, b.body ?? null, b.ctaLabel ?? null, b.link ?? null, [...new Set(b.placements)],
       b.startsOn ?? null, b.endsOn ?? null, b.weight, b.priceCents ?? null, b.active ?? null, req.auth.id],
    );
    reply.code(201);
    return { ad: adView(a) };
  });

  app.patch<{ Params: { id: string } }>('/admin/ads/:id', admin, async (req) => {
    const a = await adOf(req, req.params.id);
    const b = parse(adBody.partial(), req.body);
    const v = <T>(x: T | undefined, cur: T) => (x === undefined ? cur : x);
    const u = await one(
      `UPDATE ads SET advertiser = $2, title = $3, body = $4, cta_label = $5, link = $6, placements = $7, starts_on = $8, ends_on = $9,
              weight = $10, price_cents = $11, active = $12 WHERE id = $1 RETURNING *`,
      [a.id, v(b.advertiser, a.advertiser), v(b.title, a.title), v(b.body, a.body), v(b.ctaLabel, a.cta_label), v(b.link, a.link),
       b.placements ? [...new Set(b.placements)] : a.placements, v(b.startsOn, a.starts_on), v(b.endsOn, a.ends_on), v(b.weight, a.weight),
       v(b.priceCents, a.price_cents), v(b.active, a.active)],
    );
    return { ad: adView(u) };
  });

  app.put<{ Params: { id: string } }>('/admin/ads/:id/image', { ...admin, bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const a = await adOf(req, req.params.id);
    const { image } = parse(z.object({ image: z.string().min(100) }), req.body);
    const path = await saveImage('anuncios', a.id, image);
    await query(`UPDATE ads SET image_path = $2 WHERE id = $1`, [a.id, path]);
    await removeImages(a.image_path);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/admin/ads/:id', admin, async (req) => {
    const a = await adOf(req, req.params.id);
    await query(`DELETE FROM ads WHERE id = $1`, [a.id]);
    await removeImages(a.image_path);
    return { ok: true };
  });
}
