-- Migration 38 : quote-part d'affectation (%) par poste d'immobilisation.
-- Ex : 20% du salaire d'un employe affecte au projet R&D une annee, 80% l'annee suivante.
-- Montant retenu = montant x (quote_part / 100) x prorata temporel (dates). APPLICATION MANUELLE. Idempotente.

ALTER TABLE immobilisation_postes ADD COLUMN IF NOT EXISTS quote_part NUMERIC NOT NULL DEFAULT 100;
