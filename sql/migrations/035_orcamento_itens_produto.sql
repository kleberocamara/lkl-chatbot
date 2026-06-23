-- Item do orçamento ganha produto e especificação estruturados (descricao continua derivada)
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS produto       VARCHAR(150);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS especificacao VARCHAR(255);
