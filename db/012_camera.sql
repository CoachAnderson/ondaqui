-- Câmera de segurança no veículo (do próprio motorista): declarada no app, conferida pela central
-- e avisada ao passageiro antes do embarque (LGPD: transparência)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS camera_kind        text;    -- video | video_audio | NULL (sem câmera)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS camera_status      text;    -- pending | approved | rejected
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS camera_declared_at timestamptz;
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_camera_check;
ALTER TABLE drivers ADD CONSTRAINT drivers_camera_check CHECK (
  (camera_kind IS NULL AND camera_status IS NULL)
  OR (camera_kind IN ('video', 'video_audio') AND camera_status IN ('pending', 'approved', 'rejected')));
