export interface Category {
  base_fare_cents: number;
  per_km_cents: number;
  per_min_cents: number;
  min_fare_cents: number;
  kind?: string;
  per_hour_cents?: number;
  extra_fee_cents?: number;
}

/**
 * Preço fechado da corrida. A tarifa dinâmica nunca passa do teto do
 * licenciado (regra de "preço justo"). Arredonda para múltiplos de 10 centavos.
 */
export function quotePrice(cat: Category, distanceKm: number, durationMin: number, surge: number, surgeCap: number) {
  const s = Math.min(Math.max(1, surge), surgeCap);
  const raw = (cat.base_fare_cents + cat.per_km_cents * distanceKm + cat.per_min_cents * durationMin) * s;
  const price = Math.max(cat.min_fare_cents, Math.round(raw / 10) * 10);
  return { priceCents: price, surge: s };
}

export interface ServiceOptions {
  hours?: number;     // Particular
  helpers?: number;   // Frete
  scheduled?: boolean; // agendada: sem tarifa dinâmica
}

/**
 * Preço de qualquer serviço:
 *  • Particular: valor por hora × horas (mínimo da categoria), sem dinâmica
 *  • Frete: corrida + ajudantes × taxa por ajudante
 *  • Pet: corrida + taxa do pet
 *  • Paciente (convênio): tabela da categoria, sem dinâmica
 *  • Agendada: sem dinâmica (o preço é combinado na hora de agendar)
 */
export function quoteService(cat: Category, distanceKm: number, durationMin: number, surge: number, surgeCap: number, o: ServiceOptions = {}) {
  const kind = cat.kind ?? 'corrida';
  const extra = cat.extra_fee_cents ?? 0;
  if (kind === 'particular') {
    const hours = Math.max(1, o.hours ?? 2);
    const price = Math.max(cat.min_fare_cents, (cat.per_hour_cents ?? 0) * hours);
    return { priceCents: price, surge: 1, extraCents: 0 };
  }
  const noSurge = o.scheduled || kind === 'paciente';
  const base = quotePrice(cat, distanceKm, durationMin, noSurge ? 1 : surge, surgeCap);
  const extraCents = kind === 'frete' ? extra * Math.max(0, o.helpers ?? 0) : extra;
  return { priceCents: base.priceCents + extraCents, surge: base.surge, extraCents };
}

/** Comissão do licenciado: só existe no plano sem mensalidade (ex.: "livre", 10%). */
export function commissionFor(priceCents: number, commissionPct: number) {
  return Math.round((priceCents * commissionPct) / 100);
}
