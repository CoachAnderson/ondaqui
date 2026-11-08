-- Cashback: crédito para o passageiro usar nas próximas corridas.
--  • O licenciado devolve uma % de cada corrida (com teto por corrida e por mês).
--  • A loja dá um valor fixo por pedido entregue ao cliente dela (sai do saldo da loja).
-- O passageiro usa o saldo ao pedir e paga menos ao motorista. O motorista recebe o valor cheio:
-- a central abate a diferença da comissão da semana ou paga por Pix.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_pct numeric(4,2) NOT NULL DEFAULT 0
  CHECK (cashback_pct >= 0 AND cashback_pct <= 30);                       -- 0 = desligado
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_max_ride_cents integer NOT NULL DEFAULT 500 CHECK (cashback_max_ride_cents >= 0);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_max_month_cents integer NOT NULL DEFAULT 3000 CHECK (cashback_max_month_cents >= 0);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_days integer NOT NULL DEFAULT 90 CHECK (cashback_days BETWEEN 7 AND 365);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cashback_use_pct integer NOT NULL DEFAULT 50 CHECK (cashback_use_pct BETWEEN 10 AND 100);

-- quanto a loja dá ao cliente por pedido entregue (0 = não dá)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cashback_per_order_cents integer NOT NULL DEFAULT 0
  CHECK (cashback_per_order_cents >= 0 AND cashback_per_order_cents <= 5000);

-- extrato do cashback de cada passageiro (o saldo é a soma)
CREATE TABLE IF NOT EXISTS cashback_ledger (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  phone         text,          -- crédito da loja para quem ainda não tem o app: fica no celular até o cadastro
  kind          text NOT NULL CHECK (kind IN ('corrida', 'loja', 'uso', 'devolucao', 'expirado', 'ajuste')),
  amount_cents  integer NOT NULL CHECK (amount_cents <> 0),
  expires_at    timestamptz,   -- só nos créditos
  ride_id       uuid REFERENCES rides(id) ON DELETE SET NULL,
  account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,   -- loja que pagou
  note          text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS cashback_ledger_user ON cashback_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cashback_ledger_phone ON cashback_ledger (tenant_id, phone) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS cashback_ledger_tenant ON cashback_ledger (tenant_id, created_at DESC);
-- cada corrida gera, usa e devolve cashback uma vez só
CREATE UNIQUE INDEX IF NOT EXISTS cashback_ledger_ride ON cashback_ledger (ride_id, kind)
  WHERE ride_id IS NOT NULL AND kind IN ('corrida', 'loja', 'uso', 'devolucao');

ALTER TABLE rides ADD COLUMN IF NOT EXISTS cashback_used_cents integer NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cashback_earned_cents integer NOT NULL DEFAULT 0;

-- o que a central deve ao motorista pelo cashback usado nas corridas dele (fecha toda semana)
CREATE TABLE IF NOT EXISTS cashback_payouts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  rides                 integer NOT NULL,
  cashback_cents        integer NOT NULL CHECK (cashback_cents > 0), -- usado pelos passageiros
  offset_cents          integer NOT NULL DEFAULT 0,                  -- abatido da comissão da mesma semana
  amount_cents          integer NOT NULL CHECK (amount_cents >= 0),  -- a central paga ao motorista
  commission_invoice_id uuid REFERENCES commission_invoices(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'abatido')),
  paid_at               timestamptz,
  registered_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, period_start)
);
CREATE INDEX IF NOT EXISTS cashback_payouts_tenant ON cashback_payouts (tenant_id, status);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cashback_payout_id uuid REFERENCES cashback_payouts(id) ON DELETE SET NULL;

-- comissão abatida pelo cashback: a fatura pode zerar
ALTER TABLE commission_invoices ADD COLUMN IF NOT EXISTS cashback_offset_cents integer NOT NULL DEFAULT 0;
ALTER TABLE commission_invoices DROP CONSTRAINT IF EXISTS commission_invoices_amount_cents_check;
ALTER TABLE commission_invoices ADD CONSTRAINT commission_invoices_amount_cents_check CHECK (amount_cents >= 0);
ALTER TABLE commission_invoices DROP CONSTRAINT IF EXISTS commission_invoices_paid_by_check;
ALTER TABLE commission_invoices ADD CONSTRAINT commission_invoices_paid_by_check CHECK (paid_by IN ('mercadopago', 'central', 'cashback'));

-- o cashback da loja sai do saldo dela
ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_kind_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_kind_check
  CHECK (kind IN ('recarga', 'entrega', 'estorno', 'ajuste', 'pagamento_fatura', 'cashback'));
