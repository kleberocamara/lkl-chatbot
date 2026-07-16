-- Migration 057: obriga troca de senha no primeiro acesso pra novos usuarios
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true;

-- Contas ja existentes/ja em uso nao devem ser forcadas retroativamente
UPDATE users SET must_change_password = false;

COMMIT;
