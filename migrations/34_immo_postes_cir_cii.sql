-- Migration 34 : CIR + CII sur les postes d'immobilisation (Phase 5.2, complement)
-- Remplace le flag `cir` binaire par un type de credit (aucun / CIR / CII) + un statut "prestataire agree"
-- (la sous-traitance CIR/CII n'est eligible que si le prestataire est agree).
-- APPLICATION MANUELLE (SQL Editor Supabase). Idempotente.

ALTER TABLE immobilisation_postes
  ADD COLUMN IF NOT EXISTS credit_type TEXT NOT NULL DEFAULT 'none' CHECK (credit_type IN ('none','cir','cii'));

ALTER TABLE immobilisation_postes
  ADD COLUMN IF NOT EXISTS prestataire_agree BOOLEAN NOT NULL DEFAULT false;

-- Migre l'ancienne colonne `cir` (booleenne) vers credit_type, puis la supprime — seulement si elle existe encore.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'immobilisation_postes' AND column_name = 'cir'
  ) THEN
    UPDATE immobilisation_postes SET credit_type = 'cir' WHERE cir = true;
    ALTER TABLE immobilisation_postes DROP COLUMN cir;
  END IF;
END $$;
