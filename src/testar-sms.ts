// Envia uma mensagem de teste pelo provedor configurado: node dist/testar-sms.js 14999999999
import { config } from './lib/config.js';
import { sendSms, smsConfigured, toE164 } from './lib/sms.js';

const phone = (process.argv[2] ?? '').replace(/\D/g, '');
if (phone.length < 10) {
  console.error('Uso: node dist/testar-sms.js 14999999999');
  process.exit(1);
}
if (!smsConfigured()) {
  console.error(`O envio por ${config.smsProvider} não está completo. Confira as opções no segredos.conf.`);
  process.exit(1);
}
sendSms({ to: toE164(phone), code: '000000', tenant: 'OnDaqui', text: 'OnDaqui: teste de envio de códigos. Está funcionando.' })
  .then(() => { console.log(`Mensagem de teste enviada para +${toE164(phone)} por ${config.smsProvider}.`); process.exit(0); })
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
