-- Entrada de estoque via NF-e de compra
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS codigo_barras VARCHAR(20);
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS fator_entrada NUMERIC(12,4) DEFAULT 1;

CREATE TABLE IF NOT EXISTS entradas_estoque (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id UUID REFERENCES fornecedores(id) ON DELETE SET NULL,
  nnf           VARCHAR(20),
  chave         VARCHAR(44) UNIQUE,
  emitida_em    DATE,
  valor_total   NUMERIC(12,2),
  status        VARCHAR(12) NOT NULL DEFAULT 'lancada' CHECK (status IN ('lancada','estornada')),
  criada_em     TIMESTAMPTZ DEFAULT now(),
  criada_por    UUID REFERENCES users(id) ON DELETE SET NULL,
  estornada_em  TIMESTAMPTZ,
  estornada_por UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS entradas_estoque_itens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entrada_id          UUID NOT NULL REFERENCES entradas_estoque(id) ON DELETE CASCADE,
  material_id         UUID REFERENCES materiais(id),
  cprod               VARCHAR(60),
  cean                VARCHAR(20),
  xprod               VARCHAR(200),
  ucom                VARCHAR(10),
  qcom                NUMERIC(14,4),
  vun                 NUMERIC(14,6),
  fator_aplicado      NUMERIC(12,4),
  quantidade_estoque  NUMERIC(14,4),
  custo_unit_estoque  NUMERIC(14,6)
);
CREATE INDEX IF NOT EXISTS idx_entradas_itens_entrada ON entradas_estoque_itens(entrada_id);
