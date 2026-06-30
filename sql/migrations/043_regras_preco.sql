-- 043_regras_preco.sql — AO-1 framework de estratégia de preço
-- ATENÇÃO: rodar a parte de ALTER orcamento_itens via `sudo -u postgres psql` (tabela pertence ao user postgres).

CREATE TABLE IF NOT EXISTS regras_preco (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto         VARCHAR(150) NOT NULL,
  material_id     UUID REFERENCES materiais(id) ON DELETE SET NULL,
  metodo_calculo  VARCHAR(20) NOT NULL
                  CHECK (metodo_calculo IN ('manual','fixo','m2','m2_bobina','faixa','revenda')),
  preco_base      NUMERIC(12,4),
  m2_minimo       NUMERIC(10,4),
  espaco_corte_cm NUMERIC(6,2) DEFAULT 0,
  ativo           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_regras_preco_ativa
  ON regras_preco (produto, COALESCE(material_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE ativo;

CREATE TABLE IF NOT EXISTS regras_preco_faixa (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regra_id        UUID NOT NULL REFERENCES regras_preco(id) ON DELETE CASCADE,
  qtd_min         INTEGER NOT NULL DEFAULT 1,
  qtd_max         INTEGER,
  preco_unitario  NUMERIC(12,4) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regras_preco_faixa_regra ON regras_preco_faixa(regra_id);

CREATE TABLE IF NOT EXISTS material_bobinas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id     UUID NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
  largura_cm      NUMERIC(8,2) NOT NULL,
  ativo           BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_material_bobinas_material ON material_bobinas(material_id);

CREATE TABLE IF NOT EXISTS precos_revenda (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto         VARCHAR(150) NOT NULL,
  opcoes          JSONB DEFAULT '{}'::jsonb,
  preco_unitario  NUMERIC(12,4) NOT NULL,
  sincronizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_precos_revenda_produto ON precos_revenda(produto);

-- Rodar via: sudo -u postgres psql -d <DB> -f (apenas estas duas linhas, se preferir separar)
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_origem  VARCHAR(10) DEFAULT 'manual';
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_memoria TEXT;
