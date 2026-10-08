-- Migration 46: réservation des créations de deal demandées par Canopy
--
-- Canopy crée des deals via POST /api/releaf-deals/deals. Quand il réessaie
-- (délai dépassé, job rejoué), un second appel créait un second deal : la
-- route n'était pas idempotente. Canopy envoie désormais une clé par création
-- voulue (`cle_externe`). Pilot la réserve AVANT d'appeler HubSpot :
--   - clé déjà associée à un deal  : Pilot rend ce deal, rien n'est créé ;
--   - clé réservée sans deal       : création en cours ou interrompue, Pilot
--                                    répond 409 et ne crée rien (vérification
--                                    humaine, le doublon est pire que l'attente) ;
--   - clé absente                  : réservation, puis création.
-- La contrainte de clé primaire rend la réservation sûre entre deux appels
-- simultanés.

CREATE TABLE IF NOT EXISTS releaf_deal_creations (
  cle_externe TEXT PRIMARY KEY,
  deal_id     TEXT,
  statut      TEXT NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'cree')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lue et écrite uniquement par le serveur (supabaseAdmin, clé service) :
-- RLS activée sans politique, aucun accès depuis le navigateur.
ALTER TABLE releaf_deal_creations ENABLE ROW LEVEL SECURITY;
