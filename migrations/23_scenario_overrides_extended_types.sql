-- Migration 23 : étend la contrainte CHECK de scenario_overrides.type
-- pour couvrir les 5 nouveaux types ajoutés en Phase B + ca_estimatif
-- qui semble n'avoir jamais été dans la contrainte originale.
--
-- Types autorisés après cette migration (10 au total) :
--   - salaire                 (existant)
--   - pipeline                (existant)
--   - charges_fixes           (existant)
--   - revenu_exceptionnel     (existant)
--   - ca_estimatif            (existait côté JS mais pas en DB)
--   - salaire_augmentation    (Phase B)
--   - revenu_recurrent        (Phase B)
--   - pret                    (Phase B)
--   - subvention_annoncee     (Phase B)
--   - ligne_gsheet_override   (Phase B)

ALTER TABLE scenario_overrides
  DROP CONSTRAINT IF EXISTS scenario_overrides_type_check;

ALTER TABLE scenario_overrides
  ADD CONSTRAINT scenario_overrides_type_check
  CHECK (type IN (
    'salaire',
    'pipeline',
    'charges_fixes',
    'revenu_exceptionnel',
    'ca_estimatif',
    'salaire_augmentation',
    'revenu_recurrent',
    'pret',
    'subvention_annoncee',
    'ligne_gsheet_override'
  ));
