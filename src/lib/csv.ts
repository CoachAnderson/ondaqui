/** Planilha CSV para o Excel em português: separador ";", BOM e proteção contra fórmulas */
export function csvCell(v: unknown) {
  if (v instanceof Date) v = v.toISOString();
  const s = v == null ? '' : String(v);
  // texto que começa com = + - @ viraria fórmula ao abrir no Excel
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]) {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/** centavos → "12,34" */
export const reais = (cents: number | null | undefined) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ','));
/** data/hora no horário de Brasília */
export const quando = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
export const dia = (d: Date | string | null | undefined) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '');
export const simNao = (b: unknown) => (b ? 'sim' : 'não');
