-- ============================================================
-- MIGRATION 14 : Sales Navigator Builder — DDL
-- ============================================================

-- 1. Extension de la table campaigns
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS criteria         JSONB    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sales_nav_url    TEXT,
  ADD COLUMN IF NOT EXISTS priority         INTEGER  DEFAULT 3,
  ADD COLUMN IF NOT EXISTS message_template TEXT,
  ADD COLUMN IF NOT EXISTS target_count     INTEGER;

-- Supprimer le champ déprécié (remplacé par criteria.jobTitles[].type = 'exclude')
ALTER TABLE campaigns
  DROP COLUMN IF EXISTS excluded_keywords;

-- 2. Ajout de 'Hors séquence' au CHECK constraint prospects
ALTER TABLE prospects
  DROP CONSTRAINT IF EXISTS prospects_status_check;

ALTER TABLE prospects
  ADD CONSTRAINT prospects_status_check CHECK (status IN (
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

-- 3. Index UNIQUE sur linkedin_url pour éviter les doublons en concurrence
-- Partiel (WHERE NOT NULL) car linkedin_url est nullable
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_unique_linkedin_url
  ON prospects (account_id, linkedin_url)
  WHERE linkedin_url IS NOT NULL;

-- 4. Table de référence : secteurs LinkedIn
CREATE TABLE IF NOT EXISTS linkedin_sectors (
  id               INTEGER PRIMARY KEY,
  label_fr         TEXT    NOT NULL UNIQUE,
  parent_category  TEXT    NOT NULL,
  verified         BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Table de référence : zones géographiques LinkedIn
CREATE TABLE IF NOT EXISTS linkedin_geos (
  id        VARCHAR(20) PRIMARY KEY,
  label_fr  VARCHAR(100) NOT NULL,
  label_en  VARCHAR(100),
  geo_type  VARCHAR(20) NOT NULL CHECK (geo_type IN ('COUNTRY', 'REGION', 'CITY')),
  parent_id VARCHAR(20) REFERENCES linkedin_geos(id)
);

-- 6. Index full-text pour recherche frontend
CREATE INDEX IF NOT EXISTS idx_linkedin_sectors_fts
  ON linkedin_sectors USING gin(to_tsvector('french', label_fr));

CREATE INDEX IF NOT EXISTS idx_linkedin_geos_fts
  ON linkedin_geos USING gin(to_tsvector('french', label_fr));

-- 7. RLS : lecture publique pour tous les utilisateurs authentifiés
ALTER TABLE linkedin_sectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "linkedin_sectors_read" ON linkedin_sectors
  FOR SELECT TO authenticated USING (true);

ALTER TABLE linkedin_geos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "linkedin_geos_read" ON linkedin_geos
  FOR SELECT TO authenticated USING (true);
