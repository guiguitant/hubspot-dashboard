-- Migration: Create prospect_emails table for prospection inbox
-- Run this SQL in your Supabase SQL Editor (https://supabase.com/dashboard)

CREATE TABLE IF NOT EXISTS prospect_emails (
  id SERIAL PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  date TIMESTAMPTZ NOT NULL,
  body_preview TEXT DEFAULT '',
  category TEXT DEFAULT 'a_qualifier',
  manual_override BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE prospect_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON prospect_emails FOR ALL USING (true) WITH CHECK (true);
