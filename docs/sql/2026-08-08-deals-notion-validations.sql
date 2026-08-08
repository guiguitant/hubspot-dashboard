-- Validation manuelle des deals gagnes sans mission Notion (feature C-2, design
-- docs/superpowers/specs/2026-08-08-produits-et-suivis-design.md#C-2).
--
-- A EXECUTER UNE FOIS dans l'editeur SQL Supabase (SQL Editor > New query > coller > Run).
-- Tant que ce script n'a pas ete passe, l'application continue de fonctionner : le GET
-- /api/coherence/deals-notion renvoie validationsDisponibles: false et zero valide, et les
-- boutons de validation de la modale sont desactives (aucune 500, aucune donnee perdue).
--
-- A quoi sert cette table : le rapprochement automatique deals HubSpot <-> missions Notion est
-- un-pour-un a +/-1 %. Il ne peut donc pas voir un deal decoupe en plusieurs missions Notion
-- ("EPD - Ecoforest" 39 000 EUR = "Ecoforest Part1" + "Ecoforest Part2") ni un deal regroupe avec
-- un autre client dans une mission unique ("Moulin du nord" 2 500 EUR dans "Minoterie / Moulin"
-- 5 000 EUR). Ces deals remontent en fausse alerte : cette table memorise l'arbitrage manuel
-- "ce deal EST bien dans Notion" pour les sortir du bandeau d'alerte.
--
-- Colonnes nom / montant / closedate : copie informative du deal au moment de la validation
-- (permet de relire la liste des validations sans rappeler HubSpot). La cle metier est deal_id.

create table if not exists deals_notion_validations (
  deal_id text primary key,
  nom text,
  montant numeric,
  closedate date,
  validated_at timestamptz not null default now()
);

-- RLS activee SANS AUCUNE POLICY : c'est le patron deja utilise par kpi_prime_config. Consequence
-- volontaire : la table est totalement inaccessible aux cles anon/authenticated (aucune policy ne
-- laisse passer quoi que ce soit) et n'est lisible/ecrivable que par la cle service-role du
-- serveur (supabaseAdmin), qui contourne RLS par construction. Aucune donnee de ce dashboard ne
-- doit etre exposee au navigateur directement.
alter table deals_notion_validations enable row level security;
