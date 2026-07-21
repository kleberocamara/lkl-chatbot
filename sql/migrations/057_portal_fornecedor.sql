-- sql/migrations/057_portal_fornecedor.sql
BEGIN;

ALTER TABLE fornecedores ADD COLUMN portal_liberado BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE fornecedor_logins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id     UUID NOT NULL UNIQUE REFERENCES fornecedores(id) ON DELETE CASCADE,
  email             VARCHAR(150) NOT NULL UNIQUE,
  senha_hash        VARCHAR(255),
  convite_token     VARCHAR(64) UNIQUE,
  convite_expira    TIMESTAMPTZ,
  senha_definida_em TIMESTAMPTZ,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fornecedor_submissoes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id         UUID NOT NULL REFERENCES fornecedores(id),
  nnf                   VARCHAR(20),
  emitida_em            DATE,
  data_entrega_agendada DATE,
  valor_total           NUMERIC(12,2) NOT NULL,
  arquivo_nf_path       VARCHAR(255),
  tipo_pagamento        VARCHAR(10) NOT NULL CHECK (tipo_pagamento IN ('boleto','pix','ted','link_mp')),
  pix_chave             VARCHAR(140),
  ted_banco_nome        VARCHAR(100),
  ted_banco_codigo      VARCHAR(10),
  ted_tipo_conta        VARCHAR(20),
  ted_titularidade      VARCHAR(2) CHECK (ted_titularidade IN ('PJ','PF')),
  ted_documento         VARCHAR(18),
  ted_agencia           VARCHAR(10),
  ted_conta             VARCHAR(20),
  link_mp_url           VARCHAR(500),
  status                VARCHAR(20) NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente','alerta_dado_bancario','aguardando_entrega','aceita','rejeitada')),
  bot_verificacao       JSONB,
  entrada_estoque_id    UUID REFERENCES entradas_estoque(id) ON DELETE SET NULL,
  criada_em             TIMESTAMPTZ DEFAULT NOW(),
  revisada_por          UUID REFERENCES users(id) ON DELETE SET NULL,
  revisada_em           TIMESTAMPTZ
);

CREATE TABLE fornecedor_submissao_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submissao_id    UUID NOT NULL REFERENCES fornecedor_submissoes(id) ON DELETE CASCADE,
  produto         VARCHAR(200) NOT NULL,
  quantidade      NUMERIC(10,3) NOT NULL,
  valor_unitario  NUMERIC(12,4) NOT NULL,
  valor_total     NUMERIC(12,2) NOT NULL
);

CREATE TABLE fornecedor_submissao_boletos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submissao_id      UUID NOT NULL REFERENCES fornecedor_submissoes(id) ON DELETE CASCADE,
  arquivo_path      VARCHAR(255) NOT NULL,
  linha_digitavel   VARCHAR(60),
  valor             NUMERIC(12,2),
  vencimento        DATE
);

ALTER TABLE entradas_estoque ADD COLUMN fornecedor_submissao_id UUID REFERENCES fornecedor_submissoes(id) ON DELETE SET NULL;

CREATE INDEX idx_fornecedor_submissoes_fornecedor ON fornecedor_submissoes(fornecedor_id);
CREATE INDEX idx_fornecedor_submissoes_status ON fornecedor_submissoes(status);

COMMIT;
