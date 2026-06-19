-- sql/migrations/011_mercadopago.sql
BEGIN;

ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS mp_preference_id TEXT,
  ADD COLUMN IF NOT EXISTS mp_checkout_url  TEXT;

-- Recria o CHECK para aceitar 'link_mp'
ALTER TABLE orcamentos DROP CONSTRAINT IF EXISTS orcamentos_tipo_cobranca_check;
ALTER TABLE orcamentos ADD CONSTRAINT orcamentos_tipo_cobranca_check
  CHECK (tipo_cobranca IN ('boleto','pix','link_mp'));

CREATE INDEX IF NOT EXISTS idx_orcamentos_mp_preference ON orcamentos(mp_preference_id);

COMMIT;
