-- Migration 07: Supabase Magic Link Authentication
-- Add email and is_admin columns to accounts table

BEGIN;

-- Add email column (UNIQUE, required for Magic Link)
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

-- Add is_admin column (determines if user can switch accounts)
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- Create index for email lookups (performance)
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

COMMIT;
