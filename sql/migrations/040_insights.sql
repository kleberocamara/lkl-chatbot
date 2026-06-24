-- AG-4: insights financeiros gerados por IA
CREATE TABLE IF NOT EXISTS insights_financeiros (
  id         SERIAL PRIMARY KEY,
  gerado_em  TIMESTAMPTZ DEFAULT now(),
  periodo    VARCHAR(7),
  conteudo   TEXT NOT NULL,
  contexto   JSONB
);
