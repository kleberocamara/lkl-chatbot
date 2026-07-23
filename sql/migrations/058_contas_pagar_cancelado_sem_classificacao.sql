-- Migration 058: permite cancelar conta a pagar não classificada
-- (ex: boleto indevido de fornecedor bloqueado, ainda em
-- pendente_classificacao) sem forçar escolha de tipo_despesa_id
BEGIN;

ALTER TABLE contas_pagar DROP CONSTRAINT IF EXISTS chk_tipo_despesa_classificado;
ALTER TABLE contas_pagar ADD CONSTRAINT chk_tipo_despesa_classificado
  CHECK (tipo_despesa_id IS NOT NULL OR status IN ('pendente_classificacao', 'cancelado'));

COMMIT;
