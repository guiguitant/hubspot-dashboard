-- Migration 18: enrichissement deal_metadata avec infos propale générée
ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS proposal_mission TEXT,
  ADD COLUMN IF NOT EXISTS proposal_nom     TEXT;
