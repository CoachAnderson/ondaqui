-- Anúncios de comércios da cidade, vendidos pelo licenciado. Sem rastrear quem viu:
-- só contagem por dia (vezes que apareceu e que foi tocado).
CREATE TABLE IF NOT EXISTS ads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  advertiser   text NOT NULL,                       -- quem anuncia (aparece no anúncio)
  title        text NOT NULL,
  body         text,
  cta_label    text,                                -- texto do botão ("Ver cardápio")
  link         text,                                -- https:// (site, WhatsApp wa.me, Instagram)
  image_path   text,
  placements   text[] NOT NULL DEFAULT '{inicio}',  -- inicio | corrida | motorista
  starts_on    date NOT NULL DEFAULT current_date,
  ends_on      date,
  weight       integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10),
  price_cents  integer CHECK (price_cents IS NULL OR price_cents >= 0),  -- quanto o licenciado cobrou (para o relatório)
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (placements <@ ARRAY['inicio', 'corrida', 'motorista']::text[] AND cardinality(placements) > 0),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS ads_tenant ON ads (tenant_id, active);

CREATE TABLE IF NOT EXISTS ad_stats (
  ad_id        uuid NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  day          date NOT NULL,
  placement    text NOT NULL,
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_id, day, placement)
);

-- Preferências da viagem: o passageiro escolhe; o motorista vê na corrida.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trip_prefs jsonb NOT NULL DEFAULT '{}';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS trip_prefs jsonb;
-- na avaliação: o motorista respeitou as preferências?
ALTER TABLE rides ADD COLUMN IF NOT EXISTS prefs_respected boolean;
