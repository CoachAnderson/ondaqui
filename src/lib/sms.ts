import { config } from './config.js';

/**
 * Envio de códigos por SMS ou WhatsApp.
 *   SMS_PROVIDER=twilio   Twilio (SMS, ou WhatsApp se TWILIO_FROM começar com "whatsapp:")
 *   SMS_PROVIDER=webhook  POST JSON para SMS_WEBHOOK_URL (Zenvia, Z-API, Evolution API ou um serviço seu)
 *   SMS_PROVIDER=log      só escreve no log da API (desenvolvimento)
 *   SMS_PROVIDER=test     guarda em smsOutbox (testes automáticos)
 */
export interface Sms { to: string; text: string; code: string; tenant: string }

export const smsOutbox: Sms[] = [];

/** Celular brasileiro no formato internacional: 5514999990000 */
export function toE164(phone: string) {
  const d = phone.replace(/\D/g, '');
  return d.length <= 11 ? `55${d}` : d;
}

export function smsConfigured() {
  const p = config.smsProvider;
  if (p === 'twilio') return !!(config.twilioSid && config.twilioToken && config.twilioFrom);
  if (p === 'webhook') return !!config.smsWebhookUrl;
  return p === 'log' || p === 'test';
}

export async function sendSms(msg: Sms) {
  const p = config.smsProvider;
  if (p === 'test') { smsOutbox.push(msg); return; }
  if (p === 'log') { console.log(`[sms] para ${msg.to}: ${msg.text}`); return; }

  const timeout = AbortSignal.timeout(8000);
  let res: Response;
  if (p === 'twilio') {
    const whats = config.twilioFrom.startsWith('whatsapp:');
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioSid)}/Messages.json`, {
      method: 'POST',
      signal: timeout,
      headers: {
        authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: `${whats ? 'whatsapp:' : ''}+${msg.to}`, From: config.twilioFrom, Body: msg.text }),
    });
  } else if (p === 'webhook') {
    res = await fetch(config.smsWebhookUrl, {
      method: 'POST',
      signal: timeout,
      headers: {
        'content-type': 'application/json',
        ...(config.smsWebhookToken ? { authorization: `Bearer ${config.smsWebhookToken}` } : {}),
      },
      body: JSON.stringify({ phone: msg.to, message: msg.text, code: msg.code, tenant: msg.tenant }),
    });
  } else {
    throw new Error(`SMS_PROVIDER desconhecido: ${p}`);
  }
  if (!res.ok) throw new Error(`envio do código falhou (${p} respondeu ${res.status})`);
}
