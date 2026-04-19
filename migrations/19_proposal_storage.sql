-- Migration 19: stockage propale dans Supabase Storage
ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS proposal_storage_path TEXT;
