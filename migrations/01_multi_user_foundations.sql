-- Sprint 0: Multi-User Foundations for Releaf Prospector
-- This migration transforms the app from single-user to 3-user architecture
-- CRITICAL: Execute as a single atomic transaction. If it fails, nothing changes.

BEGIN;

-- ============================================================================
-- 1. CREATE accounts TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  email TEXT,
  chrome_profile_linkedin TEXT,
  chrome_profile_salesnav TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed data: 3 accounts
INSERT INTO accounts (name, slug, email, chrome_profile_linkedin, chrome_profile_salesnav)
VALUES
  ('Nathan Gourdin', 'nathan', 'nathan@releafcarbon.com', 'N', 'Sales_nav'),
  ('Guillaume', 'guillaume', NULL, 'Guillaume', 'Sales_nav_Guillaume'),
  ('Vincent Mory', 'vincent', NULL, 'Vincent', NULL)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- 2. CREATE prospect_account TABLE (junction table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS prospect_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'Nouveau',
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  notes TEXT,
  last_contacted_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(prospect_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_prospect_account_prospect_id ON prospect_account(prospect_id);
CREATE INDEX IF NOT EXISTS idx_prospect_account_account_id ON prospect_account(account_id);
CREATE INDEX IF NOT EXISTS idx_prospect_account_status ON prospect_account(status);

-- ============================================================================
-- 3. CREATE task_locks TABLE (prevent concurrent task execution)
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_type TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id),
  locked_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  task_name TEXT,
  UNIQUE(lock_type)
);

CREATE INDEX IF NOT EXISTS idx_task_locks_lock_type ON task_locks(lock_type);
CREATE INDEX IF NOT EXISTS idx_task_locks_expires_at ON task_locks(expires_at);

-- ============================================================================
-- 4. ADD account_id COLUMNS TO EXISTING TABLES
-- ============================================================================
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);
ALTER TABLE prospect_events ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);
ALTER TABLE status_history ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id);

CREATE INDEX IF NOT EXISTS idx_campaigns_account_id ON campaigns(account_id);
CREATE INDEX IF NOT EXISTS idx_interactions_account_id ON interactions(account_id);
CREATE INDEX IF NOT EXISTS idx_prospect_events_account_id ON prospect_events(account_id);
CREATE INDEX IF NOT EXISTS idx_status_history_account_id ON status_history(account_id);

-- ============================================================================
-- 5. MIGRATE EXISTING DATA TO NATHAN ACCOUNT
-- ============================================================================
-- Get Nathan's account ID
DO $$
DECLARE
  nathan_id UUID;
BEGIN
  SELECT id INTO nathan_id FROM accounts WHERE slug = 'nathan';

  -- Migrate all existing campaigns to Nathan
  UPDATE campaigns
  SET account_id = nathan_id
  WHERE account_id IS NULL;

  -- Migrate all existing interactions to Nathan
  UPDATE interactions
  SET account_id = nathan_id
  WHERE account_id IS NULL;

  -- Migrate all existing prospect_events to Nathan
  UPDATE prospect_events
  SET account_id = nathan_id
  WHERE account_id IS NULL;

  -- Migrate all existing status_history to Nathan
  UPDATE status_history
  SET account_id = nathan_id
  WHERE account_id IS NULL;

  -- Migrate all prospects to prospect_account (Nathan's account)
  INSERT INTO prospect_account (prospect_id, account_id, status, campaign_id, notes, last_contacted_at, added_at)
  SELECT
    p.id,
    nathan_id,
    COALESCE(p.status, 'Nouveau'),
    p.source_campaign_id,
    NULL,  -- notes not available in prospects table
    NULL,  -- last_contacted_at not available in prospects table
    p.created_at
  FROM prospects p
  WHERE NOT EXISTS (
    SELECT 1 FROM prospect_account
    WHERE prospect_id = p.id AND account_id = nathan_id
  )
  ON CONFLICT (prospect_id, account_id) DO NOTHING;

END $$;

-- ============================================================================
-- 6. MARK COLUMNS AS DEPRECATED (comment-based)
-- ============================================================================
COMMENT ON COLUMN prospects.status IS 'DEPRECATED - Use prospect_account.status instead';
COMMENT ON COLUMN prospects.source_campaign_id IS 'DEPRECATED - Use prospect_account.campaign_id instead';
COMMENT ON COLUMN prospects.notes IS 'DEPRECATED - Use prospect_account.notes instead';

-- ============================================================================
-- 7. CREATE TASK LOCK MANAGEMENT FUNCTIONS
-- ============================================================================
CREATE OR REPLACE FUNCTION acquire_task_lock(
  p_lock_type TEXT,
  p_account_id UUID,
  p_task_name TEXT,
  p_duration_minutes INT DEFAULT 60
) RETURNS BOOLEAN AS $$
BEGIN
  -- Clean up expired locks
  DELETE FROM task_locks WHERE expires_at < NOW();

  -- Try to insert the lock
  BEGIN
    INSERT INTO task_locks (lock_type, account_id, task_name, expires_at)
    VALUES (p_lock_type, p_account_id, p_task_name, NOW() + (p_duration_minutes || ' minutes')::interval);
    RETURN TRUE;
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_task_lock(
  p_lock_type TEXT,
  p_account_id UUID
) RETURNS VOID AS $$
BEGIN
  DELETE FROM task_locks
  WHERE lock_type = p_lock_type AND account_id = p_account_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;
