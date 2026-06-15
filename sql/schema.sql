-- LKL Gráfica — Schema do banco de dados
-- Executar: psql -U lkl_user -d lkl_chatbot -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Contatos (clientes do WhatsApp)
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255),
  profile_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  total_conversations INTEGER DEFAULT 0,
  last_contact TIMESTAMPTZ
);

-- Conversas
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'aguardando_humano', 'resolved', 'closed')),
  assigned_to UUID,        -- analista responsável
  started_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  summary TEXT,            -- resumo gerado pela IA
  ai_context JSONB DEFAULT '[]', -- histórico de contexto da IA
  service_type VARCHAR(100),    -- tipo de serviço detectado
  needs_details JSONB DEFAULT '{}' -- detalhes capturados
);

-- Mensagens
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES conversations(id),
  contact_id UUID REFERENCES contacts(id),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text',
  whatsapp_message_id VARCHAR(100),
  sent_by VARCHAR(20) DEFAULT 'ai' CHECK (sent_by IN ('ai', 'human', 'system')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

-- Usuários do painel
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

-- Logs de atividade
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type VARCHAR(50) NOT NULL,
  description TEXT,
  contact_id UUID REFERENCES contacts(id),
  conversation_id UUID REFERENCES conversations(id),
  user_id UUID REFERENCES users(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Configurações do sistema
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT,
  description VARCHAR(255),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices de performance
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at);

-- Configurações padrão
INSERT INTO settings (key, value, description) VALUES
  ('agent_prompt', 'Você é o assistente virtual da LKL Gráfica. Atenda com simpatia, em português brasileiro. Colete informações detalhadas sobre o pedido do cliente.', 'Prompt base do agente IA'),
  ('business_hours_start', '08', 'Início do horário de atendimento'),
  ('business_hours_end', '18', 'Fim do horário de atendimento'),
  ('welcome_message', 'Olá! 👋 Sou o assistente virtual da *LKL Gráfica*. Como posso ajudar você hoje?', 'Mensagem de boas-vindas'),
  ('out_of_hours_message', 'Olá! Nosso atendimento humano funciona das 8h às 18h. Mas pode me contar o que precisa — vou registrar tudo para nossa equipe retornar assim que possível! 😊', 'Mensagem fora do horário')
ON CONFLICT (key) DO NOTHING;
