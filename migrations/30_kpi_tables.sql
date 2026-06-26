-- Migration 30 : tables KPI (objectifs individuels + répartition CA par partner)
-- Alimentent l'onglet KPI du dashboard Pilot.
-- Pattern RLS identique à scenarios (mono-tenant, accès ouvert ; l'accès est déjà
-- gaté en amont par l'auth dashboard TOTP côté serveur).

CREATE TABLE kpi_objectives (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  partner TEXT NOT NULL,
  year INT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('newsale','upsale','opere')),
  montant NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (partner, year, type)
);

CREATE TABLE kpi_ca_split (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  mission_id TEXT NOT NULL,
  axis TEXT NOT NULL CHECK (axis IN ('commercial','operationnel')),
  partner TEXT NOT NULL,
  pct NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (mission_id, axis, partner)
);

CREATE INDEX idx_kpi_objectives_year ON kpi_objectives(year);
CREATE INDEX idx_kpi_ca_split_mission ON kpi_ca_split(mission_id);

ALTER TABLE kpi_objectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpi_ca_split  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on kpi_objectives" ON kpi_objectives FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on kpi_ca_split"  ON kpi_ca_split  FOR ALL USING (true) WITH CHECK (true);
