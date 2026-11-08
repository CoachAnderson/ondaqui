-- Comissão do plano Livre nas corridas pagas direto ao motorista (dinheiro, Pix, maquininha):
-- fecha toda semana numa fatura que o motorista paga pelo app (Mercado Pago da cidade) ou na central.

CREATE TABLE IF NOT EXISTS commission_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  rides         integer NOT NULL,
  gross_cents   integer NOT NULL,                       -- soma das corridas
  amount_cents  integer NOT NULL CHECK (amount_cents > 0), -- comissão devida
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  paid_at       timestamptz,
  paid_by       text CHECK (paid_by IN ('mercadopago', 'central')),
  registered_by uuid REFERENCES users(id) ON DELETE SET NULL,  -- quem da central registrou ou cancelou
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, period_start)
);
CREATE INDEX IF NOT EXISTS commission_invoices_tenant ON commission_invoices (tenant_id, status, due_date);

-- cada corrida entra numa fatura só uma vez
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_invoice_id uuid REFERENCES commission_invoices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS rides_commission_open ON rides (driver_id)
  WHERE commission_invoice_id IS NULL AND commission_cents > 0 AND status = 'completed';

-- pagamento da comissão pelo Mercado Pago da cidade
ALTER TABLE charges ADD COLUMN IF NOT EXISTS commission_invoice_id uuid REFERENCES commission_invoices(id) ON DELETE CASCADE;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_kind_check;
ALTER TABLE charges ADD CONSTRAINT charges_kind_check CHECK (kind IN ('mensalidade', 'fatura', 'recarga', 'fatura_loja', 'comissao'));
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_check;
ALTER TABLE charges ADD CONSTRAINT charges_check CHECK (
  (kind = 'mensalidade' AND driver_id IS NOT NULL) OR (kind = 'fatura' AND invoice_id IS NOT NULL)
  OR (kind = 'recarga' AND account_id IS NOT NULL) OR (kind = 'fatura_loja' AND store_invoice_id IS NOT NULL)
  OR (kind = 'comissao' AND commission_invoice_id IS NOT NULL AND driver_id IS NOT NULL));
