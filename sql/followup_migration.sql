-- Migração: Sistema de Follow-up de Orçamentos
-- Executar: psql -U lkl_user -d lkl_chatbot -f sql/followup_migration.sql

-- Novos status permitidos para conversations
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('active', 'aguardando_humano', 'orcamento_enviado', 'orcamento_sem_retorno', 'resolved', 'closed'));

-- Campos de controle de orçamento
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS orcamento_enviado_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follow_up_count INTEGER DEFAULT 0;

-- Tabela de follow-ups agendados
CREATE TABLE IF NOT EXISTS follow_ups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 5),
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled ON follow_ups(scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_follow_ups_conversation ON follow_ups(conversation_id);
