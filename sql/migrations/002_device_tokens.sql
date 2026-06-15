BEGIN;

CREATE TABLE IF NOT EXISTS device_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  platform   VARCHAR(20) DEFAULT 'web' CHECK (platform IN ('web', 'android', 'ios')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

COMMIT;
