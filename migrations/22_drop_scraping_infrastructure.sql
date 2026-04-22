-- Migration 22 — Drop Task 1 scraping infrastructure (leftover from migrations 10, 20)
--
-- Context: Task 1 (LinkedIn Sales Navigator DOM scraping) was removed in app code
-- commits 0a7167d (backend) and ffe0403 (frontend) on 2026-04-20. The DB artifacts
-- stayed in place. This migration drops them.
--
-- Safe to run: no code references remain (confirmed by audit 2026-04-22).
-- Reversible via migrations 10 + 20 if Task 1 is ever reintroduced.

-- 1. Drop the Task 1 execution reports table (was populated by now-removed
--    POST /api/scraping/summary endpoint)
DROP TABLE IF EXISTS scraping_summaries;

-- 2. Drop the scrapping_attempts column (typo is historical — kept matching
--    migration 20's naming). Nothing reads or writes it after Task 1 removal.
ALTER TABLE prospects DROP COLUMN IF EXISTS scrapping_attempts;

-- 3. Drop the index on scrapping_pending status (from migration 20).
--    The status value itself stays in the CHECK constraint — legacy prospects
--    in this state still exist and are handled by the UI / purge script.
DROP INDEX IF EXISTS idx_prospects_scrapping_pending;
