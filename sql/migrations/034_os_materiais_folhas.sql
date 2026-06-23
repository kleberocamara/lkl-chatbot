-- Especificação Papel: folhas a cortar, % de perda e folhas total após o corte (por via)
ALTER TABLE os_materiais ADD COLUMN IF NOT EXISTS folhas_a_cortar   INTEGER;
ALTER TABLE os_materiais ADD COLUMN IF NOT EXISTS perda_percentual  NUMERIC(5,2);
ALTER TABLE os_materiais ADD COLUMN IF NOT EXISTS folhas_total      INTEGER;
