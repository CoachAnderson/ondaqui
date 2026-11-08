-- Política de privacidade por cidade (LGPD), aceite no cadastro e exclusão de conta pelo app

-- dados da empresa do licenciado (controlador dos dados), mostrados na política pública
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_name         text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cnpj               text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_address      text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_email      text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_whatsapp   text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dpo_name           text;   -- encarregado
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dpo_email          text;
-- versão da política: quando muda, quem aceitou a anterior aceita de novo no app
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS privacy_version    integer NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS privacy_updated_on date    NOT NULL DEFAULT current_date;

ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_version     integer;      -- versão aceita
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at          timestamptz;  -- conta excluída pelo titular
