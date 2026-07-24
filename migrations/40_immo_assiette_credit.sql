-- Migration 40 : mode d'assiette du credit d'impot (CIR/CII) par immobilisation.
-- Deux traitements selon la nature de l'immobilisation (a valider avec l'expert-comptable) :
--   'depenses'      = methode A : l'assiette est constituee des DEPENSES ENGAGEES l'annee
--                     (salaires, prestations). Cas d'un livrable R&D developpe en interne.
--   'amortissement' = methode B : l'assiette est constituee des DOTATIONS AUX AMORTISSEMENTS,
--                     etalees sur la duree d'amortissement. Cas d'un actif amortissable ACQUIS
--                     et utilise pour la R&D (ex. un outil/logiciel type SimaPro).
-- Defaut = 'depenses' (comportement historique). APPLICATION MANUELLE (SQL Editor Supabase). Idempotente.

ALTER TABLE immobilisations
  ADD COLUMN IF NOT EXISTS assiette_credit TEXT NOT NULL DEFAULT 'depenses'
  CHECK (assiette_credit IN ('depenses', 'amortissement'));
