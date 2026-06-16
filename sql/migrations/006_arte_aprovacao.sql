BEGIN;

-- Adiciona novo status e colunas de arte na OS
ALTER TABLE ordens_servico
  DROP CONSTRAINT IF EXISTS ordens_servico_status_check;

ALTER TABLE ordens_servico
  ADD CONSTRAINT ordens_servico_status_check
  CHECK (status IN ('aguardando','arte_final','aguardando_aprovacao_arte','impressao','acabamento','embalagem','pronto','entregue','cancelado'));

ALTER TABLE ordens_servico
  ADD COLUMN IF NOT EXISTS arte_arquivo_url TEXT,
  ADD COLUMN IF NOT EXISTS arte_aprovacao_comentario TEXT,
  ADD COLUMN IF NOT EXISTS arte_enviada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arte_aprovada_em TIMESTAMPTZ;

COMMIT;
