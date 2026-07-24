-- Migration 37 : periode (date debut / date fin) optionnelle par poste d'immobilisation.
-- Si renseignee, le montant du poste est prorate a la part de l'annee couverte (cf. serveur).
-- Sinon, annee pleine. APPLICATION MANUELLE (SQL Editor Supabase). Idempotente.

ALTER TABLE immobilisation_postes ADD COLUMN IF NOT EXISTS date_debut DATE;
ALTER TABLE immobilisation_postes ADD COLUMN IF NOT EXISTS date_fin   DATE;
