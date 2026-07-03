-- AO-4c: vincula a compra na revenda à conta a pagar gerada.
BEGIN;

ALTER TABLE revenda_compras
  ADD COLUMN IF NOT EXISTS valor_compra   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS conta_pagar_id INTEGER
    REFERENCES contas_pagar(id) ON DELETE SET NULL;

COMMIT;
