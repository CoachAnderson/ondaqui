-- Clube do passageiro: assinatura mensal paga pelo app (Mercado Pago da cidade), sem renovação automática.
-- Benefícios que o licenciado liga: desconto nas corridas, sem tarifa dinâmica, cashback multiplicado e prioridade no despacho.
-- O motorista recebe o valor cheio: o desconto do Clube entra no acerto da semana, junto com o cashback usado.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_name text NOT NULL DEFAULT 'Clube';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_price_cents integer NOT NULL DEFAULT 1990 CHECK (club_price_cents >= 100);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_discount_pct numeric(4,2) NOT NULL DEFAULT 10
  CHECK (club_discount_pct >= 0 AND club_discount_pct <= 30);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_discount_max_cents integer NOT NULL DEFAULT 500 CHECK (club_discount_max_cents >= 0);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_no_surge boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_cashback_multiplier integer NOT NULL DEFAULT 2 CHECK (club_cashback_multiplier BETWEEN 1 AND 3);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS club_priority boolean NOT NULL DEFAULT true;

-- assinante até esta data (inclusive)
ALTER TABLE users ADD COLUMN IF NOT EXISTS club_until date;

-- cada mês pago (ou dado de cortesia pela central)
CREATE TABLE IF NOT EXISTS club_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),   -- 0 = cortesia
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  charge_id     uuid,
  registered_by uuid REFERENCES users(id) ON DELETE SET NULL,  -- quem da central lançou (vazio = Mercado Pago)
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_payments_tenant ON club_payments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS club_payments_user ON club_payments (user_id, created_at DESC);

-- desconto do Clube em cada corrida (desconto + dinâmica que o assinante não pagou)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS club_discount_cents integer NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS club_member boolean NOT NULL DEFAULT false;

-- assinatura paga pelo app
ALTER TABLE charges ADD COLUMN IF NOT EXISTS passenger_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS charges_passenger ON charges (passenger_id, created_at DESC) WHERE passenger_id IS NOT NULL;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_kind_check;
ALTER TABLE charges ADD CONSTRAINT charges_kind_check CHECK (kind IN ('mensalidade', 'fatura', 'recarga', 'fatura_loja', 'comissao', 'clube'));
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_check;
ALTER TABLE charges ADD CONSTRAINT charges_check CHECK (
  (kind = 'mensalidade' AND driver_id IS NOT NULL) OR (kind = 'fatura' AND invoice_id IS NOT NULL)
  OR (kind = 'recarga' AND account_id IS NOT NULL) OR (kind = 'fatura_loja' AND store_invoice_id IS NOT NULL)
  OR (kind = 'comissao' AND commission_invoice_id IS NOT NULL AND driver_id IS NOT NULL)
  OR (kind = 'clube' AND passenger_id IS NOT NULL));
