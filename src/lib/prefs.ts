import { z } from 'zod';

/**
 * Preferências da viagem: o passageiro escolhe no perfil (ou só para uma corrida) e o motorista vê na tela da corrida.
 * A música toca no rádio do próprio motorista: o app não transmite música (sem licença de execução pública).
 */
export const MUSIC = {
  tanto_faz: 'Tanto faz', silencio: 'Sem música', sertanejo: 'Sertanejo', pop: 'Pop', rock: 'Rock', mpb: 'MPB',
  gospel: 'Gospel', funk: 'Funk', pagode: 'Pagode e samba', rap: 'Rap e hip-hop', eletronica: 'Eletrônica', classica: 'Clássica',
} as const;
export const TALK = { tanto_faz: 'Tanto faz', conversar: 'Gosto de conversar', silencio: 'Prefiro silêncio' } as const;
export const AC = { tanto_faz: 'Tanto faz', ligado: 'Ar ligado', desligado: 'Ar desligado, janela aberta' } as const;

const keys = <T extends Record<string, string>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

export const tripPrefsSchema = z.object({
  music: z.enum(keys(MUSIC)).default('tanto_faz'),
  talk: z.enum(keys(TALK)).default('tanto_faz'),
  ac: z.enum(keys(AC)).default('tanto_faz'),
});
export type TripPrefs = z.infer<typeof tripPrefsSchema>;

/** Só o que o passageiro de fato pediu ("tanto faz" não aparece) */
export function prefsSummary(p: Partial<TripPrefs> | null | undefined) {
  if (!p) return [];
  const out: string[] = [];
  if (p.music && p.music !== 'tanto_faz') out.push(p.music === 'silencio' ? 'Sem música' : `Música: ${MUSIC[p.music]}`);
  if (p.talk && p.talk !== 'tanto_faz') out.push(TALK[p.talk]);
  if (p.ac && p.ac !== 'tanto_faz') out.push(AC[p.ac]);
  return out;
}

/** Normaliza o que veio do banco (preferências antigas ou vazias) */
export function readPrefs(raw: unknown): TripPrefs {
  const r = tripPrefsSchema.safeParse(raw ?? {});
  return r.success ? r.data : { music: 'tanto_faz', talk: 'tanto_faz', ac: 'tanto_faz' };
}

export const hasPrefs = (p: TripPrefs) => prefsSummary(p).length > 0;

export const PREF_OPTIONS = {
  music: Object.entries(MUSIC).map(([value, label]) => ({ value, label })),
  talk: Object.entries(TALK).map(([value, label]) => ({ value, label })),
  ac: Object.entries(AC).map(([value, label]) => ({ value, label })),
};
