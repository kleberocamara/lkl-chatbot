-- OS-3A: cadastro de máquinas de impressão + vínculo na OS
CREATE TABLE IF NOT EXISTS maquinas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               VARCHAR(120) NOT NULL,
  fabricante         VARCHAR(80),
  modelo             VARCHAR(80),
  num_cores          INTEGER,
  formato_max_larg   NUMERIC(8,2),
  formato_max_alt    NUMERIC(8,2),
  velocidade_iph     INTEGER,
  operador_padrao_id UUID REFERENCES funcionarios(id) ON DELETE SET NULL,
  custo_lavagem      NUMERIC(10,2),
  status             VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa','inativa')),
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS maquina_id  UUID REFERENCES maquinas(id) ON DELETE SET NULL;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS operador_id UUID REFERENCES funcionarios(id) ON DELETE SET NULL;
