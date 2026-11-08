import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

/** O "O" do OnDaqui é o símbolo de ligar */
export function PowerO({ size = 24, color = '#F2622E' }: { size?: number; color?: string }) {
  return (
    <svg width={size * 0.93} height={size} viewBox="1.8 0.8 20.4 22" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M7.2 5.4a8.6 8.6 0 1 0 9.6 0" fill="none" stroke={color} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M12 2.4v9" stroke={color} strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

/** Logo: ⏻nDaqui — "On" no laranja da marca, "Daqui" na cor do texto */
export function Wordmark({ size = 32, color = '#FFF6EC' }: { size?: number; color?: string }) {
  return (
    <span role="img" aria-label="OnDaqui" style={{
      display: 'inline-flex', alignItems: 'baseline', fontFamily: "'Baloo 2', sans-serif", fontWeight: 800,
      fontSize: size, lineHeight: 1, letterSpacing: '-0.02em', color,
    }}>
      <PowerO size={size * 0.7} />
      <span style={{ color: '#F2622E', marginLeft: size * 0.02 }}>n</span>
      <span>Daqui</span>
    </span>
  );
}

/** Ícone: o pin de localização com o símbolo de ligar dentro */
export function Pin({ size = 28, inner = '#12263A' }: { size?: number; inner?: string }) {
  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 48 60" aria-hidden="true">
      <path d="M24 2C12.4 2 3 11.2 3 22.6 3 38 24 58 24 58s21-20 21-35.4C45 11.2 35.6 2 24 2z" fill="#F2622E" />
      <path d="M19 15.6a8.6 8.6 0 1 0 10 0" fill="none" stroke={inner} strokeWidth="3.6" strokeLinecap="round" />
      <path d="M24 12v9" stroke={inner} strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  );
}

/** Carrega dados da API e permite recarregar */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Erro({ msg }: { msg: string | null }) {
  return msg ? <div className="aviso erro" role="alert">{msg}</div> : null;
}

export function Status({ tone, children }: { tone: 'ok' | 'alerta' | 'ruim' | 'neutra'; children: React.ReactNode }) {
  return <span className={`etiqueta ${tone}`}>{children}</span>;
}

export const rideTone = (s: string) =>
  s === 'completed' ? 'ok' : s === 'cancelled' ? 'ruim' : s === 'requested' ? 'alerta' : 'neutra';

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo deu errado. Tente de novo.');
