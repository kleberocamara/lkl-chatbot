-- 041: arte por item do orçamento (gate antes da OS)
ALTER TABLE orcamento_itens
  ADD COLUMN IF NOT EXISTS arte_status      TEXT NOT NULL DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS arte_arquivo_url TEXT,
  ADD COLUMN IF NOT EXISTS arte_enviada_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arte_aprovada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arte_comentario  TEXT;

CREATE INDEX IF NOT EXISTS idx_orcamento_itens_arte_status ON orcamento_itens(arte_status);
