-- Migration 12 — Drop deprecated columns from prospects table
-- These columns were deprecated in migration 01 in favor of prospect_account table.
-- source of truth: prospect_account.status (not prospects.status)

-- Drop status column (deprecated since migration 01, now fully replaced by prospect_account.status)
ALTER TABLE prospects DROP COLUMN IF EXISTS status;

-- Note: source_campaign_id and notes are also deprecated (migration 01)
-- but kept for now until confirmed unused by all external integrations.
-- ALTER TABLE prospects DROP COLUMN IF EXISTS source_campaign_id;
-- ALTER TABLE prospects DROP COLUMN IF EXISTS notes;
