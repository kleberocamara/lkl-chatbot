-- sql/migrations/054_ocr_parcelas.sql
BEGIN;

ALTER TABLE despesas_pendentes_confirmacao DROP COLUMN valor;
ALTER TABLE despesas_pendentes_confirmacao DROP COLUMN vencimento;
ALTER TABLE despesas_pendentes_confirmacao ADD COLUMN parcelas JSONB NOT NULL DEFAULT '[]';
ALTER TABLE despesas_pendentes_confirmacao ADD COLUMN data_entrega DATE;

COMMIT;
