import { API_URL } from './config';
import type { Place } from './types';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let token: string | null = null;
let onExpired: () => void = () => {};

export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;
export const onSessionExpired = (fn: () => void) => { onExpired = fn; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Sem conexão. Verifique sua internet.');
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* resposta não JSON */ }
  if (!res.ok) {
    if (res.status === 401 && token) onExpired();
    throw new ApiError(res.status, data?.error ?? 'Algo deu errado. Tente de novo.', data?.code);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Algo deu errado. Tente de novo.');

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export const placeBody = (p: Place) => ({ lat: p.lat, lng: p.lng, address: p.address });
