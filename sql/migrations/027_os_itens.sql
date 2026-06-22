CREATE TABLE IF NOT EXISTS os_itens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id              UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  orcamento_item_id  UUID NOT NULL REFERENCES orcamento_itens(id),
  created_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE (orcamento_item_id)
);
CREATE INDEX IF NOT EXISTS idx_os_itens_os ON os_itens(os_id);
