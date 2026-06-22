-- Celular do usuário (usado p/ notificar vendedor via WhatsApp)
ALTER TABLE users ADD COLUMN IF NOT EXISTS celular VARCHAR(20);
