-- Migration 43: gel d'un deal avec date de réveil
--
-- Geler = sortir un deal du pipe actif SANS le perdre. Cas typique : le prospect
-- dit "très intéressant, on en reparle dans 3 mois". Aujourd'hui un tel deal
-- reste en RDV Qualif et devient "critique" au bout de 3 semaines, pour rien :
-- l'alerte crie sur un deal parfaitement sain, et on apprend à ignorer le rouge.
--
-- Le deal part donc dans le stage "À relancer plus tard" avec une date de réveil.
-- Sans cette date, cette colonne est un cimetière : un deal y entre et n'en sort
-- jamais (elle n'affiche qu'un "depuis le 12/03"). C'est ce que ces colonnes
-- corrigent.
--
--   wake_up_at        : quand le deal doit revenir. Obligatoire côté UI, c'est
--                       la règle qui empêche la colonne de redevenir un cimetière.
--   frozen_from_stage : d'où il vient, pour le réactiver au bon endroit. Sans ça
--                       on récupère dans 3 mois un deal orphelin sans savoir où
--                       il en était (HubSpot écrase hs_date_entered_* au retour).
--   frozen_note       : pourquoi on gèle, écrit à chaud. Dans 3 mois on aura
--                       oublié. C'est cette phrase qui rend le réveil utile.
--   frozen_at         : quand le gel a été posé.
--
-- Un gel s'annule en un clic (bouton Réactiver) : rien d'irréversible ici.

ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS wake_up_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS frozen_from_stage TEXT,
  ADD COLUMN IF NOT EXISTS frozen_note       TEXT,
  ADD COLUMN IF NOT EXISTS frozen_at         TIMESTAMPTZ;

-- Le réveil se lit tous les matins : on indexe les deals effectivement gelés.
CREATE INDEX IF NOT EXISTS idx_deal_metadata_wake_up_at
  ON deal_metadata (wake_up_at)
  WHERE wake_up_at IS NOT NULL;
