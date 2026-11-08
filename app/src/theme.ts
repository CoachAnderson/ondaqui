import { createContext, useContext } from 'react';
import type { Brand } from './types';

export const colors = {
  noite: '#12263A',
  noite2: '#1C3550',
  areia: '#FFF6EC',
  areia2: '#F3ECE2',
  linha: '#E3D6C6',
  texto: '#12263A',
  texto2: '#4A5A6A',
  branco: '#FFFFFF',
  verde: '#1F8A5B',
  verdeClaro: '#E3F4EC',
  vermelho: '#C0362C',
  vermelhoClaro: '#FBE6E4',
  amareloClaro: '#FDF0DC',
  amarelo: '#8A5A12',
};

/** Laranja da marca e um tom mais escuro, com contraste para texto branco em botões */
export function accentFor(hex: string | undefined) {
  const base = /^#[0-9a-f]{6}$/i.test(hex ?? '') ? hex! : '#F2622E';
  const n = parseInt(base.slice(1), 16);
  const f = 0.72;
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  const dark = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  return { accent: base, accentDark: dark };
}

export const BrandContext = createContext<{ brand: Brand | null; accent: string; accentDark: string }>({
  brand: null, ...accentFor(undefined),
});
export const useBrand = () => useContext(BrandContext);

export const radius = 14;
