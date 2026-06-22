ALTER TABLE ordens_servico ALTER COLUMN orcamento_item_id DROP NOT NULL;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_servico     VARCHAR(20);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_produto     VARCHAR(100);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS cliente_id       UUID REFERENCES clientes_lkl(id);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS previsao_entrega DATE;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS quantidade       INTEGER;
