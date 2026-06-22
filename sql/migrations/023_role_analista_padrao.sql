-- Padroniza o perfil para 'analista' (pt-BR), removendo o legado 'analyst'
UPDATE users SET role = 'analista' WHERE role = 'analyst';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','gestor','vendedor','atendente','analista','operador','financeiro','motorista'));
