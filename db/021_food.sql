-- Daqui Food: restaurantes com cardápio no app, pedido pago direto ao restaurante (Pix do Mercado Pago dele
-- pelo app, ou na entrega) e entrega pelos motoboys da central: rotativo ou entregador fixo por turno.

-- ---------- regras da cidade ----------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS food_enabled boolean NOT NULL DEFAULT false;
-- comissão da central sobre o valor da comida de cada pedido entregue (cobrada do restaurante)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS food_commission_pct numeric(4,2) NOT NULL DEFAULT 10
  CHECK (food_commission_pct BETWEEN 0 AND 50);
-- entregador fixo: valor por hora que o restaurante paga e quanto a central fica
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS food_shift_hour_cents integer NOT NULL DEFAULT 2000 CHECK (food_shift_hour_cents >= 0);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS food_shift_commission_pct numeric(4,2) NOT NULL DEFAULT 10
  CHECK (food_shift_commission_pct BETWEEN 0 AND 50);

-- ---------- restaurante = loja com o Daqui Food ligado pela central ----------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_open boolean NOT NULL DEFAULT true;          -- "pausar pedidos" agora
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_category text;                             -- Pizzaria, Lanches, Japonesa...
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_description text;
-- horários por dia da semana (0 = domingo): [[["11:00","15:00"],["18:00","23:30"]], ...]; fechar depois da meia-noite: "18:00"-"02:00"
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_hours jsonb NOT NULL DEFAULT '[[],[],[],[],[],[],[]]';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_prep_min integer NOT NULL DEFAULT 30 CHECK (food_prep_min BETWEEN 5 AND 180);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_min_order_cents integer NOT NULL DEFAULT 0 CHECK (food_min_order_cents >= 0);
-- taxa de entrega: o cliente paga o frete (padrão) ou o restaurante oferece entrega grátis
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_free_delivery boolean NOT NULL DEFAULT false;
-- formas de pagamento: Pix pelo app (precisa do Mercado Pago do restaurante) e/ou na entrega
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_pay_app boolean NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_pay_delivery boolean NOT NULL DEFAULT true;
-- comissão própria deste restaurante (vazio = a da cidade)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS food_commission_pct numeric(4,2) CHECK (food_commission_pct IS NULL OR food_commission_pct BETWEEN 0 AND 50);

-- ---------- cardápio ----------
CREATE TABLE IF NOT EXISTS menu_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort        integer NOT NULL DEFAULT 100
);
CREATE INDEX IF NOT EXISTS menu_categories_account ON menu_categories (account_id, sort);

CREATE TABLE IF NOT EXISTS menu_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id  uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  name         text NOT NULL,
  description  text,
  price_cents  integer NOT NULL CHECK (price_cents > 0),
  photo_path   text,
  available    boolean NOT NULL DEFAULT true,   -- "acabou" por hoje
  sort         integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS menu_items_account ON menu_items (account_id, sort);

-- ---------- entregador fixo por turno ----------
CREATE TABLE IF NOT EXISTS food_shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  driver_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  hours         integer NOT NULL CHECK (hours BETWEEN 1 AND 12),
  price_cents   integer NOT NULL,                -- o restaurante paga (créditos ou fatura)
  driver_cents  integer NOT NULL,                -- o entregador recebe da central
  status        text NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado', 'confirmado', 'concluido', 'cancelado')),
  deliveries    integer NOT NULL DEFAULT 0,
  driver_paid_at timestamptz,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS food_shifts_active ON food_shifts (account_id, starts_at) WHERE status = 'confirmado';
CREATE INDEX IF NOT EXISTS food_shifts_driver ON food_shifts (driver_id, starts_at);

-- ---------- pedidos ----------
CREATE TABLE IF NOT EXISTS food_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigserial,                  -- "Pedido 1042" para falar com o cliente
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  customer_name      text,
  customer_phone     text,
  items              jsonb NOT NULL,             -- [{itemId, name, qty, priceCents, notes}] copiados no momento do pedido
  subtotal_cents     integer NOT NULL,
  delivery_fee_cents integer NOT NULL,           -- o que o cliente paga de entrega (0 = grátis)
  freight_cents      integer NOT NULL,           -- frete da central, pago pelo restaurante
  total_cents        integer NOT NULL,
  payment            text NOT NULL CHECK (payment IN ('app', 'entrega')),
  pay_status         text NOT NULL CHECK (pay_status IN ('pendente', 'pago', 'na_entrega', 'estornado', 'expirado')),
  mp_payment_id      text,
  pix_qr_code        text,
  pix_qr_base64      text,
  status             text NOT NULL CHECK (status IN ('aguardando_pagamento', 'novo', 'aceito', 'pronto', 'em_entrega', 'entregue', 'recusado', 'cancelado')),
  prep_min           integer,
  dest_lat           double precision NOT NULL,
  dest_lng           double precision NOT NULL,
  dest_address       text NOT NULL,
  notes              text,
  ride_id            uuid REFERENCES rides(id) ON DELETE SET NULL,
  commission_cents   integer,
  refuse_reason      text,
  cancelled_by       text CHECK (cancelled_by IS NULL OR cancelled_by IN ('cliente', 'restaurante', 'sistema', 'central')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz,
  accepted_at        timestamptz,
  ready_at           timestamptz,
  delivered_at       timestamptz,
  cancelled_at       timestamptz
);
CREATE INDEX IF NOT EXISTS food_orders_account ON food_orders (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS food_orders_customer ON food_orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS food_orders_payment ON food_orders (mp_payment_id) WHERE mp_payment_id IS NOT NULL;

-- a entrega do pedido e o turno do entregador fixo
ALTER TABLE rides ADD COLUMN IF NOT EXISTS food_order_id uuid REFERENCES food_orders(id) ON DELETE SET NULL;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES food_shifts(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rides_food_order_active ON rides (food_order_id)
  WHERE food_order_id IS NOT NULL AND status IN ('scheduled', 'requested', 'accepted', 'arrived', 'in_progress', 'completed');

-- extrato do restaurante: comissão do pedido e turno do entregador fixo
ALTER TABLE account_ledger DROP CONSTRAINT IF EXISTS account_ledger_kind_check;
ALTER TABLE account_ledger ADD CONSTRAINT account_ledger_kind_check
  CHECK (kind IN ('recarga', 'entrega', 'estorno', 'ajuste', 'pagamento_fatura', 'cashback', 'comissao', 'turno'));
ALTER TABLE account_ledger ADD COLUMN IF NOT EXISTS food_order_id uuid REFERENCES food_orders(id) ON DELETE SET NULL;
ALTER TABLE account_ledger ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES food_shifts(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_ledger_food_commission ON account_ledger (food_order_id) WHERE kind = 'comissao';
CREATE UNIQUE INDEX IF NOT EXISTS account_ledger_shift ON account_ledger (shift_id, kind) WHERE shift_id IS NOT NULL;
