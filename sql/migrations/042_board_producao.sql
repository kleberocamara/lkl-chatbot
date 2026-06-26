-- Table: os_historico (append-only audit log)
CREATE TABLE IF NOT EXISTS os_historico (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id       UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  de_status   TEXT,
  para_status TEXT NOT NULL,
  usuario_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_os_historico_os_id ON os_historico(os_id);

-- Replace legacy status check constraint with canonical statuses
-- Canonical statuses: corte, impressao, acabamento, entrega, entregue, cancelado
ALTER TABLE ordens_servico DROP CONSTRAINT IF EXISTS ordens_servico_status_check;

-- Remap legacy statuses on existing OS rows (must run before adding new constraint)
UPDATE ordens_servico
SET status = CASE
  WHEN status IN ('embalagem', 'pronto') THEN 'entrega'
  WHEN status IN ('arte_final', 'aguardando_aprovacao_arte', 'aguardando')
    THEN CASE tipo_servico
           WHEN 'comunicacao_visual' THEN 'impressao'
           ELSE 'corte'
         END
  ELSE status
END
WHERE status IN ('embalagem','pronto','arte_final','aguardando_aprovacao_arte','aguardando');

-- Add new constraint with canonical statuses only
ALTER TABLE ordens_servico ADD CONSTRAINT ordens_servico_status_check
  CHECK (status IN ('corte','impressao','acabamento','entrega','entregue','cancelado'));
