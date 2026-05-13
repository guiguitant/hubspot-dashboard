-- Migration 28: notes append-only par deal (figées après save)
-- Chaque entrée : { at: ISO timestamp, text: string }
ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS notes JSONB NOT NULL DEFAULT '[]'::jsonb;
