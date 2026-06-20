-- M10-A: matricula, setor, observacao + corrigir perfis Bruna/Leandro
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS matricula  VARCHAR(20) UNIQUE,
  ADD COLUMN IF NOT EXISTS setor      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS observacao TEXT;

-- Sequência para auto-incremento da matrícula
CREATE SEQUENCE IF NOT EXISTS users_matricula_seq START 1;

-- Função para gerar matrícula no formato LKL-001
CREATE OR REPLACE FUNCTION gerar_matricula() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.matricula IS NULL THEN
    NEW.matricula := 'LKL-' || LPAD(nextval('users_matricula_seq')::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gerar_matricula ON users;
CREATE TRIGGER trg_gerar_matricula
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION gerar_matricula();

-- Gerar matrículas retroativas para usuários existentes sem matrícula
-- (ordena por created_at para manter ordem cronológica)
DO $$
DECLARE
  rec RECORD;
  seq INT := 1;
BEGIN
  FOR rec IN
    SELECT id FROM users WHERE matricula IS NULL ORDER BY created_at ASC
  LOOP
    UPDATE users
      SET matricula = 'LKL-' || LPAD(seq::TEXT, 3, '0')
      WHERE id = rec.id;
    seq := seq + 1;
  END LOOP;
  -- Avança a sequência para além dos valores já usados
  PERFORM setval('users_matricula_seq', seq);
END;
$$;

-- Corrigir perfis: Bruna → atendente, Leandro → gestor
UPDATE users SET role = 'atendente', setor = 'Atendimento'
  WHERE email = 'brunabessa40@gmail.com';

UPDATE users SET role = 'gestor', setor = 'Gestão'
  WHERE email = 'camara.leandrooliveira@gmail.com';

UPDATE users SET setor = 'Administração'
  WHERE email = 'admin@lklgrafica.com.br';

COMMIT;
