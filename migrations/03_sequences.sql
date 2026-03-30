-- Sprint 1 — Sequences and Steps
-- This migration adds the sequences feature for LinkedIn outreach campaigns

BEGIN;

-- ============================================================================
-- 1. CREATE sequences TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS sequences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id),
  version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL DEFAULT 'Séquence principale',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sequences_campaign_id ON sequences(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sequences_active_version ON sequences(campaign_id) WHERE is_active = true;

-- ============================================================================
-- 2. CREATE sequence_steps TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS sequence_steps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('send_invitation', 'send_message')),
  delay_days INTEGER NOT NULL DEFAULT 0,
  icebreaker_mode TEXT CHECK (icebreaker_mode IN ('auto', 'generic')) DEFAULT 'generic',
  has_note BOOLEAN NOT NULL DEFAULT false,
  note_content TEXT DEFAULT NULL,
  message_mode TEXT CHECK (message_mode IN ('manual', 'ai_generated')) DEFAULT NULL,
  message_content TEXT DEFAULT NULL,
  message_params JSONB DEFAULT NULL,
  message_label TEXT DEFAULT NULL,
  selected_message TEXT DEFAULT NULL,
  selected_mode TEXT CHECK (selected_mode IN ('manual', 'ai_generated')) DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_step_order UNIQUE (sequence_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence_id ON sequence_steps(sequence_id);

-- ============================================================================
-- 3. CREATE placeholders TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS placeholders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'prospect',
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO placeholders (key, label, description, source, is_system) VALUES
  ('prospect_first_name', 'Prénom du prospect', 'Prénom LinkedIn du prospect', 'prospect', true),
  ('prospect_last_name', 'Nom du prospect', 'Nom de famille LinkedIn du prospect', 'prospect', true),
  ('prospect_company', 'Entreprise du prospect', 'Nom de l''entreprise du prospect', 'prospect', true),
  ('prospect_job_title', 'Poste du prospect', 'Intitulé de poste du prospect', 'prospect', true),
  ('user_first_name', 'Mon prénom', 'Prénom de l''expéditeur', 'user', true),
  ('campaign_name', 'Nom de la campagne', 'Nom de la campagne active', 'campaign', true),
  ('icebreaker', 'Icebreaker', 'Phrase d''accroche basée sur l''activité LinkedIn du prospect (générée automatiquement à l''exécution)', 'prospect', true)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 4. CREATE TRIGGERS for updated_at columns
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sequences_updated_at ON sequences;
CREATE TRIGGER sequences_updated_at BEFORE UPDATE ON sequences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS sequence_steps_updated_at ON sequence_steps;
CREATE TRIGGER sequence_steps_updated_at BEFORE UPDATE ON sequence_steps FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
