BEGIN;

-- Drop old tables from Sprint 1 if they exist (migration from old schema)
DROP TABLE IF EXISTS orcamentos CASCADE;

-- Sequência para número do orçamento (ORC-XXXXX)
CREATE SEQUENCE IF NOT EXISTS orcamento_numero_seq START 1;

CREATE TABLE IF NOT EXISTS orcamentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero        INTEGER NOT NULL DEFAULT nextval('orcamento_numero_seq') UNIQUE,
  cliente_id    UUID REFERENCES clientes_lkl(id),
  vendedor_id   UUID REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'rascunho'
                CHECK (status IN ('rascunho','enviado','aprovado','cancelado')),
  condicao_pagamento TEXT,
  validade_dias  INTEGER DEFAULT 35,
  prazo_entrega  TEXT,
  observacao     TEXT,
  aprovado_em    TIMESTAMPTZ,
  aprovado_via   VARCHAR(30),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS orcamento_item_codigo_seq START 1000;

CREATE TABLE IF NOT EXISTS orcamento_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orcamento_id    UUID NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  codigo          INTEGER NOT NULL DEFAULT nextval('orcamento_item_codigo_seq'),
  descricao       TEXT NOT NULL,
  tipo_insumo     VARCHAR(50),
  formato_papel   VARCHAR(50),
  gramatura       VARCHAR(20),
  cores           VARCHAR(20),
  impressao       VARCHAR(30),
  acabamentos     TEXT[],
  quantidade      INTEGER NOT NULL,
  valor_unitario  NUMERIC(12,2),
  valor_total     NUMERIC(12,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS os_numero_seq START 1;

CREATE TABLE IF NOT EXISTS ordens_servico (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_os         INTEGER NOT NULL DEFAULT nextval('os_numero_seq') UNIQUE,
  orcamento_id      UUID NOT NULL REFERENCES orcamentos(id),
  orcamento_item_id UUID NOT NULL REFERENCES orcamento_itens(id),
  status            VARCHAR(30) NOT NULL DEFAULT 'aguardando'
                    CHECK (status IN (
                      'aguardando','arte_final','impressao',
                      'acabamento','embalagem','pronto','entregue','cancelado'
                    )),
  responsavel_id    UUID REFERENCES users(id),
  observacao_interna TEXT,
  data_inicio       TIMESTAMPTZ,
  data_conclusao    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamentos_cliente     ON orcamentos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_orcamentos_vendedor    ON orcamentos(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_orcamentos_status      ON orcamentos(status);
CREATE INDEX IF NOT EXISTS idx_orcamento_itens_orc    ON orcamento_itens(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_os_orcamento           ON ordens_servico(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_os_status              ON ordens_servico(status);

COMMIT;
