-- Migration 47: email du contact de chaque deal, gardé par Pilot
--
-- Spec Canopy « Consolider », étape 9 (docs/specs/chantier-2-consolider.md dans
-- le dépôt canopy). Au 12/10/2026, 108 deals ouverts sur 186 n'avaient aucune
-- entreprise côté Canopy : créés à la main dans Pilot, sans contact. Et le
-- contact envoyé par Canopy à la création n'était écrit que dans HubSpot, où
-- l'app de Pilot n'a pas les droits (403 silencieux).
--
-- Désormais l'email du contact vit ici, comme les tags et le responsable :
--   - obligatoire à la création (écran de Pilot, route Canopy, outil MCP) ;
--   - renvoyé à Canopy par GET /api/releaf-deals/pipeline (`contactEmail`),
--     qui rattache le deal à l'entreprise par le domaine de l'adresse ;
--   - posé après coup sur un deal existant par
--     POST /api/releaf-deals/deals/:id/contact (contacts proposés par Canopy).
-- HubSpot reçoit toujours une copie quand ses droits le permettent ; son échec
-- ne bloque rien.
--
-- Le code tolère l'absence de la colonne (lecture sans l'email) : appliquer
-- cette migration avant ou après le déploiement, sans casse.

ALTER TABLE deal_metadata
  ADD COLUMN IF NOT EXISTS contact_email TEXT;
