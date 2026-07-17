-- Migration 056: permite bloquear fornecedores fraudulentos (ex: boletos frios via DDA)
BEGIN;

ALTER TABLE fornecedores DROP CONSTRAINT IF EXISTS fornecedores_status_check;
ALTER TABLE fornecedores ADD CONSTRAINT fornecedores_status_check
  CHECK (status IN ('ativo', 'inativo', 'bloqueado'));

COMMIT;
