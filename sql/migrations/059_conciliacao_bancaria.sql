-- Migration 059: conciliação bancária — extrato C6 batido contra
-- contas_pagar (saídas) e orcamentos (entradas)
BEGIN;

CREATE TABLE extrato_lancamentos (
  id                 SERIAL PRIMARY KEY,
  external_id        VARCHAR(100) UNIQUE NOT NULL,
  entry_date         DATE NOT NULL,
  amount             NUMERIC(12,2) NOT NULL,
  operation_type     VARCHAR(10) NOT NULL,   -- INCOMING | OUTGOING
  transaction_type   VARCHAR(60),
  title              TEXT,
  description        TEXT,
  reference          TEXT,
  end_to_end_id      VARCHAR(60),
  status             VARCHAR(20) NOT NULL DEFAULT 'pendente', -- pendente | conciliado | ignorado
  conciliado_tipo    VARCHAR(20),            -- conta_pagar | orcamento
  conciliado_id      TEXT,                   -- contas_pagar.id (int) ou orcamentos.id (uuid), como texto
  conciliado_em      TIMESTAMP,
  conciliado_manual  BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_extrato_lancamentos_status ON extrato_lancamentos(status);
CREATE INDEX idx_extrato_lancamentos_entry_date ON extrato_lancamentos(entry_date);
CREATE INDEX idx_extrato_lancamentos_conciliado ON extrato_lancamentos(conciliado_tipo, conciliado_id);

COMMIT;
