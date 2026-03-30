-- Sprint 2 — Sequence Execution Engine
-- Tracks prospect progress through sequences and manages LinkedIn activity scraping

BEGIN;

-- ============================================================================
-- 1. CREATE prospect_sequence_state TABLE
-- ============================================================================
-- Tracks where each prospect is in their sequence (current step, status, next action date)
CREATE TABLE IF NOT EXISTS prospect_sequence_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  current_step_order INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'stopped_reply', 'paused')),
  next_action_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  last_action_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(prospect_id, sequence_id)
);

CREATE INDEX IF NOT EXISTS idx_pss_account_due ON prospect_sequence_state(account_id, next_action_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pss_prospect ON prospect_sequence_state(prospect_id);
CREATE INDEX IF NOT EXISTS idx_pss_sequence ON prospect_sequence_state(sequence_id);

-- ============================================================================
-- 2. CREATE prospect_activity TABLE
-- ============================================================================
-- Caches LinkedIn activity/posts for icebreaker generation
CREATE TABLE IF NOT EXISTS prospect_activity (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  raw_posts JSONB,         -- [{ "text": "...", "date": "...", "engagement": 123 }, ...]
  icebreaker_generated TEXT,
  icebreaker_mode TEXT CHECK (icebreaker_mode IN ('personalized', 'generic')),
  is_relevant BOOLEAN,
  UNIQUE(prospect_id)
);

CREATE INDEX IF NOT EXISTS idx_prospect_activity_prospect ON prospect_activity(prospect_id);

-- ============================================================================
-- 3. CREATE TRIGGER: Stop sequence on reply
-- ============================================================================
-- When prospect_account.status changes to 'Réponse reçue', automatically stop active sequence
CREATE OR REPLACE FUNCTION stop_sequence_on_reply()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'Réponse reçue' AND OLD.status != 'Réponse reçue' THEN
    UPDATE prospect_sequence_state
    SET status = 'stopped_reply', updated_at = NOW()
    WHERE prospect_id = NEW.prospect_id
      AND account_id = NEW.account_id
      AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prospect_reply_stops_sequence ON prospect_account;
CREATE TRIGGER prospect_reply_stops_sequence
  AFTER UPDATE ON prospect_account
  FOR EACH ROW EXECUTE FUNCTION stop_sequence_on_reply();

-- ============================================================================
-- 4. CREATE TRIGGER: updated_at for prospect_sequence_state
-- ============================================================================
DROP TRIGGER IF EXISTS pss_updated_at ON prospect_sequence_state;
CREATE TRIGGER pss_updated_at
  BEFORE UPDATE ON prospect_sequence_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
