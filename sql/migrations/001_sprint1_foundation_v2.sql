-- Migration Sprint 1 v2: M0 Cadastros + M1 Orders
-- Corrigido para VPS onde price_table já existe com schema diferente
-- Executar: sudo -u postgres psql -d lkl_chatbot -f /tmp/001_sprint1_foundation_v2.sql

BEGIN;

-- ── CLIENTES ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes_lkl (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  tipo_pessoa       VARCHAR(2) NOT NULL CHECK (tipo_pessoa IN ('PF', 'PJ')),
  cpf_cnpj          VARCHAR(18),
  nome              VARCHAR(150) NOT NULL,
  fantasia          VARCHAR(150),
  email             VARCHAR(150),
  celular           VARCHAR(20),
  telefone          VARCHAR(20),
  cep               VARCHAR(9),
  logradouro        VARCHAR(200),
  numero            VARCHAR(20),
  bairro            VARCHAR(100),
  cidade            VARCHAR(100),
  uf                VARCHAR(2),
  segmento          VARCHAR(100),
  canal_origem      VARCHAR(50) DEFAULT 'sisgraph',
  condicao_pagamento VARCHAR(50),
  limite_credito    NUMERIC(10,2) DEFAULT 0,
  contribuinte_icms VARCHAR(10) DEFAULT 'nao' CHECK (contribuinte_icms IN ('sim', 'nao', 'isento')),
  status            VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'bloqueado')),
  score_completude  INTEGER DEFAULT 0 CHECK (score_completude BETWEEN 0 AND 100),
  codigo_sisgraph   INTEGER,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_cpf_cnpj ON clientes_lkl(cpf_cnpj) WHERE cpf_cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_celular ON clientes_lkl(celular);
CREATE INDEX IF NOT EXISTS idx_clientes_email ON clientes_lkl(email);
CREATE INDEX IF NOT EXISTS idx_clientes_status ON clientes_lkl(status);

-- ── FORNECEDORES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fornecedores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_sisgraph  VARCHAR(20),
  nome             VARCHAR(150) NOT NULL,
  cnpj             VARCHAR(18),
  contato          VARCHAR(150),
  ddd              VARCHAR(3),
  telefone         VARCHAR(20),
  email            VARCHAR(150),
  logradouro       VARCHAR(200),
  cidade           VARCHAR(100),
  uf               VARCHAR(2),
  categoria        VARCHAR(100),
  status           VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fornecedores_cnpj ON fornecedores(cnpj) WHERE cnpj IS NOT NULL;

-- ── MATERIAIS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS materiais (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo           VARCHAR(50) UNIQUE,
  nome             VARCHAR(150) NOT NULL,
  unidade          VARCHAR(20) NOT NULL DEFAULT 'un',
  estoque_atual    NUMERIC(10,3) DEFAULT 0,
  estoque_minimo   NUMERIC(10,3) DEFAULT 0,
  custo_medio      NUMERIC(10,4) DEFAULT 0,
  fornecedor_id    UUID REFERENCES fornecedores(id) ON DELETE SET NULL,
  status           VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── FUNCIONÁRIOS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funcionarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  nome             VARCHAR(150) NOT NULL,
  cpf              VARCHAR(14) UNIQUE NOT NULL,
  rg               VARCHAR(20),
  data_nascimento  DATE,
  cargo            VARCHAR(100) NOT NULL,
  salario          NUMERIC(10,2),
  data_admissao    DATE NOT NULL,
  telefone         VARCHAR(20),
  celular          VARCHAR(20),
  email            VARCHAR(150),
  status           VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'afastado')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── TABELA DE PREÇOS (migração do schema antigo) ──────────────────────────────
-- A price_table já existe com colunas diferentes (servico/formato/material).
-- Preservamos os dados antigos em backup e recriamos com o novo schema.
ALTER TABLE price_table RENAME TO price_table_chatbot_backup;

CREATE TABLE price_table (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto          VARCHAR(150) NOT NULL,
  acabamento       VARCHAR(100),
  quantidade_min   INTEGER NOT NULL DEFAULT 1,
  quantidade_max   INTEGER,
  preco_unitario   NUMERIC(10,4) NOT NULL,
  unidade          VARCHAR(20) DEFAULT 'un',
  ativo            BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_table_produto ON price_table(produto);
CREATE INDEX IF NOT EXISTS idx_price_table_ativo ON price_table(ativo);

-- ── ORDERS (OS) ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_os               SERIAL,
  origin_channel          VARCHAR(20) NOT NULL CHECK (origin_channel IN ('whatsapp','balcao','telefone','site','vendedor')),
  orcamento_id            UUID,
  cliente_id              UUID REFERENCES clientes_lkl(id) ON DELETE SET NULL,
  vendedor_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  status                  VARCHAR(50) NOT NULL DEFAULT 'criada'
                          CHECK (status IN (
                            'criada','gerando_arquivo_impressao','arte_enviada_cliente',
                            'arte_aprovada_cliente','arte_reprovada_cliente',
                            'em_producao','concluido','entregue','cancelado'
                          )),
  status_arte             VARCHAR(50) DEFAULT 'pendente'
                          CHECK (status_arte IN ('pendente','em_criacao','aguardando_aprovacao_cliente','aprovada','reprovada')),
  produto                 VARCHAR(150),
  quantidade              INTEGER,
  material                VARCHAR(150),
  acabamento              VARCHAR(100),
  tem_arte                BOOLEAN DEFAULT FALSE,
  arquivo_arte            VARCHAR(500),
  prazo                   DATE,
  valor_orcamento         NUMERIC(10,2),
  valor_final             NUMERIC(10,2),
  external_reference_id   VARCHAR(26) UNIQUE,
  nps_score               INTEGER CHECK (nps_score BETWEEN 1 AND 5),
  observacoes             TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_cliente ON orders(cliente_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- ── ORDER ITEMS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  produto         VARCHAR(150) NOT NULL,
  quantidade      INTEGER NOT NULL,
  acabamento      VARCHAR(100),
  valor_unitario  NUMERIC(10,4) NOT NULL,
  valor_total     NUMERIC(10,2) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── EXPANDIR ROLES EM USERS ───────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','analyst','gestor','vendedor','atendente','operador','financeiro'));

COMMIT;
