BEGIN;

-- Add motorista to users role constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','analyst','gestor','vendedor','atendente','operador','financeiro','motorista'));

-- Add delivery confirmation columns to ordens_servico
ALTER TABLE ordens_servico
  ADD COLUMN IF NOT EXISTS entrega_nome_recebedor TEXT,
  ADD COLUMN IF NOT EXISTS entrega_foto_url TEXT;

COMMIT;
