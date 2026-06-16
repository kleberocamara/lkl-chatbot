-- sql/migrations/007_sprint3_pagamentos.sql
BEGIN;

ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS status_pagamento VARCHAR(20) DEFAULT 'pendente'
    CHECK (status_pagamento IN ('pendente','aguardando_pagamento','pago','cancelado')),
  ADD COLUMN IF NOT EXISTS tipo_cobranca VARCHAR(10)
    CHECK (tipo_cobranca IN ('boleto','pix')),
  ADD COLUMN IF NOT EXISTS boleto_id TEXT,
  ADD COLUMN IF NOT EXISTS boleto_linha_digitavel TEXT,
  ADD COLUMN IF NOT EXISTS boleto_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS boleto_vencimento DATE,
  ADD COLUMN IF NOT EXISTS pix_txid TEXT,
  ADD COLUMN IF NOT EXISTS pix_copia_cola TEXT,
  ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ;

ALTER TABLE ordens_servico
  ADD COLUMN IF NOT EXISTS pago BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orcamentos_status_pgto ON orcamentos(status_pagamento);
CREATE INDEX IF NOT EXISTS idx_orcamentos_pix_txid ON orcamentos(pix_txid);
CREATE INDEX IF NOT EXISTS idx_orcamentos_boleto_id ON orcamentos(boleto_id);

COMMIT;
