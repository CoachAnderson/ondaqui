-- Cobrança do produto na entrega: quem fechou a conferência (contrato com lojas, cláusula 3.2:
-- sem resposta da loja em 24 h, o recebimento conta como confirmado)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_settled_at timestamptz;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cod_settled_by text;
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_cod_settled_by_check;
ALTER TABLE rides ADD CONSTRAINT rides_cod_settled_by_check CHECK (cod_settled_by IS NULL OR cod_settled_by IN ('loja', 'automatico'));
CREATE INDEX IF NOT EXISTS rides_cod_waiting ON rides (cod_paid_at) WHERE cod_status = 'aguardando_loja';
