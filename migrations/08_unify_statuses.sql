-- Migration 08: Unify statuses for sequence-driven workflow
-- - Replace "Réponse reçue" and "RDV planifié" with "Discussion en cours"
-- - Add "Gagné" status
-- - Update trigger to stop sequence on "Discussion en cours"
-- - Update prospect_account status constraint

BEGIN;

-- ============================================================================
-- 1. MIGRATE EXISTING DATA to new statuses
-- ============================================================================
UPDATE prospect_account SET status = 'Discussion en cours' WHERE status = 'Réponse reçue';
UPDATE prospect_account SET status = 'Discussion en cours' WHERE status = 'RDV planifié';

-- ============================================================================
-- 2. UPDATE STATUS CHECK CONSTRAINT on prospect_account
-- ============================================================================
-- Drop existing constraint if it exists (name may vary)
DO $$
BEGIN
  ALTER TABLE prospect_account DROP CONSTRAINT IF EXISTS prospect_account_status_check;
  ALTER TABLE prospect_account DROP CONSTRAINT IF EXISTS prospect_account_status_chk;
EXCEPTION WHEN OTHERS THEN
  NULL; -- No constraint to drop, continue
END $$;

-- Add new constraint with updated statuses
ALTER TABLE prospect_account ADD CONSTRAINT prospect_account_status_check
  CHECK (status IN (
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
-- 3. UPDATE TRIGGER: Stop sequence on "Discussion en cours" (was "Réponse reçue")
-- ============================================================================
CREATE OR REPLACE FUNCTION stop_sequence_on_reply()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('Discussion en cours', 'Gagné', 'Perdu', 'Non pertinent')
     AND OLD.status NOT IN ('Discussion en cours', 'Gagné', 'Perdu', 'Non pertinent') THEN
    UPDATE prospect_sequence_state
    SET status = 'stopped_reply', updated_at = NOW()
    WHERE prospect_id = NEW.prospect_id
      AND account_id = NEW.account_id
      AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
