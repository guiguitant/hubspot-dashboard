-- Migration 11: deal_metadata
-- Stores local metadata per deal (tags, proposal sent date)
-- deal_id is the HubSpot deal ID (string)

CREATE TABLE IF NOT EXISTS deal_metadata (
  deal_id        TEXT PRIMARY KEY,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  proposal_sent_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
