-- ============================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- This migration adds security at the database level
-- ============================================================

-- Enable RLS on all multi-tenant tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_locks ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- DROP ALL EXISTING POLICIES
-- ============================================================
DROP POLICY IF EXISTS accounts_select_own ON accounts CASCADE;
DROP POLICY IF EXISTS accounts_insert_disabled ON accounts CASCADE;
DROP POLICY IF EXISTS accounts_update_disabled ON accounts CASCADE;
DROP POLICY IF EXISTS accounts_delete_disabled ON accounts CASCADE;

DROP POLICY IF EXISTS prospect_account_select ON prospect_account CASCADE;
DROP POLICY IF EXISTS prospect_account_insert ON prospect_account CASCADE;
DROP POLICY IF EXISTS prospect_account_update ON prospect_account CASCADE;
DROP POLICY IF EXISTS prospect_account_delete ON prospect_account CASCADE;

DROP POLICY IF EXISTS prospects_select ON prospects CASCADE;
DROP POLICY IF EXISTS prospects_insert ON prospects CASCADE;
DROP POLICY IF EXISTS prospects_update ON prospects CASCADE;

DROP POLICY IF EXISTS campaigns_select ON campaigns CASCADE;
DROP POLICY IF EXISTS campaigns_insert ON campaigns CASCADE;
DROP POLICY IF EXISTS campaigns_update ON campaigns CASCADE;
DROP POLICY IF EXISTS campaigns_delete ON campaigns CASCADE;

DROP POLICY IF EXISTS interactions_select ON interactions CASCADE;
DROP POLICY IF EXISTS interactions_insert ON interactions CASCADE;
DROP POLICY IF EXISTS interactions_update ON interactions CASCADE;

DROP POLICY IF EXISTS reminders_select ON reminders CASCADE;
DROP POLICY IF EXISTS reminders_insert ON reminders CASCADE;
DROP POLICY IF EXISTS reminders_update ON reminders CASCADE;

DROP POLICY IF EXISTS prospect_events_select ON prospect_events CASCADE;
DROP POLICY IF EXISTS prospect_events_insert ON prospect_events CASCADE;

DROP POLICY IF EXISTS status_history_select ON status_history CASCADE;
DROP POLICY IF EXISTS status_history_insert ON status_history CASCADE;

DROP POLICY IF EXISTS task_locks_select ON task_locks CASCADE;
DROP POLICY IF EXISTS task_locks_insert ON task_locks CASCADE;
DROP POLICY IF EXISTS task_locks_update ON task_locks CASCADE;

-- Drop old function if it exists
DROP FUNCTION IF EXISTS get_account_id_from_jwt() CASCADE;

-- ============================================================
-- HELPER FUNCTION: Check if current user can access an account
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_account(account_id_to_check UUID)
RETURNS BOOLEAN AS $$
DECLARE
  account_id UUID;
BEGIN
  -- Service role always has access
  IF auth.role() = 'service_role' THEN
    RETURN TRUE;
  END IF;

  -- Try to get account_id from JWT custom claims
  SELECT (auth.jwt() ->> 'account_id')::UUID INTO account_id;

  -- If not in JWT, try to get from session variable (set by API)
  IF account_id IS NULL THEN
    account_id := current_setting('app.account_id', TRUE)::UUID;
  END IF;

  -- Check if the account_id matches
  RETURN account_id = account_id_to_check;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- ACCOUNTS TABLE POLICIES
-- ============================================================
-- Users can only see their own account, or service role can see all
CREATE POLICY accounts_select_own ON accounts
  FOR SELECT
  USING (can_access_account(id));

CREATE POLICY accounts_insert_disabled ON accounts
  FOR INSERT
  WITH CHECK (FALSE);

CREATE POLICY accounts_update_disabled ON accounts
  FOR UPDATE
  USING (FALSE);

CREATE POLICY accounts_delete_disabled ON accounts
  FOR DELETE
  USING (FALSE);

-- ============================================================
-- PROSPECT_ACCOUNT TABLE POLICIES (Junction table)
-- ============================================================
-- Users can only see prospects linked to their account
CREATE POLICY prospect_account_select ON prospect_account
  FOR SELECT
  USING (can_access_account(account_id));

-- Users can only insert for their account
CREATE POLICY prospect_account_insert ON prospect_account
  FOR INSERT
  WITH CHECK (can_access_account(account_id));

-- Users can only update records for their account
CREATE POLICY prospect_account_update ON prospect_account
  FOR UPDATE
  USING (can_access_account(account_id))
  WITH CHECK (can_access_account(account_id));

-- Users can only delete records for their account
CREATE POLICY prospect_account_delete ON prospect_account
  FOR DELETE
  USING (can_access_account(account_id));

-- ============================================================
-- PROSPECTS TABLE POLICIES
-- ============================================================
-- Users can see prospects if they have a prospect_account record, or service role can see all
CREATE POLICY prospects_select ON prospects
  FOR SELECT
  USING (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = prospects.id
      AND can_access_account(pa.account_id)
    )
  );

-- Users can insert prospects (allowed for all authenticated users)
CREATE POLICY prospects_insert ON prospects
  FOR INSERT
  WITH CHECK (TRUE);

-- Users can update prospects if they own them via prospect_account
CREATE POLICY prospects_update ON prospects
  FOR UPDATE
  USING (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = prospects.id
      AND can_access_account(pa.account_id)
    )
  )
  WITH CHECK (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = prospects.id
      AND can_access_account(pa.account_id)
    )
  );

-- ============================================================
-- CAMPAIGNS TABLE POLICIES
-- ============================================================
-- Users can only see campaigns from their account
CREATE POLICY campaigns_select ON campaigns
  FOR SELECT
  USING (can_access_account(account_id));

-- Users can only insert campaigns for their account
CREATE POLICY campaigns_insert ON campaigns
  FOR INSERT
  WITH CHECK (can_access_account(account_id));

-- Users can only update their account's campaigns
CREATE POLICY campaigns_update ON campaigns
  FOR UPDATE
  USING (can_access_account(account_id))
  WITH CHECK (can_access_account(account_id));

-- Users can only delete their account's campaigns
CREATE POLICY campaigns_delete ON campaigns
  FOR DELETE
  USING (can_access_account(account_id));

-- ============================================================
-- INTERACTIONS TABLE POLICIES
-- ============================================================
-- Users can only see interactions for prospects they own
CREATE POLICY interactions_select ON interactions
  FOR SELECT
  USING (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = interactions.prospect_id
      AND can_access_account(pa.account_id)
    )
  );

-- Users can only insert interactions for their account
CREATE POLICY interactions_insert ON interactions
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = interactions.prospect_id
      AND can_access_account(pa.account_id)
    )
  );

-- Users can only update their account's interactions
CREATE POLICY interactions_update ON interactions
  FOR UPDATE
  USING (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = interactions.prospect_id
      AND can_access_account(pa.account_id)
    )
  )
  WITH CHECK (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = interactions.prospect_id
      AND can_access_account(pa.account_id)
    )
  );

-- ============================================================
-- REMINDERS TABLE POLICIES
-- ============================================================
-- Users can only see reminders for prospects they own
CREATE POLICY reminders_select ON reminders
  FOR SELECT
  USING (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = reminders.prospect_id
      AND can_access_account(pa.account_id)
    )
  );

-- Users can only insert reminders for prospects they own
CREATE POLICY reminders_insert ON reminders
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = reminders.prospect_id
      AND can_access_account(pa.account_id)
    )
  );

-- Users can only update their reminders
CREATE POLICY reminders_update ON reminders
  FOR UPDATE
  USING (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = reminders.prospect_id
      AND can_access_account(pa.account_id)
    )
  )
  WITH CHECK (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospect_account pa
      WHERE pa.prospect_id = reminders.prospect_id
      AND can_access_account(pa.account_id)
    )
  );

-- ============================================================
-- PROSPECT_EVENTS TABLE POLICIES
-- ============================================================
-- Users can only see events for their account
CREATE POLICY prospect_events_select ON prospect_events
  FOR SELECT
  USING (can_access_account(account_id));

-- Users can only insert events for their account
CREATE POLICY prospect_events_insert ON prospect_events
  FOR INSERT
  WITH CHECK (can_access_account(account_id));

-- ============================================================
-- STATUS_HISTORY TABLE POLICIES
-- ============================================================
-- Users can only see history for their account
CREATE POLICY status_history_select ON status_history
  FOR SELECT
  USING (can_access_account(account_id));

-- Users can only insert history for their account
CREATE POLICY status_history_insert ON status_history
  FOR INSERT
  WITH CHECK (can_access_account(account_id));

-- ============================================================
-- TASK_LOCKS TABLE POLICIES
-- ============================================================
-- Users can only see locks for their account
CREATE POLICY task_locks_select ON task_locks
  FOR SELECT
  USING (can_access_account(account_id));

-- Users can only insert locks for their account
CREATE POLICY task_locks_insert ON task_locks
  FOR INSERT
  WITH CHECK (can_access_account(account_id));

-- Users can only update their locks
CREATE POLICY task_locks_update ON task_locks
  FOR UPDATE
  USING (can_access_account(account_id))
  WITH CHECK (can_access_account(account_id));

-- ============================================================
-- VERIFICATION: List all policies
-- ============================================================
-- SELECT schemaname, tablename, policyname, permissive, roles, qual, with_check
-- FROM pg_policies
-- ORDER BY tablename, policyname;
