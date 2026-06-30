-- 044_revenda_catalogo.sql — AO-2a catálogo de revenda (Graficonauta)
CREATE TABLE IF NOT EXISTS revenda_categorias (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          VARCHAR(150) NOT NULL,
  url           TEXT NOT NULL,
  ativo         BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS revenda_produtos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             VARCHAR(40) UNIQUE NOT NULL,
  nome            VARCHAR(200) NOT NULL,
  categoria_id    UUID REFERENCES revenda_categorias(id) ON DELETE SET NULL,
  url             TEXT,
  tamanho         VARCHAR(60),
  cores           VARCHAR(20),
  gramatura       VARCHAR(40),
  ativo           BOOLEAN DEFAULT TRUE,
  sincronizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_revenda_produtos_categoria ON revenda_produtos(categoria_id);

CREATE TABLE IF NOT EXISTS revenda_precos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id    UUID NOT NULL REFERENCES revenda_produtos(id) ON DELETE CASCADE,
  quantidade    INTEGER NOT NULL,
  prazo_horas   INTEGER NOT NULL,
  preco_total   NUMERIC(12,2) NOT NULL,
  UNIQUE (produto_id, quantidade, prazo_horas)
);
CREATE INDEX IF NOT EXISTS idx_revenda_precos_produto ON revenda_precos(produto_id);

CREATE TABLE IF NOT EXISTS revenda_acabamentos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id       UUID NOT NULL REFERENCES revenda_produtos(id) ON DELETE CASCADE,
  nome             VARCHAR(150) NOT NULL,
  preco            NUMERIC(12,2) NOT NULL,
  tipo             VARCHAR(20) NOT NULL CHECK (tipo IN ('acabamento','servico')),
  prazo_extra_dias INTEGER DEFAULT 0,
  UNIQUE (produto_id, nome)
);

CREATE TABLE IF NOT EXISTS revenda_sync_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iniciado_em   TIMESTAMPTZ DEFAULT NOW(),
  finalizado_em TIMESTAMPTZ,
  status        VARCHAR(20) DEFAULT 'rodando' CHECK (status IN ('rodando','ok','erro')),
  produtos_atualizados INTEGER DEFAULT 0,
  erro          TEXT
);

CREATE TABLE IF NOT EXISTS revenda_config (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  markup_percent NUMERIC(6,2) DEFAULT 0,
  prazo_padrao_horas INTEGER DEFAULT 24,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO revenda_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
