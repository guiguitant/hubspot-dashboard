-- Migration 13: Merge prospect_account into prospects
-- Eliminates the junction table — prospects now holds account-specific data directly.
-- CRITICAL: Run as a single transaction. If anything fails, nothing changes.

BEGIN;

-- ============================================================================
-- 1. DROP DEPRECATED COLUMNS from prospects (still present since migration 01)
-- ============================================================================
ALTER TABLE prospects DROP COLUMN IF EXISTS source_campaign_id;
ALTER TABLE prospects DROP COLUMN IF EXISTS notes;

-- ============================================================================
-- 2. ADD COLUMNS from prospect_account into prospects
-- ============================================================================
ALTER TABLE prospects ADD COLUMN account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE prospects ADD COLUMN campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE prospects ADD COLUMN status TEXT DEFAULT 'Nouveau';
ALTER TABLE prospects ADD COLUMN notes TEXT;
ALTER TABLE prospects ADD COLUMN last_contacted_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN added_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================================
-- 3. MIGRATE DATA from prospect_account → prospects
-- ============================================================================
UPDATE prospects p
SET
  account_id       = pa.account_id,
  campaign_id      = pa.campaign_id,
  status           = pa.status,
  notes            = pa.notes,
  last_contacted_at = pa.last_contacted_at,
  added_at         = pa.added_at
FROM prospect_account pa
WHERE pa.prospect_id = p.id;

-- ============================================================================
-- 4. DATA INTEGRITY CHECK — abort if mismatch
-- ============================================================================
DO $$
DECLARE
  v_migrated INT;
  v_pa_count INT;
  v_orphaned INT;
BEGIN
  SELECT COUNT(*) INTO v_migrated FROM prospects WHERE account_id IS NOT NULL;
  SELECT COUNT(*) INTO v_pa_count FROM prospect_account;
  SELECT COUNT(*) INTO v_orphaned FROM prospects WHERE account_id IS NULL;

  IF v_migrated != v_pa_count THEN
    RAISE EXCEPTION 'DATA MISMATCH: % prospects migrated but % prospect_account rows exist', v_migrated, v_pa_count;
  END IF;

  IF v_orphaned > 0 THEN
    RAISE EXCEPTION 'ORPHANED PROSPECTS: % prospects have no prospect_account record', v_orphaned;
  END IF;

  RAISE NOTICE 'Integrity check passed: % rows migrated, 0 orphans', v_migrated;
END $$;

-- ============================================================================
-- 5. ENFORCE NOT NULL on account_id (now safe after integrity check)
-- ============================================================================
ALTER TABLE prospects ALTER COLUMN account_id SET NOT NULL;

-- ============================================================================
-- 6. ADD STATUS CHECK CONSTRAINT (same values as migration 08)
-- ============================================================================
ALTER TABLE prospects ADD CONSTRAINT prospects_status_check CHECK (status IN (
  'Profil à valider',
  'Nouveau',
  'Invitation envoyée',
  'Invitation acceptée',
  'Message à valider',
  'Message à envoyer',
  'Message envoyé',
  'Discussion en cours',
  'Gagné',
  'Perdu',
  'Profil restreint',
  'Non pertinent'
));

-- ============================================================================
-- 7. ADD INDEXES
-- ============================================================================
CREATE INDEX idx_prospects_account_id ON prospects(account_id);
CREATE INDEX idx_prospects_status ON prospects(status);
CREATE INDEX idx_prospects_campaign_id ON prospects(campaign_id);

-- ============================================================================
-- 8. MOVE TRIGGER: stop_sequence_on_reply from prospect_account → prospects
-- ============================================================================
DROP TRIGGER IF EXISTS prospect_reply_stops_sequence ON prospect_account;

-- Recreate function to reference prospects columns (id instead of prospect_id)
CREATE OR REPLACE FUNCTION stop_sequence_on_reply()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('Discussion en cours', 'Gagné', 'Perdu', 'Non pertinent')
     AND OLD.status NOT IN ('Discussion en cours', 'Gagné', 'Perdu', 'Non pertinent') THEN
    UPDATE prospect_sequence_state
    SET status = 'stopped_reply', updated_at = NOW()
    WHERE prospect_id = NEW.id
      AND account_id = NEW.account_id
      AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prospect_reply_stops_sequence
  AFTER UPDATE ON prospects
  FOR EACH ROW EXECUTE FUNCTION stop_sequence_on_reply();

-- ============================================================================
-- 9. UPDATE RLS POLICIES on prospects (simplified — direct account_id check)
-- ============================================================================
DROP POLICY IF EXISTS prospects_select ON prospects;
DROP POLICY IF EXISTS prospects_insert ON prospects;
DROP POLICY IF EXISTS prospects_update ON prospects;
DROP POLICY IF EXISTS prospects_delete ON prospects;

CREATE POLICY prospects_select ON prospects
  FOR SELECT
  USING (auth.role() = 'service_role' OR can_access_account(account_id));

CREATE POLICY prospects_insert ON prospects
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role' OR can_access_account(account_id));

CREATE POLICY prospects_update ON prospects
  FOR UPDATE
  USING (auth.role() = 'service_role' OR can_access_account(account_id))
  WITH CHECK (auth.role() = 'service_role' OR can_access_account(account_id));

CREATE POLICY prospects_delete ON prospects
  FOR DELETE
  USING (auth.role() = 'service_role' OR can_access_account(account_id));

-- ============================================================================
-- 10. UPDATE RLS POLICIES on interactions (replace prospect_account subquery)
-- ============================================================================
DROP POLICY IF EXISTS interactions_select ON interactions;
DROP POLICY IF EXISTS interactions_insert ON interactions;
DROP POLICY IF EXISTS interactions_update ON interactions;

CREATE POLICY interactions_select ON interactions
  FOR SELECT
  USING (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = interactions.prospect_id
      AND can_access_account(p.account_id)
    )
  );

CREATE POLICY interactions_insert ON interactions
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = interactions.prospect_id
      AND can_access_account(p.account_id)
    )
  );

CREATE POLICY interactions_update ON interactions
  FOR UPDATE
  USING (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = interactions.prospect_id
      AND can_access_account(p.account_id)
    )
  )
  WITH CHECK (
    auth.role() = 'service_role' OR
    can_access_account(account_id) OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = interactions.prospect_id
      AND can_access_account(p.account_id)
    )
  );

-- ============================================================================
-- 11. UPDATE RLS POLICIES on reminders (replace prospect_account subquery)
-- ============================================================================
DROP POLICY IF EXISTS reminders_select ON reminders;
DROP POLICY IF EXISTS reminders_insert ON reminders;
DROP POLICY IF EXISTS reminders_update ON reminders;

CREATE POLICY reminders_select ON reminders
  FOR SELECT
  USING (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = reminders.prospect_id
      AND can_access_account(p.account_id)
    )
  );

CREATE POLICY reminders_insert ON reminders
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = reminders.prospect_id
      AND can_access_account(p.account_id)
    )
  );

CREATE POLICY reminders_update ON reminders
  FOR UPDATE
  USING (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = reminders.prospect_id
      AND can_access_account(p.account_id)
    )
  )
  WITH CHECK (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM prospects p
      WHERE p.id = reminders.prospect_id
      AND can_access_account(p.account_id)
    )
  );

-- ============================================================================
-- 12. DROP prospect_account TABLE (all data has been migrated)
-- ============================================================================
DROP TABLE prospect_account CASCADE;

COMMIT;
