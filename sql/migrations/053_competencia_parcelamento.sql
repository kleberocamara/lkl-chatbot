-- sql/migrations/053_competencia_parcelamento.sql
-- Adiciona regime de competência (DRE) e parcelamento de despesas a contas_pagar.
-- competencia: mês/data em que a despesa é reconhecida no DRE, independente de já
-- ter sido paga. parcela_grupo_id/numero/total: só preenchidos quando a conta faz
-- parte de uma compra parcelada em N contas a pagar distintas.

BEGIN;

ALTER TABLE contas_pagar ADD COLUMN competencia DATE;
ALTER TABLE contas_pagar ADD COLUMN parcela_grupo_id UUID;
ALTER TABLE contas_pagar ADD COLUMN parcela_numero SMALLINT;
ALTER TABLE contas_pagar ADD COLUMN parcela_total SMALLINT;

-- Backfill: contas já existentes usam a data de criação como competência
-- (correto inclusive para recorrentes: cada mês de aluguel É uma despesa nova naquele mês).
UPDATE contas_pagar SET competencia = created_at::date WHERE competencia IS NULL;

ALTER TABLE contas_pagar ALTER COLUMN competencia SET NOT NULL;
ALTER TABLE contas_pagar ALTER COLUMN competencia SET DEFAULT CURRENT_DATE;

CREATE INDEX idx_contas_pagar_competencia ON contas_pagar(competencia);
CREATE INDEX idx_contas_pagar_parcela_grupo ON contas_pagar(parcela_grupo_id) WHERE parcela_grupo_id IS NOT NULL;

COMMIT;
