-- Migration: add tasks column to deal_metadata (file de tâches par deal)
-- Run this SQL in your Supabase SQL Editor (https://supabase.com/dashboard)

ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS tasks JSONB DEFAULT '[]'::jsonb;

-- Structure d'une tâche (jsonb) :
-- {
--   "id":         "<id unique>",
--   "type":       "call" | "email" | "proposal" | "meeting" | "contract" | "custom",
--   "label":      "texte libre (optionnel)",
--   "due_at":     "ISO8601 | null",
--   "status":     "todo" | "done",
--   "created_at": "ISO8601",
--   "done_at":    "ISO8601 | null"
-- }
