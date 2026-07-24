-- Migration 36 : les aides ne portent plus de tag CIR/CII.
-- La deduction de chaque aide (et la reintegration des avances) est desormais repartie
-- automatiquement au prorata des postes CIR/CII du projet (cf. computeBasesParAnnee cote serveur).
-- APPLICATION MANUELLE (SQL Editor Supabase). Idempotente.

ALTER TABLE immobilisation_aides DROP COLUMN IF EXISTS credit_cible;
