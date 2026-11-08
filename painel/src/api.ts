export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';

export type Role = 'tenant_admin' | 'master' | 'account_operator';
export interface Session { token: string; role: Role; name: string; tenant?: string }

const KEY = 'ondaqui.painel.sessao';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* navegador sem armazenamento: a sessão dura até fechar a aba */
  }
}

let current: Session | null = loadSession();
let onExpired: () => void = () => {};

export function setSession(s: Session | null) { current = s; saveSession(s); }
export function getSession() { return current; }
export function onSessionExpired(fn: () => void) { onExpired = fn; }

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(API_URL + path, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(current ? { authorization: `Bearer ${current.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }).catch(() => {
    throw new ApiError(0, 'Sem conexão com o servidor do OnDaqui');
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && current) onExpired();
    throw new ApiError(res.status, data?.error ?? 'Erro inesperado', data?.code);
  }
  return data as T;
}

/** Baixa uma imagem protegida (ex.: selfie) e devolve um endereço local */
export async function apiImage(path: string): Promise<string> {
  const res = await fetch(API_URL + path, { headers: current ? { authorization: `Bearer ${current.token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'Imagem indisponível');
  return URL.createObjectURL(await res.blob());
}

/** Baixa um arquivo protegido (ex.: planilha do relatório) */
export async function apiDownload(path: string, filename: string) {
  const res = await fetch(API_URL + path, { headers: current ? { authorization: `Bearer ${current.token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'Não foi possível baixar o arquivo');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
