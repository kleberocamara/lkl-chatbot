CREATE TABLE IF NOT EXISTS os_materiais (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id          UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  via            INTEGER NOT NULL,
  material_id    UUID REFERENCES materiais(id),
  descricao      VARCHAR(200),
  cor_papel      VARCHAR(60),
  cores_tintas   VARCHAR(60),
  tipo_impressao VARCHAR(60),
  cores_frente   INTEGER,
  cores_verso    INTEGER,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_os_materiais_os ON os_materiais(os_id);
