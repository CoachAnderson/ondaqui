import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { one, query } from './db.js';
import { HttpError, badRequest } from './errors.js';
import { sendSms, toE164 } from './sms.js';

export type CodePurpose = 'cadastro' | 'senha';

export const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_SEC = 60;
const MAX_PER_HOUR = 5;

const hash = (code: string) => createHmac('sha256', config.jwtSecret).update(`codigo:${code}`).digest('hex');

/** Gera e envia um código de 6 números para o celular. Limita reenvios por número. */
export async function issueCode(tenant: { id: string; name: string }, phone: string, purpose: CodePurpose) {
  const recent = await one<{ last: Date | null; n: number }>(
    `SELECT max(created_at) FILTER (WHERE purpose = $3) AS last, count(*)::int AS n FROM phone_codes
      WHERE tenant_id = $1 AND phone = $2 AND created_at > now() - interval '1 hour'`,
    [tenant.id, phone, purpose],
  );
  if (recent?.last && Date.now() - new Date(recent.last).getTime() < RESEND_AFTER_SEC * 1000) {
    const wait = Math.ceil(RESEND_AFTER_SEC - (Date.now() - new Date(recent.last).getTime()) / 1000);
    throw new HttpError(429, `Aguarde ${wait} segundos para pedir outro código.`, 'aguarde_reenvio');
  }
  if ((recent?.n ?? 0) >= MAX_PER_HOUR) {
    throw new HttpError(429, 'Muitos códigos pedidos para este número. Tente de novo daqui a uma hora.', 'limite_codigos');
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  // o código anterior deixa de valer
  await query(`UPDATE phone_codes SET used_at = now() WHERE tenant_id = $1 AND phone = $2 AND purpose = $3 AND used_at IS NULL`,
    [tenant.id, phone, purpose]);
  await query(
    `INSERT INTO phone_codes (tenant_id, phone, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [tenant.id, phone, purpose, hash(code), CODE_TTL_MIN],
  );
  const what = purpose === 'cadastro' ? 'confirmar seu celular' : 'criar uma senha nova';
  try {
    await sendSms({
      to: toE164(phone),
      code,
      tenant: tenant.name,
      text: `${tenant.name}: seu código para ${what} é ${code}. Vale por ${CODE_TTL_MIN} minutos. Não passe este código para ninguém.`,
    });
  } catch (e) {
    console.error('[sms]', e instanceof Error ? e.message : e);
    throw new HttpError(502, 'Não conseguimos enviar o código agora. Tente de novo em instantes.', 'sms_indisponivel');
  }
}

/**
 * Confere o código e o marca como usado. Roda fora da transação de quem chama, para que a contagem
 * de tentativas erradas nunca seja desfeita. Erra 5 vezes e o código deixa de valer.
 */
export async function consumeCode(tenantId: string, phone: string, purpose: CodePurpose, code: string) {
  const row = await one<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM phone_codes
      WHERE tenant_id = $1 AND phone = $2 AND purpose = $3 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, phone, purpose],
  );
  if (!row) throw badRequest('Código vencido ou inexistente. Peça um código novo.', 'codigo_vencido');
  const given = Buffer.from(hash(code.replace(/\D/g, '')));
  const ok = given.length === row.code_hash.length && timingSafeEqual(given, Buffer.from(row.code_hash));
  if (!ok) {
    const r = await one<{ attempts: number }>(
      `UPDATE phone_codes SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= $2 THEN now() END
        WHERE id = $1 RETURNING attempts`,
      [row.id, MAX_ATTEMPTS],
    );
    const blocked = (r?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
    throw badRequest(blocked ? 'Código errado muitas vezes. Peça um código novo.' : 'Código incorreto.',
      blocked ? 'codigo_bloqueado' : 'codigo_incorreto');
  }
  const used = await one(`UPDATE phone_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [row.id]);
  if (!used) throw badRequest('Código vencido ou inexistente. Peça um código novo.', 'codigo_vencido');
}
