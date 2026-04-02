-- Migration 09: Dispatch summaries
-- Stores the structured report of each Task 2 execution run

CREATE TABLE dispatch_summaries (
  id                        UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id                UUID         NOT NULL REFERENCES accounts(id),
  ran_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  duration_seconds          INTEGER,
  invitations_sent          INTEGER      NOT NULL DEFAULT 0,
  invitations_accepted      INTEGER      NOT NULL DEFAULT 0,
  messages_submitted        INTEGER      NOT NULL DEFAULT 0,
  messages_sent             INTEGER      NOT NULL DEFAULT 0,
  replies_detected          INTEGER      NOT NULL DEFAULT 0,
  quota_invitations_remaining INTEGER,
  quota_messages_remaining    INTEGER,
  stopped_reason            TEXT,        -- NULL = normal, 'rate_limited', 'session_expired', 'quota_reached'
  errors                    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE dispatch_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_summaries_account_isolation"
  ON dispatch_summaries
  FOR ALL
  USING (account_id::text = current_setting('app.current_account_id', true));
