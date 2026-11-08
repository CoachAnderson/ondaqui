import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, query, tx } from '../lib/db.js';
import { checkPassword, requireAuth, requireAuthEvenSuspended } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { config } from '../lib/config.js';
import { removeImages } from '../lib/images.js';
import { ACTIVE_STATUSES } from '../lib/rides.js';
import { tenantExport, userExport } from '../lib/export.js';
import { uuid } from '../lib/validate.js';

/** Campos da empresa do licenciado que a política pública precisa ter preenchidos */
const REQUIRED = [
  ['legal_name', 'Razão social'],
  ['cnpj', 'CNPJ'],
  ['legal_address', 'Endereço da empresa'],
  ['dpo_email', 'E-mail do encarregado (DPO)'],
] as const;

const legalPatch = z.object({
  legalName: z.string().trim().max(160).optional(),
  cnpj: z.string().trim().regex(/^(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})?$/, 'CNPJ no formato 00.000.000/0000-00').optional(),
  legalAddress: z.string().trim().max(240).optional(),
  supportEmail: z.union([z.literal(''), z.string().trim().email('e-mail de atendimento inválido')]).optional(),
  supportWhatsapp: z.string().trim().max(30).optional(),
  dpoName: z.string().trim().max(120).optional(),
  dpoEmail: z.union([z.literal(''), z.string().trim().email('e-mail do encarregado inválido')]).optional(),
});

const LEGAL_COLS = `legal_name, cnpj, legal_address, support_email, support_whatsapp, dpo_name, dpo_email,
                    privacy_version, privacy_updated_on`;

function missingOf(t: Record<string, unknown>) {
  return REQUIRED.filter(([k]) => !t[k]).map(([, label]) => label);
}

const publicUrl = (slug: string) => (config.painelUrl ? `${config.painelUrl}/privacidade/${slug}` : `/privacidade/${slug}`);

export async function privacyRoutes(app: FastifyInstance) {
  // ---------- página pública da política (usada pelo painel, pelos apps e pelas lojas de aplicativos) ----------
  app.get<{ Params: { slug: string } }>('/public/tenants/:slug/privacidade', async (req) => {
    const t = await one(
      `SELECT id, slug, name, city_label, accent_color, ${LEGAL_COLS} FROM tenants WHERE slug = $1 AND active`,
      [req.params.slug],
    );
    if (!t) throw notFound('Cidade não encontrada');
    const kinds = await query<{ kind: string }>(
      `SELECT DISTINCT kind FROM ride_categories WHERE tenant_id = $1 AND active`, [t.id],
    );
    const has = (k: string) => kinds.some((r) => r.kind === k);
    const stores = await one(`SELECT count(*)::int AS n FROM accounts WHERE tenant_id = $1 AND kind = 'loja' AND active`, [t.id])
      .catch(() => ({ n: 0 }));
    const { id, ...rest } = t;
    return {
      ...rest,
      platform: { legalName: config.platformLegalName, cnpj: config.platformCnpj },
      services: { entrega: has('entrega') || has('frete'), paciente: has('paciente'), lojas: (stores?.n ?? 0) > 0 },
      complete: missingOf(t).length === 0,
    };
  });

  // ---------- licenciado: dados da empresa e versão da política ----------
  const admin = { preHandler: requireAuth('tenant_admin') };

  async function adminView(tenantId: string) {
    const t = await one(`SELECT slug, ${LEGAL_COLS} FROM tenants WHERE id = $1`, [tenantId]);
    const s = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE privacy_version = $2)::int AS accepted
         FROM users WHERE tenant_id = $1 AND role IN ('passenger','driver') AND deleted_at IS NULL`,
      [tenantId, t.privacy_version],
    );
    return { ...t, publicUrl: publicUrl(t.slug), missing: missingOf(t), users: s };
  }

  app.get('/admin/privacy', admin, async (req) => adminView(req.auth.tenantId!));

  app.patch('/admin/privacy', admin, async (req) => {
    const b = parse(legalPatch, req.body);
    const t = await one('SELECT * FROM tenants WHERE id = $1', [req.auth.tenantId]);
    const v = (x: string | undefined, cur: string | null) => (x === undefined ? cur : x || null);
    await query(
      `UPDATE tenants SET legal_name = $2, cnpj = $3, legal_address = $4, support_email = $5, support_whatsapp = $6,
                          dpo_name = $7, dpo_email = $8 WHERE id = $1`,
      [t.id, v(b.legalName, t.legal_name), v(b.cnpj, t.cnpj), v(b.legalAddress, t.legal_address), v(b.supportEmail, t.support_email),
       v(b.supportWhatsapp, t.support_whatsapp), v(b.dpoName, t.dpo_name), v(b.dpoEmail, t.dpo_email)],
    );
    return adminView(t.id);
  });

  // Publica uma versão nova: passageiros e motoristas aceitam de novo na próxima vez que abrirem o app
  app.post('/admin/privacy/new-version', admin, async (req) => {
    await query(
      `UPDATE tenants SET privacy_version = privacy_version + 1, privacy_updated_on = current_date WHERE id = $1`,
      [req.auth.tenantId],
    );
    return adminView(req.auth.tenantId!);
  });

  // ---------- titular: aceite e exclusão da conta ----------
  const user = { preHandler: requireAuth('passenger', 'driver') };

  app.get('/me/privacy', user, async (req) => {
    const r = await one(
      `SELECT u.privacy_version AS accepted_version, u.privacy_accepted_at, t.privacy_version AS current_version,
              t.privacy_updated_on, t.slug
         FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [req.auth.id],
    );
    return { ...r, mustAccept: r.accepted_version !== r.current_version, url: publicUrl(r.slug) };
  });

  app.post('/me/privacy/accept', user, async (req) => {
    const b = parse(z.object({ version: z.number().int().min(1) }), req.body);
    const t = await one(`SELECT privacy_version FROM tenants WHERE id = $1`, [req.auth.tenantId]);
    // só vale o aceite da versão que a pessoa leu; se mudou no meio, o app mostra a nova
    if (b.version !== t.privacy_version) throw conflict('A política foi atualizada. Leia a versão nova.', 'versao_desatualizada');
    await query(`UPDATE users SET privacy_version = $2, privacy_accepted_at = now() WHERE id = $1`, [req.auth.id, b.version]);
    return { ok: true, version: b.version };
  });

  /**
   * Exclusão da conta pelo titular (LGPD art. 18 e exigência da Apple e do Google).
   * Apaga ou anonimiza os dados pessoais na hora. O histórico de corridas e pagamentos fica guardado,
   * sem nome nem telefone, pelo prazo legal (defesa em disputas, obrigações fiscais).
   */
  app.delete('/me', user, async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1, 'Digite a sua senha') }), req.body ?? {});
    const u = await one(`SELECT * FROM users WHERE id = $1`, [req.auth.id]);
    // 400 e não 401: senha errada aqui não pode derrubar a sessão do app
    if (!(await checkPassword(password, u.password_hash))) throw badRequest('Senha incorreta', 'senha_incorreta');

    const busy = await one(
      `SELECT 1 FROM rides WHERE (passenger_id = $1 OR driver_id = $1) AND status = ANY($2::text[]) LIMIT 1`,
      [u.id, [...ACTIVE_STATUSES]],
    );
    if (busy) throw conflict('Termine ou cancele a corrida em andamento antes de excluir a conta.', 'corrida_em_andamento');

    const d = u.role === 'driver' ? await one(`SELECT * FROM drivers WHERE user_id = $1`, [u.id]) : null;

    await tx(async (db) => {
      // corridas agendadas que ainda não começaram são canceladas
      await query(
        `UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'passageiro', cancel_reason = 'conta_excluida'
          WHERE passenger_id = $1 AND status = 'scheduled'`,
        [u.id], db,
      );
      // nome e telefone saem; o telefone fica livre para um cadastro novo
      await query(
        `UPDATE users SET name = 'Conta excluída', phone = $2, password_hash = '!', blocked = true, declared_woman = false,
                          deleted_at = now()
          WHERE id = $1`,
        [u.id, `excluida-${randomUUID()}`], db,
      );
      await query(`DELETE FROM push_tokens WHERE user_id = $1`, [u.id], db);
      // dados dos parentes cadastrados no Modo família saem junto (as corridas ficam, sem o nome)
      await query(`UPDATE rides SET family_member_id = NULL WHERE family_member_id IN (SELECT id FROM family_members WHERE owner_id = $1)`, [u.id], db);
      await query(`DELETE FROM family_members WHERE owner_id = $1`, [u.id], db);
      // transporte escolar: o contrato acaba e os dados do aluno saem (o histórico de pagamentos fica, sem nome)
      await query(
        `UPDATE school_contracts SET status = CASE WHEN status IN ('encerrado','recusado') THEN status ELSE 'encerrado' END, ended_at = coalesce(ended_at, now()),
                student_name = 'Aluno (conta excluída)', grade = NULL, notes = NULL, home_address = 'Endereço removido'
          WHERE parent_id = $1`,
        [u.id], db,
      );
      await query(`UPDATE school_trips SET status = 'cancelado' WHERE status = 'previsto' AND contract_id IN (SELECT id FROM school_contracts WHERE parent_id = $1)`, [u.id], db);
      // Daqui Food: os pedidos ficam (prestação de contas do restaurante), sem nome, celular e endereço
      await query(
        `UPDATE food_orders SET customer_name = 'Cliente (conta excluída)', customer_phone = NULL, dest_address = 'Endereço removido', notes = NULL
          WHERE customer_id = $1`, [u.id], db,
      );
      if (d) {
        await query(
          `UPDATE drivers SET online = false, status = 'blocked', lat = NULL, lng = NULL, location_at = NULL,
                              pix_key = NULL, pix_holder_name = NULL, pix_validated = false,
                              photo_path = NULL, vehicle_photo_path = NULL, photo_pending_path = NULL, vehicle_pending_path = NULL,
                              photo_status = 'none', photo_review = NULL, selfie_path = NULL
            WHERE user_id = $1`,
          [u.id], db,
        );
      }
    });
    if (d) await removeImages(d.photo_path, d.vehicle_photo_path, d.photo_pending_path, d.vehicle_pending_path, d.selfie_path);
    return { ok: true };
  });

  // ---------- exportação dos dados ----------

  async function sendTenantZip(reply: import('fastify').FastifyReply, tenantId: string, userId: string) {
    const r = await tenantExport(tenantId);
    await query(`INSERT INTO data_exports (tenant_id, user_id, kind) VALUES ($1, $2, 'cidade')`, [tenantId, userId]);
    reply.type('application/zip')
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('cache-control', 'no-store');
    return reply.send(Buffer.from(r.zip));
  }

  // Licenciado: todos os dados da cidade em planilhas (funciona mesmo com a cidade suspensa)
  const adminEvenSuspended = { preHandler: requireAuthEvenSuspended('tenant_admin') };
  app.get('/admin/export', adminEvenSuspended, async (req, reply) => sendTenantZip(reply, req.auth.tenantId!, req.auth.id));

  app.get('/admin/exports', adminEvenSuspended, async (req) => ({
    exports: await query(
      `SELECT e.created_at, e.kind, u.name AS by_name, u.role AS by_role FROM data_exports e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.tenant_id = $1 AND e.kind = 'cidade' ORDER BY e.created_at DESC LIMIT 20`,
      [req.auth.tenantId],
    ),
  }));

  // Dono da plataforma: entrega os dados ao licenciado no fim do contrato
  app.get<{ Params: { id: string } }>('/master/tenants/:id/export', { preHandler: requireAuth('master') }, async (req, reply) => {
    parse(uuid, req.params.id);
    return sendTenantZip(reply, req.params.id, req.auth.id);
  });

  // Titular: cópia dos próprios dados (portabilidade da LGPD)
  app.get('/me/export', user, async (req) => {
    const data = await userExport(req.auth.id);
    await query(`INSERT INTO data_exports (tenant_id, user_id, kind) VALUES ($1, $2, 'titular')`, [req.auth.tenantId, req.auth.id]);
    return data;
  });
}
