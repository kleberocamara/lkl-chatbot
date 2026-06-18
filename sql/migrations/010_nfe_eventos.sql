-- sql/migrations/010_nfe_eventos.sql
BEGIN;

-- Create nfe_eventos table
-- nfe_id is nullable to support inutilização (cancelation without specific NF)
CREATE TABLE IF NOT EXISTS nfe_eventos (
  id                 SERIAL PRIMARY KEY,
  nfe_id             INTEGER REFERENCES nfe(id) ON DELETE CASCADE,
  tipo               VARCHAR(20) NOT NULL CHECK (tipo IN ('cancelamento','cc_e','inutilizacao')),
  protocolo          VARCHAR(20),
  c_stat             VARCHAR(3),
  x_motivo           TEXT,
  justificativa      TEXT,
  xml_evento         TEXT,
  criado_em          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nfe_eventos_nfe ON nfe_eventos(nfe_id);
CREATE INDEX IF NOT EXISTS idx_nfe_eventos_tipo ON nfe_eventos(tipo);
CREATE INDEX IF NOT EXISTS idx_nfe_eventos_protocolo ON nfe_eventos(protocolo);

-- Add columns to track event status in nfe table
ALTER TABLE nfe ADD COLUMN IF NOT EXISTS cancelado_em TIMESTAMPTZ;
ALTER TABLE nfe ADD COLUMN IF NOT EXISTS cancelamento_protocolo VARCHAR(20);

COMMIT;
