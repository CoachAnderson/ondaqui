-- Chat da corrida: passageiro (ou loja/central da Saúde) e motorista conversam sem trocar telefone.
-- Fica guardado 30 dias depois do fim da corrida (prova em ocorrências) e depois é apagado.
CREATE TABLE IF NOT EXISTS ride_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  sender_side text NOT NULL CHECK (sender_side IN ('cliente', 'motorista')),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS ride_messages_ride ON ride_messages (ride_id, created_at);
