-- sql/migrations/009_boletos_parcelas.sql
-- Tabela de parcelas de boleto (suporte a pagamento parcelado)

CREATE TABLE IF NOT EXISTS orcamento_boletos (
  id              SERIAL PRIMARY KEY,
  orcamento_id    UUID NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  parcela         INTEGER NOT NULL,
  total_parcelas  INTEGER NOT NULL,
  boleto_id       TEXT,
  linha_digitavel TEXT,
  pdf_url         TEXT,
  vencimento      DATE,
  valor           NUMERIC(12,2) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'aguardando'
                  CHECK (status IN ('aguardando','pago','cancelado')),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orc_boletos_orcamento ON orcamento_boletos(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_orc_boletos_boleto_id ON orcamento_boletos(boleto_id);
