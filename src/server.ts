import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { sweepPendingRides } from './lib/rides.js';
import { runFoodJobs } from './lib/food.js';
import { runBillingJobs } from './lib/billing.js';
import { migrate } from './migrate.js';
import { purgeOldMessages } from './routes/chat.js';

if (config.isProduction && config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET precisa ter pelo menos 32 caracteres em produção');
}
if (config.runMigrations) await migrate();

const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });

// a cada 15 s: oferece de novo corridas sem motorista e encerra as que passaram do tempo
const timer = setInterval(() => {
  sweepPendingRides().catch((e) => app.log.error(e, 'falha na rodada de despacho'));
  // Daqui Food: Pix vencido, restaurante sem resposta, entregador fixo sem resposta e turnos encerrados
  runFoodJobs().catch((e) => app.log.error(e, 'falha na rodada do Daqui Food'));
}, 15_000);

// a cada hora: faturas do mês, suspensão por atraso, lembretes de vencimento e links vencidos
const billing = () => runBillingJobs()
  .then((r) => (r.invoices || r.suspended || r.reminders) && app.log.info(r, 'rodada de cobrança'))
  .catch((e) => app.log.error(e, 'falha na rodada de cobrança'));
// e apaga as conversas do chat de corridas encerradas há mais de 30 dias
const privacy = () => purgeOldMessages().catch((e) => app.log.error(e, 'falha ao apagar conversas antigas'));
setInterval(privacy, 60 * 60_000);
setTimeout(billing, 30_000);
const billingTimer = setInterval(billing, 60 * 60_000);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(timer);
    clearInterval(billingTimer);
    await app.close();
    process.exit(0);
  });
}
