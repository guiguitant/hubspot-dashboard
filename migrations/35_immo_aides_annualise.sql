-- Migration 35 : Phase 5.3 - aides publiques + base CIR/CII annualisee
-- 1) annee sur les postes (dimension annuelle des depenses eligibles)
-- 2) periode de projet sur l'immobilisation (fenetre de lissage des aides)
-- 3) nouvelle table immobilisation_aides (subvention / avance recuperable)
-- Mono-locataire, RLS allow-all. APPLICATION MANUELLE (SQL Editor Supabase). Idempotente.

ALTER TABLE immobilisation_postes ADD COLUMN IF NOT EXISTS annee INT;

ALTER TABLE immobilisations ADD COLUMN IF NOT EXISTS date_debut_projet DATE;
ALTER TABLE immobilisations ADD COLUMN IF NOT EXISTS date_fin_projet   DATE;

CREATE TABLE IF NOT EXISTS immobilisation_aides (
  id                            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  immobilisation_id             UUID NOT NULL REFERENCES immobilisations(id) ON DELETE CASCADE,
  type                          TEXT NOT NULL DEFAULT 'subvention' CHECK (type IN ('subvention','avance')),
  financeur                     TEXT,                                 -- ex. "Etat", "Region HDF" (info)
  credit_cible                  TEXT NOT NULL DEFAULT 'cii' CHECK (credit_cible IN ('cir','cii')),
  montant                       NUMERIC NOT NULL DEFAULT 0,           -- montant total de l'aide
  remboursement_debut           DATE,                                 -- avance : date du 1er remboursement
  remboursement_montant_annuel  NUMERIC,                              -- avance : montant rembourse par an
  notes                         TEXT,
  created_at                    TIMESTAMPTZ DEFAULT now(),
  updated_at                    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_immo_aides_immo ON immobilisation_aides(immobilisation_id);

ALTER TABLE immobilisation_aides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on immobilisation_aides" ON immobilisation_aides FOR ALL USING (true) WITH CHECK (true);
