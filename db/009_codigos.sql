-- Códigos por SMS ou WhatsApp: confirmar o celular no cadastro e recuperar a senha

CREATE TABLE IF NOT EXISTS phone_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('cadastro', 'senha')),
  code_hash   text NOT NULL,               -- nunca guarda o código em texto
  attempts    integer NOT NULL DEFAULT 0,  -- tentativas erradas
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_codes_lookup ON phone_codes (tenant_id, phone, purpose, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at   timestamptz;
-- sessões abertas antes da troca de senha deixam de valer
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
