-- Migration 25
-- Drop la table salaries (dépréciée en Phase F du chantier scenarios-rework).
-- Source de vérité désormais : GSheet "Masse_salariale" (GID 798407110) + "Salaires" (GID 1450270387).
-- Code serveur :
--   - fetchAndParseMasseSalarialeDetailed() : coûts mensuels par employé + total mensuel
--   - fetchAndParseSalariesMeta()           : metadata employés (nom, type, dates)
--   - masseSalarialeMois()                  : compose baseline GSheet + overrides scénario (add/modify/remove/augmentation)
--
-- Les CRUD /api/salaries (GET/POST/PUT/DELETE) sont supprimés. La page "Masse salariale"
-- passe en lecture seule, alimentée par GET /api/scenarios/baseline/salaries (qui lit GSheet).

DROP TABLE IF EXISTS salaries;
