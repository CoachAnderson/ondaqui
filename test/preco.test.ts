import { describe, expect, it } from 'vitest';
import { commissionFor, quotePrice } from '../src/lib/pricing.js';
import { estimateTrip, haversineKm } from '../src/lib/geo.js';

const carro = { base_fare_cents: 400, per_km_cents: 180, per_min_cents: 30, min_fare_cents: 900 };

describe('preço', () => {
  it('aplica a tarifa mínima em corridas curtas', () => {
    expect(quotePrice(carro, 0.5, 2, 1, 1.5).priceCents).toBe(900);
  });

  it('calcula bandeirada + km + minuto, arredondado em 10 centavos', () => {
    // 400 + 180*5 + 30*12 = 1660
    expect(quotePrice(carro, 5, 12, 1, 1.5).priceCents).toBe(1660);
  });

  it('nunca passa do teto da tarifa dinâmica', () => {
    const r = quotePrice(carro, 5, 12, 3, 1.5);
    expect(r.surge).toBe(1.5);
    expect(r.priceCents).toBe(2490);
  });

  it('comissão de 10% no plano Livre e zero nos planos com mensalidade', () => {
    expect(commissionFor(2000, 10)).toBe(200);
    expect(commissionFor(2000, 0)).toBe(0);
  });
});

describe('distância', () => {
  it('Bauru → Marília dá cerca de 100 km em linha reta', () => {
    const km = haversineKm({ lat: -22.3246, lng: -49.0871 }, { lat: -22.2171, lng: -49.9501 });
    expect(km).toBeGreaterThan(85);
    expect(km).toBeLessThan(95);
  });

  it('estimativa de trajeto tem mínimo de 2 minutos', () => {
    expect(estimateTrip({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }).durationMin).toBe(2);
  });
});
