-- sql/migrations/008_sprint4_nfe.sql
BEGIN;

CREATE TABLE IF NOT EXISTS nfe (
  id               SERIAL PRIMARY KEY,
  orcamento_id     UUID NOT NULL REFERENCES orcamentos(id),
  cnpj_emitente    VARCHAR(14) NOT NULL,
  numero           INTEGER NOT NULL,
  serie            VARCHAR(3) NOT NULL DEFAULT '001',
  chave            VARCHAR(44),
  protocolo        VARCHAR(20),
  status           VARCHAR(20) NOT NULL DEFAULT 'pendente',
  xml              TEXT,
  danfe_path       TEXT,
  cfop             VARCHAR(4) NOT NULL,
  ncm_por_item     JSONB NOT NULL DEFAULT '{}',
  frete_por_conta  VARCHAR(1) NOT NULL DEFAULT '9',
  frete_valor      NUMERIC(10,2) DEFAULT 0,
  transportador    JSONB,
  info_complementar TEXT,
  emitido_em       TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nfe_sequencia (
  cnpj           VARCHAR(14) PRIMARY KEY,
  ultimo_numero  INTEGER NOT NULL DEFAULT 0
);

-- Começa do zero em homologação
-- Em produção: UPDATE nfe_sequencia SET ultimo_numero = <ultimo_sisgraf> WHERE cnpj = '<cnpj>';
INSERT INTO nfe_sequencia (cnpj, ultimo_numero) VALUES
  ('19296723000108', 0),
  ('44448899000185', 0)
ON CONFLICT (cnpj) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_nfe_orcamento ON nfe(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_nfe_chave ON nfe(chave);
CREATE INDEX IF NOT EXISTS idx_nfe_status ON nfe(status);

COMMIT;
