-- Persist repeat section state (dismissed, contacts, deals, notes) per user
-- Replaces localStorage so data survives private browsing and is shared cross-device

CREATE TABLE IF NOT EXISTS repeat_state (
  user_key  TEXT PRIMARY KEY,           -- 'Guillaume' | 'Nathan' | 'Vincent'
  dismissed JSONB NOT NULL DEFAULT '{}',
  contacts  JSONB NOT NULL DEFAULT '{}',
  deals     JSONB NOT NULL DEFAULT '{}',
  notes     JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed rows so a GET never returns 404 for known users
INSERT INTO repeat_state (user_key) VALUES ('Guillaume'), ('Nathan'), ('Vincent')
  ON CONFLICT (user_key) DO NOTHING;
