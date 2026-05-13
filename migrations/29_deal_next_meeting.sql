-- Migration 29: date du prochain rendez-vous par deal
-- Un RDV futur retire l'état "critique" sur le Kanban (cf. computeDealCriticality côté front)
ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS next_meeting_at TIMESTAMPTZ;
