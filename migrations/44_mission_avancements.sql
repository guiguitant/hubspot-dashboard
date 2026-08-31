-- Migration 44 : avancement des missions pour le CA a l'avancement (FAE/PCA),
-- design docs/superpowers/specs/2026-08-31-ca-avancement-design.md
--
-- A EXECUTER UNE FOIS dans l'editeur SQL Supabase (SQL Editor > New query > coller > Run).
-- Tant que ce script n'a pas ete passe, l'application fonctionne normalement : GET /api/avancement
-- renvoie disponible: false, aucun CA n'est ajuste, et la saisie est desactivee cote front.
--
-- A quoi sert cette table : Releaf facture de la prestation. Quand une mission est a cheval sur
-- deux exercices (acompte en N, solde en N+1), le CA de chaque exercice depend du pourcentage
-- d'avancement au 31/12, pas des dates de facturation. Une ligne = "au 31/12/{exercice}, cette
-- mission etait avancee a {pct} %". Le CA de l'exercice vaut alors ca x (pct fin N - pct fin N-1).
--
-- exercice 2025 = ancre : reprise du fichier de cut-off transmis a l'expert-comptable. Aucun CA
-- 2025 n'est modifie par Pilot (exercice clos, la liasse fait foi) : ces lignes servent uniquement
-- de point de depart au calcul 2026.
--
-- fige_le : horodatage pose a la cloture d'un exercice (bouton "Figer" de la modale). Une ligne
-- figee n'est plus modifiable ni supprimable par l'API (HTTP 409). Patron du gel de deal
-- (migrations/43_deal_freeze.sql) : une date, pas un booleen sec.

create table if not exists mission_avancements (
  mission_id text not null,
  exercice integer not null,
  pct numeric not null check (pct >= 0 and pct <= 100),
  nom text,
  fige_le timestamptz,
  updated_at timestamptz not null default now(),
  primary key (mission_id, exercice)
);

-- RLS activee SANS AUCUNE POLICY : patron de migrations/42_deals_notion_validations.sql. La table
-- est inaccessible aux cles anon/authenticated et n'est lisible/ecrivable que par la cle
-- service-role du serveur (supabaseAdmin), qui contourne RLS par construction.
alter table mission_avancements enable row level security;
