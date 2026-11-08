import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { FastifyRequest } from 'fastify';
import { config } from './config.js';
import { HttpError, forbidden, unauthorized } from './errors.js';
import { one } from './db.js';

export type Role = 'passenger' | 'driver' | 'tenant_admin' | 'master' | 'account_operator';

export interface AuthUser {
  id: string;
  tenantId: string | null;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthUser;
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signToken(u: AuthUser) {
  return jwt.sign({ tid: u.tenantId, role: u.role }, config.jwtSecret, { subject: u.id, expiresIn: '30d' });
}

export function verifyToken(token: string): AuthUser {
  try {
    const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    return { id: String(p.sub), tenantId: (p.tid as string | null) ?? null, role: p.role as Role };
  } catch {
    throw unauthorized('Sessão inválida ou expirada');
  }
}

function authCheck(roles: Role[], allowSuspended: boolean) {
  return async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice(7);
    const user = verifyToken(token);
    const row = await one<{ blocked: boolean; active: boolean | null; deleted_at: Date | null; password_changed_at: Date | null }>(
      `SELECT u.blocked, u.deleted_at, u.password_changed_at, t.active FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`,
      [user.id],
    );
    if (!row || row.deleted_at) throw unauthorized(row ? 'Esta conta foi excluída' : undefined);
    // trocou a senha: sessões abertas antes disso (em outro celular, por exemplo) deixam de valer
    const iat = (jwt.decode(token) as jwt.JwtPayload | null)?.iat ?? 0;
    if (row.password_changed_at && (iat + 1) * 1000 <= new Date(row.password_changed_at).getTime()) {
      throw unauthorized('A senha foi trocada. Entre de novo.');
    }
    if (row.blocked) throw forbidden('Conta bloqueada. Fale com o atendimento.');
    if (row.active === false && !allowSuspended) throw new HttpError(403, 'Este licenciado está suspenso.', 'licenciado_suspenso');
    if (roles.length && !roles.includes(user.role)) throw forbidden();
    req.auth = user;
  };
}

/** preHandler: exige login e, opcionalmente, um dos papéis informados */
export const requireAuth = (...roles: Role[]) => authCheck(roles, false);

/** Igual ao requireAuth, mas funciona com o licenciado suspenso (para ver e pagar as faturas) */
export const requireAuthEvenSuspended = (...roles: Role[]) => authCheck(roles, true);
