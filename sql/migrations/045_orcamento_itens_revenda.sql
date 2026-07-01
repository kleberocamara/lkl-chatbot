-- 045_orcamento_itens_revenda.sql — AO-2b: item de orçamento vindo do catálogo de revenda
-- ATENÇÃO: orcamento_itens pertence ao user postgres → rodar via `sudo -u postgres psql`.
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_produto_id UUID REFERENCES revenda_produtos(id) ON DELETE SET NULL;
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_prazo_horas INTEGER;
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_acabamentos JSONB DEFAULT '[]'::jsonb;
