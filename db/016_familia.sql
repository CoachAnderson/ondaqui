-- Modo família: o titular cadastra parentes, pede corrida para eles e acompanha.
-- O parente não precisa ter o app: recebe por SMS o código de embarque e o link de acompanhamento.
CREATE TABLE IF NOT EXISTS family_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                text NOT NULL,
  phone               text NOT NULL,
  relation            text NOT NULL,                 -- filho, mãe, pai, avó...
  declared_woman      boolean NOT NULL DEFAULT false, -- pode usar o Daqui Mulher
  monthly_limit_cents integer CHECK (monthly_limit_cents IS NULL OR monthly_limit_cents > 0),
  notes               text,                          -- aparece para o motorista (ex.: precisa de ajuda para entrar)
  -- onde buscar da última vez (o app sugere de novo)
  pickup_address      text,
  pickup_lat          double precision,
  pickup_lng          double precision,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, phone)
);

ALTER TABLE rides ADD COLUMN IF NOT EXISTS family_member_id uuid REFERENCES family_members(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS rides_family_member ON rides (family_member_id, requested_at);

-- o titular pode ter a própria corrida e, ao mesmo tempo, uma corrida para cada parente
DROP INDEX IF EXISTS rides_one_active_passenger;
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_passenger ON rides (passenger_id)
  WHERE status IN ('requested','accepted','arrived','in_progress') AND family_member_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_family ON rides (family_member_id)
  WHERE status IN ('requested','accepted','arrived','in_progress') AND family_member_id IS NOT NULL;
