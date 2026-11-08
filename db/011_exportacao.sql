-- Registro de quem exportou dados (prestação de contas da LGPD)
CREATE TABLE IF NOT EXISTS data_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,   -- quem pediu
  kind       text NOT NULL CHECK (kind IN ('cidade', 'titular')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_exports_tenant ON data_exports (tenant_id, created_at DESC);
