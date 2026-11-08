-- Daqui Entrega para lojas (conta loja, créditos, fatura semanal, cobrança do produto na entrega) e fotos.

-- ---------- conta: Prefeitura (pacientes) ou Loja (entregas) ----------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'prefeitura';
-- como a loja paga o frete: créditos pré-pagos ou fatura semanal (com limite)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS billing_mode text NOT NULL DEFAULT 'prepago';
-- saldo de créditos (pré-pago) ou valor em aberto, negativo (fatura)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance_cents integer NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_limit_cents integer NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS discount_pct numeric(5,2) NOT NULL DEFAULT 0;
-- endereço de coleta padrão da loja
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS logo_path text;
-- Pix da loja para o cliente pagar o produto na entrega (conferido pela central, antigolpe)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pix_key text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pix_holder_name text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pix_validated boolean NOT NULL DEFAULT false;
-- Mercado Pago da loja: gera o Pix com valor e confirma sozinho (criptografado com ENCRYPTION_KEY)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mp_access_token_enc text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mp_webhook_secret_enc text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mp_account_label text;
DO $$ BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('prefeitura', 'loja'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_billing_check CHECK (billing_mode IN ('prepago', 'fatura'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- extrato da loja: cada movimento guarda o saldo depois dele
CREATE TABLE IF NOT EXISTS account_ledger (
  id            bigserial PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('recarga', 'entrega', 'estorno', 'ajuste', 'pagamento_fatura')),
  amount_cents  integer NOT NULL,
  balance_after integer NOT NULL,
  ride_id       uuid REFERENCES rides(id) ON DELETE SET NULL,
  charge_id     uuid,
  note          text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_ledger_account ON account_ledger (account_id, created_at DESC);
-- uma entrega é debitada e estornada uma vez só
CREATE UNIQUE INDEX IF NOT EXISTS account_ledger_ride ON account_ledger (ride_id, kind) WHERE ride_id IS NOT NULL;

-- fatura semanal das lojas que pagam depois
CREATE TABLE IF NOT EXISTS store_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_start  date NOT NULL,                 -- segunda-feira
  period_end    date NOT NULL,                 -- domingo
  deliveries    integer NOT NULL,
  total_cents   integer NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  due_date      date NOT NULL,
  paid_at       timestamptz,
  paid_by       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, period_start)
);

-- recarga de créditos e fatura da loja pagas pelo Mercado Pago da central
ALTER TABLE charges ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE charges ADD COLUMN IF NOT EXISTS store_invoice_id uuid REFERENCES store_invoices(id) ON DELETE CASCADE;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_kind_check;
ALTER TABLE charges ADD CONSTRAINT charges_kind_check CHECK (kind IN ('mensalidade', 'fatura', 'recarga', 'fatura_loja'));
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_check;
ALTER TABLE charges ADD CONSTRAINT charges_check CHECK (
  (kind = 'mensalidade' AND driver_id IS NOT NULL) OR (kind = 'fatura' AND invoice_id IS NOT NULL)
  OR (kind = 'recarga' AND account_id IS NOT NULL) OR (kind = 'fatura_loja' AND store_invoice_id IS NOT NULL));

-- ---------- entrega da loja ----------
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_payment_method_check;
ALTER TABLE rides ADD CONSTRAINT rides_payment_method_check
  CHECK (payment_method IN ('pix', 'card', 'cash', 'convenio', 'conta_loja'));
-- entrega da loja não tem passageiro nem paciente: quem pede é a conta
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_who_check;
ALTER TABLE rides ADD CONSTRAINT rides_who_check CHECK (passenger_id IS NOT NULL OR patient_id IS NOT NULL OR account_id IS NOT NULL);

-- cobrança do produto na entrega, direto para a loja (o motoboy nunca carrega o dinheiro)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_amount_cents integer;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_method text;          -- pix_mp, pix_chave, maquininha
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_status text;          -- pendente, pago, aguardando_loja, confirmado, contestado
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_mp_payment_id text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_qr_code text;         -- Pix copia e cola gerado no Mercado Pago da loja
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_qr_base64 text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_paid_at timestamptz;
DO $$ BEGIN
  ALTER TABLE rides ADD CONSTRAINT rides_cod_method_check CHECK (cod_method IS NULL OR cod_method IN ('pix_mp', 'pix_chave', 'maquininha'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE rides ADD CONSTRAINT rides_cod_status_check
    CHECK (cod_status IS NULL OR cod_status IN ('pendente', 'pago', 'aguardando_loja', 'confirmado', 'contestado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS rides_cod_payment ON rides (cod_mp_payment_id) WHERE cod_mp_payment_id IS NOT NULL;

-- ---------- fotos ----------
-- foto do motorista e do veículo: o cliente só vê depois que a central aprova
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_path text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_photo_path text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_status text NOT NULL DEFAULT 'none';
DO $$ BEGIN
  ALTER TABLE drivers ADD CONSTRAINT drivers_photo_status_check CHECK (photo_status IN ('none', 'pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- comprovante na entrega (Entrega e Frete)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_photo_path text;
