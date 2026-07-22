-- Migration 32 : module Immobilisations (Phase 5 refonte Pilot)
-- Table mono-locataire (dashboard Releaf uniquement), pattern RLS identique a scenarios / kpi_*
-- (acces ouvert ; la protection reelle vient de l'auth dashboard TOTP cote serveur, dashboardGate).
-- APPLICATION MANUELLE : coller ce fichier dans le SQL Editor Supabase et cliquer "Run".

CREATE TABLE IF NOT EXISTS immobilisations (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  libelle               TEXT NOT NULL,
  montant               NUMERIC NOT NULL DEFAULT 0,          -- base amortissable (HT)
  date_mise_en_service  DATE NOT NULL,
  duree_annees          NUMERIC NOT NULL DEFAULT 5,          -- duree d'amortissement (parametrable par immo)
  methode               TEXT NOT NULL DEFAULT 'lineaire' CHECK (methode IN ('lineaire')),
  -- traitement au cas par cas : immobiliser (amortissable) vs passer directement en charge (non amorti)
  traitement            TEXT NOT NULL DEFAULT 'immobilise' CHECK (traitement IN ('immobilise','charge')),
  justification         TEXT,                                -- obligatoire cote applicatif (choix immobiliser/charge)
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_immobilisations_dms ON immobilisations(date_mise_en_service);

ALTER TABLE immobilisations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on immobilisations" ON immobilisations FOR ALL USING (true) WITH CHECK (true);
