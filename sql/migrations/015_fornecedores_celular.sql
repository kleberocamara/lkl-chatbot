-- Migration 015: adiciona coluna celular à tabela fornecedores
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS celular VARCHAR(20);
