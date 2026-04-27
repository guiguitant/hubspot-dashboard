-- Migration 26 : table plan_tre_validations
-- Permet à l'utilisateur de marquer manuellement une ligne Plan TRE Prév (subvention, aide, prêt,
-- avance, remb_opco, remb_avance) comme "reçue / payée" sur un mois donné.
-- Sans matching automatique Qonto, cette validation manuelle bascule la ligne de la section
-- "Prévisionnel" vers la section "Réel validé" dans la modale Tréso du mois courant.
-- Pas d'impact sur le calcul du soldeFin (purement visuel).
--
-- Clé : (line_label, month_key) — une ligne Plan TRE Prév par mois peut être validée indépendamment.

CREATE TABLE IF NOT EXISTS plan_tre_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_label text NOT NULL,            -- ex: "Subvention BFT", "Prêt bancaire", "Aide apprentissage"
  line_category text NOT NULL,         -- 'subvention' | 'aide' | 'pret' | 'avance' | 'remb_opco' | 'remb_avance'
  month_key text NOT NULL,             -- "YYYY-MM"
  paid boolean NOT NULL DEFAULT true,
  validated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_tre_validations_unique UNIQUE (line_label, month_key)
);

CREATE INDEX IF NOT EXISTS idx_plan_tre_validations_month ON plan_tre_validations (month_key);
