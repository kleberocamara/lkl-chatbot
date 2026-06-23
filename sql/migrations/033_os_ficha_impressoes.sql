-- Ficha de produção: nº do formato de corte (tier) e total de impressões
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS formato_corte    INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS total_impressoes INTEGER;
