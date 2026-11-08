import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, tx, query } from '../lib/db.js';
import { checkPassword, hashPassword, requireAuth, requireAuthEvenSuspended, signToken, type Role } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { parse, phone } from '../lib/validate.js';
import { TOKEN_RE } from '../lib/push.js';
import { DRIVER_OPT_IN } from '../lib/rides.js';
import { config } from '../lib/config.js';
import { CODE_TTL_MIN, consumeCode, issueCode } from '../lib/codes.js';
import { claimPhoneCashback } from '../lib/cashback.js';
import { PREF_OPTIONS, prefsSummary, readPrefs, tripPrefsSchema } from '../lib/prefs.js';

// contra tentativas de adivinhar senha: poucas tentativas por minuto por IP
const authLimit = { config: { rateLimit: { max: config.isProduction ? 10 : 1000, timeWindow: '1 minute' } } };

const registerSchema = z.object({
  tenant: z.string(),
  name: z.string().trim().min(3).max(80),
  phone,
  password: z.string().min(6).max(100),
  role: z.enum(['passenger', 'driver']),
  declaredWoman: z.boolean().optional(), // libera o Daqui Mulher para a passageira
  // LGPD: o cadastro só existe com o aceite da política de privacidade da cidade
  acceptPrivacy: z.literal(true, { error: 'Para criar a conta, aceite a política de privacidade' }),
  code: z.string().trim().max(10).optional(), // código recebido por SMS ou WhatsApp
  driver: z
    .object({
      category: z.string().default('carro'),
      vehicleType: z.enum(['carro', 'moto', 'utilitario']).optional(),
      services: z.array(z.enum(DRIVER_OPT_IN)).optional(),
      vehicle: z.object({
        plate: z.string().trim().toUpperCase().regex(/^[A-Z]{3}-?\d[A-Z0-9]\d{2}$/, 'placa inválida'),
        model: z.string().trim().min(2).max(60),
        color: z.string().trim().min(3).max(30),
      }),
      pixKey: z.string().trim().max(120).optional(),
      pixHolderName: z.string().trim().max(120).optional(),
      plan: z.string().default('livre'),
    })
    .optional(),
});

const loginSchema = z.object({
  tenant: z.string().optional(), // sem licenciado = login do painel master
  phone,
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', authLimit, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const tenant = await one('SELECT id, active, privacy_version FROM tenants WHERE slug = $1', [body.tenant]);
    if (!tenant || !tenant.active) throw notFound('Cidade não encontrada');
    if (body.role === 'driver' && !body.driver) throw badRequest('Dados do veículo são obrigatórios para motorista');

    const exists = await one('SELECT 1 FROM users WHERE tenant_id = $1 AND phone = $2', [tenant.id, body.phone]);
    if (exists) throw conflict('Este telefone já tem cadastro nesta cidade', 'telefone_em_uso');
    if (config.phoneVerification) {
      if (!body.code) throw badRequest('Confirme o celular com o código que enviamos', 'codigo_obrigatorio');
      await consumeCode(tenant.id, body.phone, 'cadastro', body.code);
    }

    const user = await tx(async (db) => {
      const u = await one(
        `INSERT INTO users (tenant_id, role, name, phone, password_hash, declared_woman, privacy_version, privacy_accepted_at,
                            phone_verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8) RETURNING id, role`,
        [tenant.id, body.role, body.name, body.phone, await hashPassword(body.password), body.declaredWoman ?? false,
         tenant.privacy_version, config.phoneVerification ? new Date() : null], db,
      );
      // cashback que uma loja deu para este celular antes do cadastro entra na conta
      if (body.role === 'passenger') await claimPhoneCashback(db, tenant.id, u!.id, body.phone);
      if (body.role === 'driver' && body.driver) {
        const d = body.driver;
        const vehicleType = d.vehicleType ?? (d.category === 'moto' ? 'moto' : d.category === 'frete' ? 'utilitario' : 'carro');
        const category = vehicleType === 'moto' ? 'moto' : vehicleType === 'utilitario' ? 'frete' : 'carro';
        const cat = await one('SELECT 1 FROM ride_categories WHERE tenant_id = $1 AND code = $2', [tenant.id, category], db);
        if (!cat) throw badRequest('Categoria inválida');
        const plan = await one('SELECT 1 FROM driver_plans WHERE tenant_id = $1 AND code = $2 AND active', [tenant.id, d.plan], db);
        if (!plan) throw badRequest('Plano inválido');
        await query(
          `INSERT INTO drivers (user_id, category_code, vehicle_type, services_opt_in, vehicle_plate, vehicle_model, vehicle_color,
                                pix_key, pix_holder_name, plan_code, trial_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, current_date + 30)`, // primeiro mês grátis
          [u!.id, category, vehicleType, d.services ?? ['entrega'], d.vehicle.plate.replace('-', ''), d.vehicle.model, d.vehicle.color,
           d.pixKey ?? null, d.pixHolderName ?? null, d.plan],
          db,
        );
      }
      return u!;
    });

    const token = signToken({ id: user.id, tenantId: tenant.id, role: user.role as Role });
    reply.code(201);
    return { token, user: { id: user.id, role: user.role, name: body.name } };
  });

  // Envia o código por SMS ou WhatsApp: confirmar o celular no cadastro ou criar uma senha nova
  app.post('/auth/code', authLimit, async (req) => {
    const b = parse(z.object({ tenant: z.string(), phone, purpose: z.enum(['cadastro', 'senha']) }), req.body);
    const tenant = await one('SELECT id, name, active FROM tenants WHERE slug = $1', [b.tenant]);
    if (!tenant || !tenant.active) throw notFound('Cidade não encontrada');
    const user = await one('SELECT id FROM users WHERE tenant_id = $1 AND phone = $2 AND deleted_at IS NULL', [tenant.id, b.phone]);
    if (b.purpose === 'cadastro' && user) throw conflict('Este telefone já tem cadastro nesta cidade', 'telefone_em_uso');
    // senha de número sem conta: responde igual, sem enviar nada (não revela quem tem cadastro)
    if (b.purpose === 'cadastro' || user) await issueCode(tenant, b.phone, b.purpose);
    return { ok: true, expiresInMin: CODE_TTL_MIN, resendAfterSec: 60 };
  });

  // Senha nova com o código recebido; já entra na conta e derruba as sessões abertas antes
  app.post('/auth/reset-password', authLimit, async (req) => {
    const b = parse(z.object({
      tenant: z.string(), phone, code: z.string().trim().min(4).max(10), password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres').max(100),
    }), req.body);
    const tenant = await one('SELECT id, active FROM tenants WHERE slug = $1', [b.tenant]);
    if (!tenant || !tenant.active) throw notFound('Cidade não encontrada');
    const user = await one('SELECT * FROM users WHERE tenant_id = $1 AND phone = $2 AND deleted_at IS NULL', [tenant.id, b.phone]);
    if (!user) throw badRequest('Código vencido ou inexistente. Peça um código novo.', 'codigo_vencido');
    if (user.blocked) throw forbidden('Conta bloqueada. Fale com o atendimento.');
    await consumeCode(tenant.id, b.phone, 'senha', b.code);
    await query(
      `UPDATE users SET password_hash = $2, password_changed_at = now(), phone_verified_at = coalesce(phone_verified_at, now())
        WHERE id = $1`,
      [user.id, await hashPassword(b.password)],
    );
    const token = signToken({ id: user.id, tenantId: tenant.id, role: user.role });
    return { token, user: { id: user.id, role: user.role, name: user.name } };
  });

  app.post('/auth/login', authLimit, async (req) => {
    const body = parse(loginSchema, req.body);
    let user;
    if (body.tenant) {
      user = await one(
        `SELECT u.* FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = $1 AND u.phone = $2`,
        [body.tenant, body.phone],
      );
    } else {
      user = await one(`SELECT * FROM users WHERE tenant_id IS NULL AND phone = $1`, [body.phone]);
    }
    if (!user || !(await checkPassword(body.password, user.password_hash))) {
      throw unauthorized('Telefone ou senha incorretos');
    }
    if (user.blocked) throw unauthorized('Conta bloqueada. Fale com o atendimento.');
    const token = signToken({ id: user.id, tenantId: user.tenant_id, role: user.role });
    return { token, user: { id: user.id, role: user.role, name: user.name } };
  });

  // funciona com o licenciado suspenso: o painel mostra o aviso e as faturas
  app.get('/me', { preHandler: requireAuthEvenSuspended() }, async (req) => {
    const u = await one(
      `SELECT u.id, u.role, u.name, u.phone, t.slug AS tenant, t.name AS tenant_name,
              t.active AS tenant_active, t.suspended_reason, u.declared_woman, u.account_id,
              (SELECT name FROM accounts a WHERE a.id = u.account_id) AS account_name,
              (SELECT kind FROM accounts a WHERE a.id = u.account_id) AS account_kind
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [req.auth.id],
    );
    return u;
  });

  app.patch('/me', { preHandler: requireAuth('passenger') }, async (req) => {
    const b = parse(z.object({ declaredWoman: z.boolean() }), req.body);
    const u = await one(`UPDATE users SET declared_woman = $2 WHERE id = $1 RETURNING declared_woman`, [req.auth.id, b.declaredWoman]);
    return { declaredWoman: u.declared_woman };
  });

  // Preferências da viagem do passageiro (música, conversa, ar-condicionado)
  app.get('/me/trip-prefs', { preHandler: requireAuth('passenger') }, async (req) => {
    const u = await one(`SELECT trip_prefs FROM users WHERE id = $1`, [req.auth.id]);
    const prefs = readPrefs(u?.trip_prefs);
    return { prefs, summary: prefsSummary(prefs), options: PREF_OPTIONS };
  });

  app.put('/me/trip-prefs', { preHandler: requireAuth('passenger') }, async (req) => {
    const prefs = parse(tripPrefsSchema, req.body);
    await query(`UPDATE users SET trip_prefs = $2 WHERE id = $1`, [req.auth.id, JSON.stringify(prefs)]);
    return { prefs, summary: prefsSummary(prefs), options: PREF_OPTIONS };
  });

  // Aparelho que recebe as notificações push desta conta
  app.post('/me/push-token', { preHandler: requireAuth('passenger', 'driver') }, async (req) => {
    const b = parse(z.object({
      token: z.string().regex(TOKEN_RE, 'token de notificação inválido'),
      platform: z.enum(['ios', 'android', 'web']),
    }), req.body);
    // o mesmo celular pode trocar de conta: o token passa para quem entrou agora
    await query(
      `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = $2, platform = $3, updated_at = now()`,
      [b.token, req.auth.id, b.platform],
    );
    return { ok: true };
  });

  app.delete('/me/push-token', { preHandler: requireAuth('passenger', 'driver') }, async (req) => {
    const { token } = parse(z.object({ token: z.string() }), req.body ?? {});
    await query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, req.auth.id]);
    return { ok: true };
  });
}
