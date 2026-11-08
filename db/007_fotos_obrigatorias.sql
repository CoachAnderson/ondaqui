-- Foto do motorista e do veículo obrigatórias para trabalhar.
-- Foto nova fica "em análise" sem tirar o motorista do ar: o cliente continua vendo a aprovada até a central conferir.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_pending_path text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_pending_path text;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_review text;   -- pending (fotos novas para conferir) ou rejected
DO $$ BEGIN
  ALTER TABLE drivers ADD CONSTRAINT drivers_photo_review_check CHECK (photo_review IS NULL OR photo_review IN ('pending', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
