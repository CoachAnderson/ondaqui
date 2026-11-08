import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './lib/config.js';
import { pool } from './lib/db.js';
import { ZodError } from 'zod';
import { HttpError } from './lib/errors.js';
import { attachRealtime, closeRealtime } from './lib/realtime.js';
import { authRoutes } from './routes/auth.js';
import { publicRoutes } from './routes/public.js';
import { privacyRoutes } from './routes/privacy.js';
import { familyRoutes } from './routes/family.js';
import { cashbackRoutes } from './routes/cashback.js';
import { clubRoutes } from './routes/club.js';
import { adRoutes } from './routes/ads.js';
import { escolaRoutes } from './routes/escola.js';
import { foodRoutes } from './routes/food.js';
import { rideRoutes } from './routes/rides.js';
import { chatRoutes } from './routes/chat.js';
import { driverRoutes } from './routes/driver.js';
import { adminRoutes } from './routes/admin.js';
import { masterRoutes } from './routes/master.js';
import { billingRoutes } from './routes/billing.js';
import { accountRoutes } from './routes/accounts.js';
import { storeRoutes } from './routes/stores.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  // trustProxy: atrás do Nginx, o IP real do cliente vem no X-Forwarded-For
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1024 * 1024 });

  // o app do celular não envia Origin; o painel no navegador só é aceito pelos endereços configurados
  await app.register(cors, {
    origin: config.corsOrigins.length ? (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)) : true,
    // o padrão do @fastify/cors libera só GET, HEAD e POST: o painel e o app web também editam e excluem
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  // limite de requisições por IP; login e cadastro têm limite mais baixo (contra tentativa de senha)
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Muitas tentativas. Aguarde um minuto e tente de novo.', code: 'muitas_tentativas' }),
  });


  app.setErrorHandler((err: Error, req, reply) => {
    if ((err as any).statusCode === 429) {
      return reply.code(429).send({ error: 'Muitas tentativas. Aguarde um minuto e tente de novo.', code: 'muitas_tentativas' });
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos', code: 'dados_invalidos' });
    }
    const status = (err as any).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: err.message, code: 'requisicao_invalida' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Erro interno. Tente novamente.', code: 'erro_interno' });
  });

  // usado pelo Docker e pelo monitoramento: confere também o banco
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, app: 'ondaqui-api' };
    } catch {
      return reply.code(503).send({ ok: false, app: 'ondaqui-api', error: 'banco indisponível' });
    }
  });

  await app.register(authRoutes);
  await app.register(publicRoutes);
  await app.register(privacyRoutes);
  await app.register(familyRoutes);
  await app.register(cashbackRoutes);
  await app.register(clubRoutes);
  await app.register(adRoutes);
  await app.register(escolaRoutes);
  await app.register(foodRoutes);
  await app.register(rideRoutes);
  await app.register(chatRoutes);
  await app.register(driverRoutes);
  await app.register(adminRoutes);
  await app.register(masterRoutes);
  await app.register(billingRoutes);
  await app.register(accountRoutes);
  await app.register(storeRoutes);

  attachRealtime(app.server);
  app.addHook('onClose', async () => closeRealtime());
  return app;
}
