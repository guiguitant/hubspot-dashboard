-- Migration: Scenarios financiers
-- A executer dans le SQL Editor de Supabase

CREATE TABLE scenarios (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  nom TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE scenario_overrides (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('salaire', 'pipeline', 'charges_fixes', 'revenu_exceptionnel')),
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_scenario_overrides_scenario ON scenario_overrides(scenario_id);

-- Enable RLS (Row Level Security) - open access like other tables
ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on scenarios" ON scenarios FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on scenario_overrides" ON scenario_overrides FOR ALL USING (true) WITH CHECK (true);
