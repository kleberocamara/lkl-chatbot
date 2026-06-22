-- Tipo de produção por item: decide auto (COMUNICAÇÃO VISUAL) vs manual (OFFSET)
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS tipo_producao VARCHAR(30);
