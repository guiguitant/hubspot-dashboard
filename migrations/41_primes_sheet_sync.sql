-- Migration 41 : etat de synchronisation des primes vers le Google Sheet.
-- Stocke l'horodatage de la derniere synchro (bouton "Synchroniser le GSheet" + cron quotidien)
-- et un resume du run. Une seule ligne (id = 'default'), geree cote serveur (service role).
-- Non bloquant : si la table est absente, la synchro fonctionne quand meme (l'horodatage n'est
-- simplement pas persiste).

create table if not exists primes_sheet_sync (
  id          text primary key default 'default',
  last_run_at timestamptz,
  ok          boolean,
  summary     jsonb,
  updated_at  timestamptz default now()
);

-- Table interne serveur : pas d'acces client direct (le serveur ecrit via le service role).
alter table primes_sheet_sync enable row level security;
