-- Daqui Escola: transporte escolar contratado pelos pais, com motorista fixo liberado pela central.
-- Mensalidade paga pelo app (Mercado Pago da cidade) ou registrada na central; a central repassa ao motorista.
-- Todo dia de aula o sistema monta as viagens (ida e/ou volta); o motorista marca embarque e chegada e os pais acompanham.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS escola_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS escola_base_cents integer NOT NULL DEFAULT 15000 CHECK (escola_base_cents >= 0);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS escola_per_km_cents integer NOT NULL DEFAULT 3000 CHECK (escola_per_km_cents >= 0);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS escola_commission_pct numeric(4,2) NOT NULL DEFAULT 10
  CHECK (escola_commission_pct >= 0 AND escola_commission_pct <= 50);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS escola_grace_days integer NOT NULL DEFAULT 5 CHECK (escola_grace_days BETWEEN 0 AND 30);

-- escolas atendidas, cadastradas pela central
CREATE TABLE IF NOT EXISTS schools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  address     text NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schools_tenant ON schools (tenant_id, active);

-- contrato: um aluno, uma escola, um motorista
CREATE TABLE IF NOT EXISTS school_contracts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_name   text NOT NULL,
  grade          text,                                    -- série/turma (opcional)
  school_id      uuid NOT NULL REFERENCES schools(id),
  driver_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  home_address   text NOT NULL,
  home_lat       double precision NOT NULL,
  home_lng       double precision NOT NULL,
  legs           text NOT NULL CHECK (legs IN ('ida', 'volta', 'ida_volta')),
  weekdays       integer[] NOT NULL,                     -- 1 = segunda ... 5 = sexta (6 = sábado)
  pickup_time    time,                                   -- ida: saída de casa
  return_time    time,                                   -- volta: saída da escola
  distance_km    numeric(6,2) NOT NULL,
  monthly_cents  integer NOT NULL CHECK (monthly_cents > 0),
  notes          text,                                   -- para o motorista (ex.: entregar só para a avó)
  status         text NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado', 'ativo', 'pausado', 'encerrado', 'recusado')),
  paid_until     date,
  consent_at     timestamptz NOT NULL,                   -- consentimento dos pais para os dados da criança (LGPD, art. 14)
  admin_note     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  ended_at       timestamptz,
  CHECK (weekdays <@ ARRAY[1,2,3,4,5,6] AND cardinality(weekdays) > 0),
  CHECK ((legs = 'volta' OR pickup_time IS NOT NULL) AND (legs = 'ida' OR return_time IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS school_contracts_tenant ON school_contracts (tenant_id, status);
CREATE INDEX IF NOT EXISTS school_contracts_parent ON school_contracts (parent_id);
CREATE INDEX IF NOT EXISTS school_contracts_driver ON school_contracts (driver_id, status);

-- viagens de cada dia de aula
CREATE TABLE IF NOT EXISTS school_trips (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id    uuid NOT NULL REFERENCES school_contracts(id) ON DELETE CASCADE,
  driver_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  day            date NOT NULL,
  leg            text NOT NULL CHECK (leg IN ('ida', 'volta')),
  scheduled_time time NOT NULL,
  status         text NOT NULL DEFAULT 'previsto' CHECK (status IN ('previsto', 'embarcou', 'entregue', 'ausente', 'cancelado')),
  boarded_at     timestamptz,
  delivered_at   timestamptz,
  absent_by      text CHECK (absent_by IN ('pais', 'motorista')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, day, leg)
);
CREATE INDEX IF NOT EXISTS school_trips_driver_day ON school_trips (driver_id, day);
CREATE INDEX IF NOT EXISTS school_trips_tenant_day ON school_trips (tenant_id, day);

-- feriados, férias e recessos: não há viagem
CREATE TABLE IF NOT EXISTS school_days_off (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day        date NOT NULL,
  note       text,
  PRIMARY KEY (tenant_id, day)
);

-- mensalidades recebidas (Mercado Pago ou registradas na central)
CREATE TABLE IF NOT EXISTS school_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id    uuid NOT NULL REFERENCES school_contracts(id) ON DELETE CASCADE,
  driver_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  amount_cents   integer NOT NULL CHECK (amount_cents > 0),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  charge_id      uuid,
  registered_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS school_payments_tenant ON school_payments (tenant_id, created_at);

-- repasse mensal ao motorista (a central paga por Pix e dá baixa)
CREATE TABLE IF NOT EXISTS school_payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  driver_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month          date NOT NULL,                   -- primeiro dia do mês
  received_cents integer NOT NULL,
  commission_cents integer NOT NULL,
  amount_cents   integer NOT NULL,
  paid_at        timestamptz NOT NULL DEFAULT now(),
  registered_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (driver_id, month)
);

-- mensalidade pelo app
ALTER TABLE charges ADD COLUMN IF NOT EXISTS school_contract_id uuid REFERENCES school_contracts(id) ON DELETE CASCADE;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_kind_check;
ALTER TABLE charges ADD CONSTRAINT charges_kind_check
  CHECK (kind IN ('mensalidade', 'fatura', 'recarga', 'fatura_loja', 'comissao', 'clube', 'escola'));
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_check;
ALTER TABLE charges ADD CONSTRAINT charges_check CHECK (
  (kind = 'mensalidade' AND driver_id IS NOT NULL) OR (kind = 'fatura' AND invoice_id IS NOT NULL)
  OR (kind = 'recarga' AND account_id IS NOT NULL) OR (kind = 'fatura_loja' AND store_invoice_id IS NOT NULL)
  OR (kind = 'comissao' AND commission_invoice_id IS NOT NULL AND driver_id IS NOT NULL)
  OR (kind = 'clube' AND passenger_id IS NOT NULL)
  OR (kind = 'escola' AND school_contract_id IS NOT NULL AND passenger_id IS NOT NULL));
