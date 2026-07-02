-- 047_revenda_compras.sql — AO-4b terceirização (compras na revenda)
CREATE SEQUENCE IF NOT EXISTS revenda_compra_seq START 1;

CREATE TABLE IF NOT EXISTS revenda_compras (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                INTEGER NOT NULL DEFAULT nextval('revenda_compra_seq'),
  status                VARCHAR(20) NOT NULL DEFAULT 'pedido_feito'
                        CHECK (status IN ('pedido_feito','recebido')),
  pedido_graficonauta   VARCHAR(60),
  cliente_id            UUID REFERENCES clientes_lkl(id) ON DELETE SET NULL,
  previsao_entrega      DATE,
  observacao            TEXT,
  responsavel_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  os_entrega_id         UUID REFERENCES ordens_servico(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  recebido_em           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS revenda_compra_itens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id         UUID NOT NULL REFERENCES revenda_compras(id) ON DELETE CASCADE,
  orcamento_item_id UUID NOT NULL REFERENCES orcamento_itens(id) ON DELETE CASCADE,
  UNIQUE (orcamento_item_id)
);
CREATE INDEX IF NOT EXISTS idx_revenda_compra_itens_compra ON revenda_compra_itens(compra_id);
