-- Traçado da rota (polyline do OSRM, precisão 5) para desenhar no mapa
ALTER TABLE rides ADD COLUMN IF NOT EXISTS route_polyline text;

-- Aviso automático ao motorista com nota baixa (termos do motorista, cláusula 6.2)
CREATE TABLE IF NOT EXISTS driver_rating_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  average         numeric(3,2) NOT NULL,
  ratings         integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz              -- o motorista leu o aviso no app
);
CREATE INDEX IF NOT EXISTS driver_rating_alerts_driver ON driver_rating_alerts (driver_id, created_at DESC);
