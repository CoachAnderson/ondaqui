import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

/**
 * Criptografia AES-256-GCM para segredos guardados no banco (tokens do Mercado Pago).
 * Em produção a chave vem de ENCRYPTION_KEY (64 caracteres hex). Em desenvolvimento,
 * sem a variável, deriva uma chave do JWT_SECRET para os testes funcionarem.
 */
function key(): Buffer {
  if (/^[0-9a-f]{64}$/i.test(config.encryptionKey)) return Buffer.from(config.encryptionKey, 'hex');
  if (config.isProduction) throw new Error('ENCRYPTION_KEY precisa ter 64 caracteres hexadecimais em produção');
  return createHash('sha256').update(`ondaqui-dev:${config.jwtSecret}`).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('segredo em formato desconhecido');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** Mostra só o final de um segredo: "••••1234" */
export const mask = (s: string) => `••••${s.slice(-4)}`;
