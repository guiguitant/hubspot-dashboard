-- Migration 17: Ajout du statut 'Profil incomplet' pour les profils partiels (scraping rate-limité)
-- Le statut 'Profil incomplet' précède 'Profil à valider' dans le workflow :
-- un profil incomplet doit d'abord être enrichi avant d'être validable.

ALTER TABLE prospects
  DROP CONSTRAINT IF EXISTS prospects_status_check;

ALTER TABLE prospects
  ADD CONSTRAINT prospects_status_check CHECK (status IN (
    'Profil incomplet',
    'Profil à valider',
    'Non pertinent',
    'Nouveau',
    'Invitation envoyée',
    'Invitation acceptée',
    'Message à valider',
    'Message à envoyer',
    'Message envoyé',
    'Discussion en cours',
    'Gagné',
    'Perdu',
    'Profil restreint',
    'Hors séquence'
  ));
