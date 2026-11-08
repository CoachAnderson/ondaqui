-- Cobranças pelo Mercado Pago (Checkout Pro)
--  • mensalidade do motorista → conta Mercado Pago do licenciado
--  • fatura mensal do licenciado → conta Mercado Pago da plataforma

-- credenciais do Mercado Pago do licenciado (criptografadas com ENCRYPTION_KEY)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_access_token_enc  text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_webhook_secret_enc text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_account_label     text;   -- apelido da conta, para conferência
-- licença mensal que o licenciado paga à plataforma
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS license_monthly_cents integer NOT NULL DEFAULT 0;
-- motivo da suspensão: 'manual' (master) ou 'inadimplencia' (fatura em atraso)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_reason text;

-- fatura mensal do licenciado
CREATE TABLE IF NOT EXISTS invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period            date NOT NULL,                  -- primeiro dia do mês cobrado
  license_cents     integer NOT NULL,
  rides_count       integer NOT NULL,
  ride_fee_cents    integer NOT NULL,
  total_cents       integer NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  due_date          date NOT NULL,
  paid_at           timestamptz,
  paid_by           text,                           -- 'mercadopago' ou 'manual'
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

-- cada tentativa de pagamento (uma preferência do Checkout Pro)
CREATE TABLE IF NOT EXISTS charges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- vai como external_reference
  kind              text NOT NULL CHECK (kind IN ('mensalidade', 'fatura')),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  invoice_id        uuid REFERENCES invoices(id) ON DELETE CASCADE,
  plan_code         text,
  periods           integer NOT NULL DEFAULT 1,
  amount_cents      integer NOT NULL CHECK (amount_cents > 0),
  description       text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'expired')),
  mp_preference_id  text,
  mp_payment_id     text,
  init_point        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  CHECK ((kind = 'mensalidade' AND driver_id IS NOT NULL) OR (kind = 'fatura' AND invoice_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS charges_driver ON charges (driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS charges_invoice ON charges (invoice_id);
-- o mesmo pagamento do Mercado Pago nunca é aplicado duas vezes
CREATE UNIQUE INDEX IF NOT EXISTS charges_mp_payment ON charges (mp_payment_id) WHERE mp_payment_id IS NOT NULL;

-- avisos de vencimento já enviados (para não repetir)
CREATE TABLE IF NOT EXISTS billing_reminders (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  ref_date  date NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, ref_date)
);

-- registro das notificações recebidas do Mercado Pago (auditoria)
CREATE TABLE IF NOT EXISTS mp_notifications (
  id          bigserial PRIMARY KEY,
  account     text NOT NULL,            -- 'plataforma' ou o endereço da cidade
  topic       text,
  data_id     text,
  result      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
