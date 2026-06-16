BEGIN;

ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS canal VARCHAR(20) DEFAULT 'manual'
    CHECK (canal IN ('chatbot','vendedor','balcao','internet','manual')),
  ADD COLUMN IF NOT EXISTS pedido_chatbot_numero INTEGER;

CREATE INDEX IF NOT EXISTS idx_orcamentos_pedido_chatbot ON orcamentos(pedido_chatbot_numero);

COMMIT;
