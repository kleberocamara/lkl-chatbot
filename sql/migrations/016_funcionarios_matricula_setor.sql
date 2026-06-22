-- Migration 016: matricula sequencial + setor na tabela funcionarios
BEGIN;

ALTER TABLE funcionarios
  ADD COLUMN IF NOT EXISTS matricula VARCHAR(20) UNIQUE,
  ADD COLUMN IF NOT EXISTS setor     VARCHAR(50);

-- Sequência começando em 4 (LKL-001, LKL-002, LKL-003 já reservados)
CREATE SEQUENCE IF NOT EXISTS funcionarios_matricula_seq START 4;

-- Trigger para gerar matrícula automática no formato LKL-XXX
CREATE OR REPLACE FUNCTION gerar_matricula_func() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.matricula IS NULL THEN
    NEW.matricula := 'LKL-' || LPAD(nextval('funcionarios_matricula_seq')::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gerar_matricula_func ON funcionarios;
CREATE TRIGGER trg_gerar_matricula_func
  BEFORE INSERT ON funcionarios
  FOR EACH ROW EXECUTE FUNCTION gerar_matricula_func();

COMMIT;
