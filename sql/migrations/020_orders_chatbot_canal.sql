-- Adicionar 'chatbot' ao canal permitido
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_origin_channel_check;
ALTER TABLE orders ADD CONSTRAINT orders_origin_channel_check
  CHECK (origin_channel IN ('whatsapp','balcao','telefone','site','vendedor','chatbot'));
