-- Especificação por item do pedido (dimensões/arte) — alimenta a descrição do orçamento
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS especificacao VARCHAR(255);

-- valor_unitario/valor_total não fazem sentido na etapa de pedido (sem preço ainda)
ALTER TABLE order_items ALTER COLUMN valor_unitario SET DEFAULT 0;
ALTER TABLE order_items ALTER COLUMN valor_total    SET DEFAULT 0;
