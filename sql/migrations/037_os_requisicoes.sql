-- OS-3C: requisição/baixa de materiais (offset + CV) + dimensões de CV
CREATE TABLE IF NOT EXISTS os_requisicoes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id         UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  status        VARCHAR(12) NOT NULL DEFAULT 'baixada' CHECK (status IN ('baixada','estornada')),
  criada_em     TIMESTAMPTZ DEFAULT now(),
  criada_por    UUID REFERENCES users(id) ON DELETE SET NULL,
  estornada_em  TIMESTAMPTZ,
  estornada_por UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_os_requisicoes_os ON os_requisicoes(os_id);

CREATE TABLE IF NOT EXISTS os_requisicao_itens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisicao_id UUID NOT NULL REFERENCES os_requisicoes(id) ON DELETE CASCADE,
  material_id   UUID NOT NULL REFERENCES materiais(id),
  quantidade    NUMERIC(10,3) NOT NULL,
  unidade       VARCHAR(10) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_os_requisicao_itens_req ON os_requisicao_itens(requisicao_id);

ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS largura_cm  NUMERIC(8,2);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS altura_cm   NUMERIC(8,2);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS material_id UUID REFERENCES materiais(id);
