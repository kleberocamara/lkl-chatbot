-- OS offset pode abranger múltiplos orçamentos, então orcamento_id pode ser NULL
ALTER TABLE ordens_servico ALTER COLUMN orcamento_id DROP NOT NULL;
