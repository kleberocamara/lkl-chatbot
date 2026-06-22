-- Migration 017: categoria, qt_embalagem, estoque_maximo na tabela materiais
ALTER TABLE materiais
  ADD COLUMN IF NOT EXISTS categoria      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS qt_embalagem   NUMERIC(10,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estoque_maximo NUMERIC(10,3) DEFAULT 0;
