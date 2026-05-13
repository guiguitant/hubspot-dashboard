-- Migration 27: historique des relances commerciales par deal
-- Chaque entrée : { type: 'email' | 'phone', at: ISO timestamp, note: string }
ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS relances JSONB NOT NULL DEFAULT '[]'::jsonb;
