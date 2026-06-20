-- sql/migrations/012_contas_pagar.sql
BEGIN;

CREATE TYPE tipo_despesa_enum AS ENUM (
  'ALUGUEL', 'AGUA', 'TARIFA_BANCO', 'FRETE', 'COMBUSTIVEL',
  'TELEFONIA_INTERNET', 'MATERIAL_LIMPEZA', 'MATERIAL_ESCRITORIO',
  'DESPESA_VIAGEM', 'LUZ', 'IMPOSTOS', 'MANUTENCAO', 'COMISSOES',
  'FORNECEDOR', 'SERVICO_TERCEIRIZADO', 'EMPRESTIMO_FINANCIAMENTO',
  'CONTADOR_FOLHA_PAGAMENTO', 'OUTRAS_DESPESAS'
);

CREATE TABLE contas_pagar (
  id                     SERIAL PRIMARY KEY,
  descricao              TEXT NOT NULL,
  fornecedor             TEXT,
  tipo_despesa           tipo_despesa_enum NOT NULL,
  valor                  NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  vencimento             DATE NOT NULL,
  tipo                   VARCHAR(10) NOT NULL DEFAULT 'boleto'
                           CHECK (tipo IN ('boleto','pix','outro')),
  linha_digitavel        TEXT,
  pix_content            TEXT,
  tipo_entrada           VARCHAR(20) NOT NULL DEFAULT 'manual'
                           CHECK (tipo_entrada IN ('manual','dda','importacao_oc')),
  status                 VARCHAR(20) NOT NULL DEFAULT 'pendente'
                           CHECK (status IN ('pendente','agendado','pago','vencido','cancelado')),
  c6_group_id            TEXT,
  c6_item_id             TEXT,
  c6_status              TEXT,
  recorrente             BOOLEAN NOT NULL DEFAULT false,
  recorrencia_dia        SMALLINT CHECK (recorrencia_dia BETWEEN 1 AND 28),
  recorrencia_valor_fixo BOOLEAN DEFAULT true,
  pago_em                TIMESTAMP,
  observacao             TEXT,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contas_pagar_status      ON contas_pagar(status);
CREATE INDEX idx_contas_pagar_vencimento  ON contas_pagar(vencimento);
CREATE INDEX idx_contas_pagar_tipo_desp   ON contas_pagar(tipo_despesa);
CREATE INDEX idx_contas_pagar_c6_group    ON contas_pagar(c6_group_id);
CREATE UNIQUE INDEX idx_contas_pagar_ld   ON contas_pagar(linha_digitavel)
  WHERE linha_digitavel IS NOT NULL AND status != 'cancelado';

CREATE TABLE payment_batches (
  id               SERIAL PRIMARY KEY,
  c6_group_id      TEXT UNIQUE NOT NULL,
  uploader_name    TEXT NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'decodificando'
                     CHECK (status IN ('decodificando','pronto','submetido','aprovado','parcial','erro')),
  valor_total      NUMERIC(10,2),
  quantidade_itens INTEGER,
  submetido_em     TIMESTAMP,
  aprovado_em      TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMIT;
