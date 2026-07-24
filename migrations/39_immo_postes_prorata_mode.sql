-- Migration 39 : mode de prise en compte du prorata par poste.
-- Un salaire est un cout CONTINU : on le proratise au temps (jours couverts / jours de l'annee).
-- Une prestation est facturee a des DATES DISCRETES (ex. 3 interventions) : elle ne se proratise
-- pas lineairement, on retient le montant plein (deja cale sur la periode eligible).
--   prorata_temporel = true  -> retenu = montant x quote-part x prorata jours (continu, defaut)
--   prorata_temporel = false -> retenu = montant x quote-part            (ponctuel, pas de prorata)
-- APPLICATION MANUELLE (SQL Editor Supabase). Idempotente.

ALTER TABLE immobilisation_postes ADD COLUMN IF NOT EXISTS prorata_temporel BOOLEAN NOT NULL DEFAULT true;

-- Backfill : les prestations existantes etaient proratisees a tort (ex. Polara a 86%).
-- On les bascule en ponctuel (montant plein). Les salaires restent en continu (defaut true).
UPDATE immobilisation_postes SET prorata_temporel = false WHERE source = 'prestation';
