-- Migration: brut_mensuel + taux_charges -> net_mensuel + charges_mensuelles
-- A executer dans Supabase SQL Editor

-- 1. Ajouter les nouvelles colonnes
ALTER TABLE salaries ADD COLUMN net_mensuel numeric NOT NULL DEFAULT 0 CHECK (net_mensuel >= 0);
ALTER TABLE salaries ADD COLUMN charges_mensuelles numeric NOT NULL DEFAULT 0 CHECK (charges_mensuelles >= 0);

-- 2. Supprimer les anciennes colonnes
ALTER TABLE salaries DROP COLUMN brut_mensuel;
ALTER TABLE salaries DROP COLUMN taux_charges;

-- 3. Vider la table et inserer les donnees corrigees
DELETE FROM salaries;

INSERT INTO salaries (nom, type, net_mensuel, charges_mensuelles, date_entree, date_sortie) VALUES
  ('Juliette', 'salarie',    2145, 1760, '2025-01-01', '2025-12-31'),
  ('Arthur',   'salarie',    2470, 2027, '2025-10-01', NULL),
  ('Evane',    'alternant',  1170, 330,  '2025-09-01', '2026-08-31'),
  ('Corentin', 'alternant',  1170, 300,  '2025-09-01', '2026-08-31'),
  ('Thomas',   'salarie',    2470, 2027, '2026-04-01', NULL),
  ('Marilou',  'stagiaire',  1000, 120,  '2026-03-01', '2026-08-31'),
  ('Sarra',    'stagiaire',  650,  0,    '2026-03-01', '2026-08-31'),
  ('Vincent',  'dirigeant',  4000, 0,    '2025-01-01', NULL),
  ('Guillaume','dirigeant',  4000, 0,    '2025-01-01', NULL),
  ('Nathan',   'dirigeant',  4000, 0,    '2025-06-01', NULL);
