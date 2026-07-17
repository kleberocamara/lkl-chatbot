-- Migration 055: sincroniza tipos_despesa com a planilha "TIPOS DE DESPESAS.xlsx"
-- A planilha ganhou 2 tipos novos (CHAPAS OFFSET e INSUMOS COMUNICAÇÃO VISUAL) nas
-- posições 3 e 4, empurrando todos os códigos seguintes em +2. Isso não afeta nenhuma
-- conta já classificada (contas_pagar.tipo_despesa_id e fornecedores.tipo_despesa_padrao_id
-- referenciam o id interno, não o código).
BEGIN;

-- Desloca os códigos existentes (3..38) em +2, em ordem decrescente para nunca colidir
-- com a constraint UNIQUE(codigo) durante o processo (38→40 libera 38 antes de 36→38 rodar).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, codigo FROM tipos_despesa WHERE codigo::int >= 3 ORDER BY codigo::int DESC LOOP
    UPDATE tipos_despesa SET codigo = LPAD((r.codigo::int + 2)::text, 2, '0') WHERE id = r.id;
  END LOOP;
END $$;

-- Insere os 2 tipos novos nas posições 3 e 4, exatamente como na planilha.
INSERT INTO tipos_despesa (codigo, nome, categoria_dre, natureza) VALUES
  ('03', 'CHAPAS OFFSET',                'CUSTOS DE PRODUÇÃO (CPV)', 'VARIÁVEL (PRODUÇÃO)'),
  ('04', 'INSUMOS COMUNICAÇAO VISUAL',   'CUSTOS DE PRODUÇÃO (CPV)', 'VARIÁVEL (PRODUÇÃO)');

COMMIT;
