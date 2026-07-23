-- Migration 33 : postes d'assiette des immobilisations (Phase 5.2 refonte Pilot)
-- Sous-table de `immobilisations` : compose l'assiette amortissable a partir de "postes connus"
-- (quote-part de salaire, prestation externe...) et porte les flags CIR / subvention pour la base CIR.
-- Mono-locataire, RLS allow-all (protection reelle = auth dashboard TOTP). APPLICATION MANUELLE (SQL Editor Supabase).

CREATE TABLE IF NOT EXISTS immobilisation_postes (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  immobilisation_id  UUID NOT NULL REFERENCES immobilisations(id) ON DELETE CASCADE,
  libelle            TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'autre' CHECK (source IN ('salaire','prestation','autre')),
  source_ref         TEXT,                                 -- nom employe / libelle categorie CR_Prev (tracabilite du poste connu)
  montant            NUMERIC NOT NULL DEFAULT 0,           -- montant retenu dans l'assiette (HT)
  cir                BOOLEAN NOT NULL DEFAULT false,       -- ce poste entre-t-il dans l'assiette du CIR ?
  subvention         NUMERIC NOT NULL DEFAULT 0,           -- subvention a deduire de la base CIR (anti double comptage)
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_immo_postes_immo ON immobilisation_postes(immobilisation_id);

ALTER TABLE immobilisation_postes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all on immobilisation_postes" ON immobilisation_postes FOR ALL USING (true) WITH CHECK (true);
