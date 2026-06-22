CREATE TABLE IF NOT EXISTS especificacoes (
  id    SERIAL PRIMARY KEY,
  nome  VARCHAR(60) UNIQUE NOT NULL,
  ativo BOOLEAN DEFAULT true
);
CREATE TABLE IF NOT EXISTS os_especificacoes (
  os_id            UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  especificacao_id INTEGER NOT NULL REFERENCES especificacoes(id),
  PRIMARY KEY (os_id, especificacao_id)
);
INSERT INTO especificacoes (nome) VALUES
 ('ARTE FINAL'),('BLOCO'),('COLAGEM'),('CORTE'),('DOBRA'),('ENVELOPE'),
 ('FIXO CABEÇA'),('FIXO ESQUERDA'),('GRAMPO'),('ILHÓS'),('IMPRESSO'),
 ('INTERCALAÇÃO'),('LAMINAÇÃO BRILHO'),('LAMINAÇÃO FOSCA'),('NUMERAÇÃO'),
 ('REFILE'),('SERRILHA'),('TALÃO'),('VINCO')
ON CONFLICT (nome) DO NOTHING;
