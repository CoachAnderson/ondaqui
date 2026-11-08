-- Serviços do OnDaqui: Car, Moto, Executivo, Mulher, Pet, Entrega, Particular (por hora), Frete
-- e Prefeitura (transporte de pacientes por convênio). Também corridas agendadas.

-- ---------- catálogo de serviços (cada cidade ajusta preços e liga/desliga) ----------
ALTER TABLE ride_categories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'corrida';
ALTER TABLE ride_categories ADD COLUMN IF NOT EXISTS vehicle_type text NOT NULL DEFAULT 'carro';
-- o que o motorista precisa ter para atender: executivo, mulher, pet, entrega, particular, paciente
ALTER TABLE ride_categories ADD COLUMN IF NOT EXISTS requires text[] NOT NULL DEFAULT '{}';
ALTER TABLE ride_categories ADD COLUMN IF NOT EXISTS per_hour_cents integer NOT NULL DEFAULT 0;   -- Particular
ALTER TABLE ride_categories ADD COLUMN IF NOT EXISTS extra_fee_cents integer NOT NULL DEFAULT 0;  -- Pet: taxa; Frete: por ajudante
ALTER TABLE ride_categories ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE ride_categories ADD COLUMN IF NOT EXISTS sort integer NOT NULL DEFAULT 100;
DO $$ BEGIN
  ALTER TABLE ride_categories ADD CONSTRAINT ride_categories_kind_check
    CHECK (kind IN ('corrida', 'entrega', 'particular', 'frete', 'paciente'));
  ALTER TABLE ride_categories ADD CONSTRAINT ride_categories_vehicle_check
    CHECK (vehicle_type IN ('carro', 'moto', 'utilitario'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- os dois serviços que já existiam ganham o nome da marca
UPDATE ride_categories SET vehicle_type = 'moto' WHERE code = 'moto';
UPDATE ride_categories SET name = 'Daqui Car', sort = 10, description = 'Corrida de carro pela cidade' WHERE code = 'carro' AND name = 'Carro';
UPDATE ride_categories SET name = 'Daqui Moto', sort = 20, description = 'Mototáxi rápido e econômico' WHERE code = 'moto' AND name = 'Moto';

-- serviços sugeridos para uma cidade (usado aqui e ao criar um licenciado novo)
CREATE OR REPLACE FUNCTION ondaqui_servicos_padrao(t uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ride_categories (tenant_id, code, name, kind, vehicle_type, requires, base_fare_cents, per_km_cents,
                               per_min_cents, min_fare_cents, per_hour_cents, extra_fee_cents, description, sort) VALUES
    (t, 'carro',         'Daqui Car',        'corrida',    'carro',      '{}',            400, 180, 30,  900,    0,    0, 'Corrida de carro pela cidade', 10),
    (t, 'moto',          'Daqui Moto',       'corrida',    'moto',       '{}',            250, 110, 15,  600,    0,    0, 'Mototáxi rápido e econômico', 20),
    (t, 'executivo',     'Daqui Executivo',  'corrida',    'carro',      '{executivo}',   700, 260, 40, 1500,    0,    0, 'Carros mais novos e confortáveis', 30),
    (t, 'mulher',        'Daqui Mulher',     'corrida',    'carro',      '{mulher}',      400, 180, 30,  900,    0,    0, 'Motoristas mulheres, só para passageiras', 40),
    (t, 'pet',           'Daqui Pet',        'corrida',    'carro',      '{pet}',         400, 180, 30,  900,    0,  500, 'Viaje com seu animal de estimação', 50),
    (t, 'entrega',       'Daqui Entrega',    'entrega',    'moto',       '{entrega}',     300, 120, 10,  700,    0,    0, 'Pacotes pequenos de moto, com código de entrega', 60),
    (t, 'entrega-carro', 'Daqui Entrega Carro', 'entrega', 'carro',      '{entrega}',     500, 170, 20, 1000,    0,    0, 'Pacotes maiores, de carro', 61),
    (t, 'particular',    'Daqui Particular', 'particular', 'carro',      '{particular}',    0,   0,  0, 9000, 4500,    0, 'Motorista à disposição por hora', 70),
    (t, 'frete',         'Daqui Frete',      'frete',      'utilitario', '{}',           1500, 350, 40, 3500,    0, 3000, 'Carreto e pequenas mudanças', 80),
    (t, 'paciente',      'Daqui Prefeitura', 'paciente',   'carro',      '{paciente}',    400, 180, 30,  900,    0,    0, 'Transporte de pacientes pela Saúde do município', 90)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;
SELECT ondaqui_servicos_padrao(id) FROM tenants;

-- ---------- motorista: tipo de veículo e o que ele atende ----------
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_type text NOT NULL DEFAULT 'carro';
UPDATE drivers SET vehicle_type = 'moto' WHERE category_code = 'moto';
-- escolhidos pelo próprio motorista: pet, entrega, particular
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS services_opt_in text[] NOT NULL DEFAULT '{entrega}';
-- liberados pelo licenciado depois de conferir: mulher, executivo, paciente, cadeirante
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS verified text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  ALTER TABLE drivers ADD CONSTRAINT drivers_vehicle_check CHECK (vehicle_type IN ('carro', 'moto', 'utilitario'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- passageira que se declarou mulher pode usar o Daqui Mulher
ALTER TABLE users ADD COLUMN IF NOT EXISTS declared_woman boolean NOT NULL DEFAULT false;

-- ---------- convênios (Prefeitura / Secretaria de Saúde) ----------
CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,                  -- ex.: Secretaria Municipal de Saúde
  document      text,                           -- CNPJ
  contact_name  text,
  contact_phone text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('passenger', 'driver', 'tenant_admin', 'master', 'account_operator'));

CREATE TABLE IF NOT EXISTS patients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            text NOT NULL,
  phone           text NOT NULL,
  document        text,                         -- CNS ou CPF
  address         text NOT NULL,
  lat             double precision NOT NULL,
  lng             double precision NOT NULL,
  wheelchair      boolean NOT NULL DEFAULT false,  -- precisa de veículo adaptado
  needs_companion boolean NOT NULL DEFAULT false,
  notes           text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS patients_account ON patients (account_id, name);

-- destinos frequentes do convênio (hospitais, UBS, clínicas)
CREATE TABLE IF NOT EXISTS account_places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  address     text NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL
);

-- ---------- corridas: todos os tipos de serviço ----------
ALTER TABLE rides ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'corrida';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS vehicle_type text NOT NULL DEFAULT 'carro';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS requires text[] NOT NULL DEFAULT '{}';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS hours_booked integer;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS helpers integer NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS notes text;
-- entrega
ALTER TABLE rides ADD COLUMN IF NOT EXISTS recipient_name text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS recipient_phone text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS package_desc text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS delivery_code char(4);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_photo_path text;
-- convênio (paciente)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS patient_id uuid REFERENCES patients(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS companion boolean NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS wheelchair boolean NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_of uuid REFERENCES rides(id);

-- corrida de paciente não tem passageiro com conta no app
ALTER TABLE rides ALTER COLUMN passenger_id DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE rides ADD CONSTRAINT rides_who_check CHECK (passenger_id IS NOT NULL OR patient_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_status_check;
ALTER TABLE rides ADD CONSTRAINT rides_status_check
  CHECK (status IN ('scheduled', 'requested', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled'));
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_payment_method_check;
ALTER TABLE rides ADD CONSTRAINT rides_payment_method_check CHECK (payment_method IN ('pix', 'card', 'cash', 'convenio'));

UPDATE rides r SET vehicle_type = c.vehicle_type
  FROM ride_categories c WHERE c.tenant_id = r.tenant_id AND c.code = r.category_code;

CREATE INDEX IF NOT EXISTS rides_scheduled ON rides (scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS rides_account ON rides (account_id, requested_at) WHERE account_id IS NOT NULL;
