-- OnDaqui — esquema inicial (MVP de corridas)
-- Valores em dinheiro sempre em centavos (inteiros).
-- Localização em latitude/longitude simples; a distância é calculada com a
-- fórmula de Haversine em SQL, sem extensões. PostGIS pode substituir depois.

CREATE TABLE IF NOT EXISTS tenants (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name                     text NOT NULL,              -- ex.: "OnDaqui Bauru"
  city_label               text NOT NULL,              -- ex.: "Bauru"
  accent_color             text NOT NULL DEFAULT '#F2622E',
  active                   boolean NOT NULL DEFAULT true,
  -- área de atuação (retângulo); nulo = sem limite
  min_lat double precision, max_lat double precision,
  min_lng double precision, max_lng double precision,
  -- regras de operação
  current_surge            numeric(3,2) NOT NULL DEFAULT 1.00,
  surge_cap                numeric(3,2) NOT NULL DEFAULT 1.50,
  dispatch_radius_km       numeric(5,2) NOT NULL DEFAULT 8,
  selfie_validity_hours    integer NOT NULL DEFAULT 12,
  -- taxa por corrida devida ao dono da plataforma (licença)
  license_fee_per_ride_cents integer NOT NULL DEFAULT 20,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (current_surge >= 1 AND current_surge <= surge_cap)
);

CREATE TABLE IF NOT EXISTS ride_categories (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code             text NOT NULL,          -- carro, moto, mulher, pet...
  name             text NOT NULL,
  base_fare_cents  integer NOT NULL,
  per_km_cents     integer NOT NULL,
  per_min_cents    integer NOT NULL,
  min_fare_cents   integer NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS driver_plans (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            text NOT NULL,           -- livre, semanal, profissional
  name            text NOT NULL,
  price_cents     integer NOT NULL DEFAULT 0,
  period_days     integer NOT NULL DEFAULT 0,   -- 0 = sem mensalidade
  commission_pct  numeric(5,2) NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- nulo só para master
  role           text NOT NULL CHECK (role IN ('passenger','driver','tenant_admin','master')),
  name           text NOT NULL,
  phone          text NOT NULL,
  password_hash  text NOT NULL,
  blocked        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'master') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_phone ON users (tenant_id, phone) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_master_phone ON users (phone) WHERE tenant_id IS NULL;

CREATE TABLE IF NOT EXISTS drivers (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','blocked')),
  category_code      text NOT NULL DEFAULT 'carro',
  vehicle_plate      text NOT NULL,
  vehicle_model      text NOT NULL,
  vehicle_color      text NOT NULL,
  -- exigências da Lei 13.640/2018, conferidas pelo licenciado
  cnh_ear_ok         boolean NOT NULL DEFAULT false,
  inss_ok            boolean NOT NULL DEFAULT false,
  criminal_record_ok boolean NOT NULL DEFAULT false,
  insurance_app_ok   boolean NOT NULL DEFAULT false,
  -- antigolpe: Pix só aparece para o passageiro depois de validado
  pix_key            text,
  pix_holder_name    text,
  pix_validated      boolean NOT NULL DEFAULT false,
  -- plano e mensalidade
  plan_code          text NOT NULL DEFAULT 'livre',
  trial_until        date,
  paid_until         date,
  -- operação
  online             boolean NOT NULL DEFAULT false,
  lat                double precision,
  lng                double precision,
  location_at        timestamptz,
  selfie_checked_at  timestamptz,
  selfie_path        text
);
CREATE INDEX IF NOT EXISTS drivers_online ON drivers (online) WHERE online;

CREATE TABLE IF NOT EXISTS rides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  passenger_id     uuid NOT NULL REFERENCES users(id),
  driver_id        uuid REFERENCES users(id),
  category_code    text NOT NULL,
  status           text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested','accepted','arrived','in_progress','completed','cancelled')),
  origin_lat double precision NOT NULL, origin_lng double precision NOT NULL, origin_address text NOT NULL,
  dest_lat   double precision NOT NULL, dest_lng   double precision NOT NULL, dest_address   text NOT NULL,
  distance_km      numeric(7,2) NOT NULL,
  duration_min     integer NOT NULL,
  price_cents      integer NOT NULL,
  surge            numeric(3,2) NOT NULL DEFAULT 1.00,
  payment_method   text NOT NULL CHECK (payment_method IN ('pix','card','cash')),
  boarding_code    char(4) NOT NULL,
  share_token      text NOT NULL UNIQUE,
  commission_cents integer NOT NULL DEFAULT 0,
  license_fee_cents integer NOT NULL DEFAULT 0,
  cancel_reason    text,
  cancelled_by     text,
  passenger_rating smallint CHECK (passenger_rating BETWEEN 1 AND 5),
  driver_rating    smallint CHECK (driver_rating BETWEEN 1 AND 5),
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz, arrived_at timestamptz, started_at timestamptz,
  completed_at timestamptz, cancelled_at timestamptz
);
CREATE INDEX IF NOT EXISTS rides_tenant_status ON rides (tenant_id, status);
CREATE INDEX IF NOT EXISTS rides_driver ON rides (driver_id);
CREATE INDEX IF NOT EXISTS rides_passenger ON rides (passenger_id);
-- um passageiro e um motorista só podem ter uma corrida ativa por vez
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_passenger ON rides (passenger_id)
  WHERE status IN ('requested','accepted','arrived','in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_driver ON rides (driver_id)
  WHERE status IN ('accepted','arrived','in_progress');

CREATE TABLE IF NOT EXISTS ride_offers (
  ride_id    uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','declined','accepted','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ride_id, driver_id)
);

CREATE TABLE IF NOT EXISTS panic_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ride_id     uuid REFERENCES rides(id) ON DELETE SET NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  lat double precision, lng double precision,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  note        text
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code     text NOT NULL,
  amount_cents  integer NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  registered_by uuid REFERENCES users(id),
  paid_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
