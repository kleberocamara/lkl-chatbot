-- 046_revenda_estrategia.sql — AO-3: estratégia de preço por produto do catálogo
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS tipo_servico  VARCHAR(30);
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS estrategia    VARCHAR(20) NOT NULL DEFAULT 'revenda_matriz'
  CHECK (estrategia IN ('revenda_matriz','interno_m2','manual'));
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS bobina_grupo  VARCHAR(20);
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS preco_m2      NUMERIC(12,4);
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS espaco_corte_cm NUMERIC(6,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS revenda_bobina_grupos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo       VARCHAR(20) NOT NULL,
  largura_cm  NUMERIC(8,2) NOT NULL,
  ativo       BOOLEAN DEFAULT TRUE,
  UNIQUE (grupo, largura_cm)
);
INSERT INTO revenda_bobina_grupos (grupo, largura_cm) VALUES
  ('adesivo',106),('adesivo',127),('adesivo',150),
  ('lona',160),('lona',220),('lona',320)
ON CONFLICT (grupo, largura_cm) DO NOTHING;

ALTER TABLE revenda_categorias ADD COLUMN IF NOT EXISTS sincronizavel BOOLEAN DEFAULT TRUE;
