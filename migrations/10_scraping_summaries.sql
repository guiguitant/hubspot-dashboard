-- Migration 10: Scraping summaries
-- Stores the structured report of each Task 1 (Sales Navigator scraping) execution run

CREATE TABLE scraping_summaries (
  id                          UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id                  UUID         NOT NULL REFERENCES accounts(id),
  ran_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  duration_seconds            INTEGER,
  campaigns_processed         INTEGER      NOT NULL DEFAULT 0,
  profiles_found              INTEGER      NOT NULL DEFAULT 0,
  profiles_rejected_duplicates INTEGER     NOT NULL DEFAULT 0,
  profiles_rejected_excluded  INTEGER      NOT NULL DEFAULT 0,
  profiles_submitted          INTEGER      NOT NULL DEFAULT 0,
  stopped_reason              TEXT,        -- NULL = normal, 'rate_limited', 'session_expired'
  errors                      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE scraping_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "scraping_summaries_account_isolation"
  ON scraping_summaries
  FOR ALL
  USING (account_id::text = current_setting('app.current_account_id', true));
