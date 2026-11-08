-- De onde veio a distância da corrida: 'rota' (ruas, pelo OSRM) ou 'estimativa' (linha reta × 1,3)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_source text NOT NULL DEFAULT 'estimativa';
