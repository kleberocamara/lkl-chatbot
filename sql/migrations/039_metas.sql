-- AG-3: meta mensal de faturamento da empresa
CREATE TABLE IF NOT EXISTS metas (
  id          SERIAL PRIMARY KEY,
  ano         INTEGER NOT NULL,
  mes         INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  valor_meta  NUMERIC(12,2) NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ano, mes)
);
