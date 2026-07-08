-- sql/migrations/052_whatsapp_ocr_despesas.sql
BEGIN;

CREATE TABLE despesas_pendentes_confirmacao (
  id              SERIAL PRIMARY KEY,
  telefone        TEXT NOT NULL,
  fornecedor_id   UUID REFERENCES fornecedores(id),
  valor           NUMERIC(10,2),
  vencimento      DATE,
  descricao       TEXT,
  tipo_despesa_id INTEGER REFERENCES tipos_despesa(id),
  criado_em       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_despesas_pendentes_telefone ON despesas_pendentes_confirmacao(telefone);

-- Liga a entrada de estoque (NF de compra) à conta a pagar gerada por ela,
-- mesmo padrão já usado em revenda_compras.conta_pagar_id (migration 048).
ALTER TABLE entradas_estoque ADD COLUMN conta_pagar_id INTEGER REFERENCES contas_pagar(id) ON DELETE SET NULL;

-- NOTA: o nome da constraint abaixo (contas_pagar_tipo_entrada_check) NÃO foi confirmado
-- via `\d contas_pagar` em banco real (não havia psql/$DATABASE_URL disponível neste
-- ambiente sandbox). O nome foi assumido a partir do padrão de nomenclatura implícita do
-- Postgres para CHECK inline sem nome explícito, visto em sql/migrations/012_contas_pagar.sql
-- (coluna tipo_entrada, CHECK (tipo_entrada IN ('manual','dda','importacao_oc'))).
-- CONFIRME com `psql "$DATABASE_URL" -c "\d contas_pagar" | grep -i tipo_entrada` antes de aplicar.
ALTER TABLE contas_pagar DROP CONSTRAINT contas_pagar_tipo_entrada_check;
ALTER TABLE contas_pagar ADD CONSTRAINT contas_pagar_tipo_entrada_check
  CHECK (tipo_entrada IN ('manual','dda','importacao_oc','whatsapp_ocr','entrada_estoque'));

COMMIT;
