-- Chatbot: flag para reengajar uma conversa parada em aguardando_humano (auto-liberação após 2 dias).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS reengajado_em TIMESTAMPTZ;
