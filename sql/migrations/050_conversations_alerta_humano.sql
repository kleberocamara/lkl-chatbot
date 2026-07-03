-- Alerta de conversa parada em aguardando_humano: flag para disparar o push uma vez por parada.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS alerta_humano_em TIMESTAMPTZ;
