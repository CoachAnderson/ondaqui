/** Valores definidos no momento do build (veja app.config.ts e .env.example) */
export const VARIANT: 'passageiro' | 'motorista' =
  process.env.EXPO_PUBLIC_VARIANT === 'motorista' ? 'motorista' : 'passageiro';

/** Cidade fixa do app. Vazio = o usuário escolhe a cidade no login. */
export const FIXED_TENANT = (process.env.EXPO_PUBLIC_TENANT ?? '').trim();

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3333').replace(/\/$/, '');

/** Endereço público do painel, onde fica a página de acompanhamento da corrida */
export const SHARE_BASE_URL = (process.env.EXPO_PUBLIC_SHARE_URL ?? 'http://localhost:5173').replace(/\/$/, '');

/** Intervalo mínimo entre envios de localização do motorista */
export const LOCATION_INTERVAL_MS = 5000;

/** Tempo que a oferta de corrida fica na tela do motorista */
export const OFFER_SECONDS = 25;
