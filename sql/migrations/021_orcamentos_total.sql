-- Coluna total no orçamento (sincronizada com a soma dos itens)
ALTER TABLE orcamentos ADD COLUMN IF NOT EXISTS total NUMERIC(12,2);

-- Backfill: soma dos itens de cada orçamento existente
UPDATE orcamentos o
SET total = COALESCE((SELECT SUM(i.valor_total) FROM orcamento_itens i WHERE i.orcamento_id = o.id), 0)
WHERE o.total IS NULL;
