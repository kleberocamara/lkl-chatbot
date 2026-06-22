-- Migration 018: Integração Pedido ↔ Orçamento
-- Pedido é o ponto de entrada; orçamento é criado a partir dele
BEGIN;

-- 1. Ligar orçamento ao pedido de origem
ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS pedido_id UUID REFERENCES orders(id);

-- 2. Ligar pedido ao orçamento ativo
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS orcamento_id UUID REFERENCES orcamentos(id);

-- 3. Adicionar canal 'chatbot' nos pedidos
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS canal_override VARCHAR(20);

-- 4. Migrar status existentes para os novos valores
UPDATE orders SET status = 'novo'        WHERE status = 'criada';
UPDATE orders SET status = 'em_producao' WHERE status IN (
  'gerando_arquivo_impressao','arte_enviada_cliente',
  'arte_aprovada_cliente','arte_reprovada_cliente'
);

-- 5. Substituir constraint de status
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'novo', 'em_orcamento', 'aguardando_aprovacao', 'aprovado',
    'em_producao', 'concluido', 'entregue',
    'aguardando_pagamento', 'pago',
    'reprovado', 'cancelado'
  ));

-- 6. Índices para as novas FKs
CREATE INDEX IF NOT EXISTS idx_orcamentos_pedido_id ON orcamentos(pedido_id);
CREATE INDEX IF NOT EXISTS idx_orders_orcamento_id  ON orders(orcamento_id);

COMMIT;
