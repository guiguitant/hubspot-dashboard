-- Migration 20: New scraping workflow — statuses, attempts counter, extended summaries
-- Supports the Phase 1 (bulk extract) → Phase 2 (individual visits) workflow

-- 1. Add scrapping_attempts counter to prospects (for soupape: 3 failed visits → "À compléter")
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS scrapping_attempts INTEGER NOT NULL DEFAULT 0;

-- 2. Extend scraping_summaries with detailed counters
ALTER TABLE scraping_summaries
  ADD COLUMN IF NOT EXISTS profiles_created          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profiles_created_complete  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profiles_created_partial   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profiles_enriched          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profile_visits_sn          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cooldown_triggered         BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Index for fast lookup of scrapping_pending profiles per campaign
CREATE INDEX IF NOT EXISTS idx_prospects_scrapping_pending
  ON prospects(account_id, campaign_id) WHERE status = 'scrapping_pending';
