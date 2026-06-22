-- Migration 014: Unificação do fluxo de status de orçamentos
-- Novos status: em_orcamento, em_revisao, concluido, enviado, aprovado, reprovado, cancelado
-- Token para link de aprovação por e-mail
-- Tabela de confirmação pendente via WhatsApp

BEGIN;

-- 1. Remover constraint de status existente
ALTER TABLE orcamentos DROP CONSTRAINT IF EXISTS orcamentos_status_check;

-- 2. Adicionar novos status ao tipo / check
ALTER TABLE orcamentos
  ADD CONSTRAINT orcamentos_status_check
  CHECK (status IN (
    'rascunho',          -- legado (congelado)
    'aprovado_interno',  -- legado (congelado)
    'em_orcamento',      -- novo: aberto aguardando montagem
    'em_revisao',        -- novo: criado pelo sistema, aguarda revisão humana
    'concluido',         -- novo: revisado, pronto para enviar
    'enviado',           -- novo: enviado ao cliente (WA + email)
    'aprovado',          -- cliente aprovou
    'reprovado',         -- cliente reprovou
    'cancelado'          -- cancelado internamente
  ));

-- 3. Token UUID para link de aprovação por e-mail
ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS token_aprovacao UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS enviado_em      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reprovado_em    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reprovado_via   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS concluido_em    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS concluido_por   UUID REFERENCES users(id);

-- Preencher token para orçamentos que ainda não têm
UPDATE orcamentos SET token_aprovacao = gen_random_uuid()
WHERE token_aprovacao IS NULL;

-- 4. Tabela de confirmação pendente via WhatsApp
CREATE TABLE IF NOT EXISTS orcamento_confirmacao_wa (
  phone                   VARCHAR(20) PRIMARY KEY,
  orcamento_id            UUID NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour',
  aguardando_confirmacao  BOOLEAN NOT NULL DEFAULT FALSE,
  ultima_intencao         VARCHAR(10)  -- 'aprovado' ou 'reprovado'
);

COMMIT;
