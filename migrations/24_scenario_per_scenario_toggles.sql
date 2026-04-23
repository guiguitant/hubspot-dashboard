-- Migration 24
-- 1) Ajoute 4 flags de composition par scénario (defaults true pour rester compatible
--    avec les scénarios existants qui étaient projetés avec tout inclus).
-- 2) Drop la table revenus_exceptionnels maintenant dépréciée (remplacée fonctionnellement
--    par l'override `revenu_exceptionnel` de scénario + les lignes financements GSheet
--    Plan_TRE_Prév pour les cas réels).

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS include_gsheet           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS include_pipeline         BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS include_ca_notion        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS include_salaries_baseline BOOLEAN NOT NULL DEFAULT TRUE;

DROP TABLE IF EXISTS revenus_exceptionnels;
