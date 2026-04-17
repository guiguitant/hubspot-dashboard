-- ============================================================
-- MIGRATION 16 : Mise à jour des 4 campagnes actives vers le nouveau format criteria
-- (données migrées manuellement — pas de conversion automatique possible)
-- ⚠️ Utilise '...' (dollar-quoting) pour éviter les erreurs d'apostrophes dans le JSON
-- ============================================================

-- ⚠️ AVANT d'exécuter, vérifier les campagnes existantes :
-- SELECT id, name, status, priority FROM campaigns WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646';
-- SELECT id, name, status, priority FROM campaigns WHERE account_id = '411c4b67-6247-43bb-9800-8fc8e5d070f6';

-- Étape 1 : Mettre toutes les priorités à NULL pour éviter les conflits UNIQUE(account_id, priority)
UPDATE campaigns SET priority = NULL
WHERE account_id IN ('c6cceb81-11e9-4bae-8b09-c55490d79646', '411c4b67-6247-43bb-9800-8fc8e5d070f6');

-- Étape 2 : Mettre à jour les 4 campagnes actives

-- PME/ETI Transport FR (compte Vincent : 411c4b67-6247-43bb-9800-8fc8e5d070f6)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Directeur des opérations", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Directeur administratif et financier", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "105015875", "text": "France", "type": "include"}
    ],
    "sectorIds": [
      {"id": 116, "label": "Transport, logistique, chaîne logistique et stockage", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["Bilan carbone", "Empreinte carbone", "Bilan GES", "Impact environnemental"]
  }',
  priority = 1,
  status = 'En cours'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = '411c4b67-6247-43bb-9800-8fc8e5d070f6'
  AND name ILIKE '%Transport%'
  LIMIT 1
);

-- BTP Hauts-de-France (compte Nathan : c6cceb81-11e9-4bae-8b09-c55490d79646)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Responsable achats", "type": "include"},
      {"value": "Directeur achats", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "105007536", "text": "Hauts-de-France", "type": "include"}
    ],
    "sectorIds": [
      {"id": 48,  "label": "Construction", "type": "include"},
      {"id": 406, "label": "Construction de bâtiments", "type": "include"},
      {"id": 408, "label": "Construction de bâtiments résidentiels", "type": "include"},
      {"id": 413, "label": "Construction de bâtiments non résidentiels", "type": "include"},
      {"id": 51,  "label": "Génie civil", "type": "include"},
      {"id": 435, "label": "Travaux de construction spécialisés", "type": "include"},
      {"id": 436, "label": "Travaux de maçonnerie générale et gros œuvre de bâtiment", "type": "include"},
      {"id": 453, "label": "Travaux d\u0027installation électrique, plomberie et autres travaux d\u0027installation", "type": "include"},
      {"id": 460, "label": "Travaux de finition de bâtiment", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["Empreinte carbone chantier"]
  }',
  priority = 2,
  status = 'En suivi'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND name ILIKE '%BTP%'
  LIMIT 1
);

-- Brasseries / Agroalimentaire (compte Nathan)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Responsable achats", "type": "include"},
      {"value": "Directeur achats", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "105015875", "text": "France", "type": "include"}
    ],
    "sectorIds": [
      {"id": 142, "label": "Fabrication de boissons", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["ACV", "Empreinte carbone produit"]
  }',
  message_template = 'Ne pas prospecter la brasserie Castelain.',
  priority = 3,
  status = 'En suivi'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND name ILIKE '%Brasserie%'
  LIMIT 1
);

-- Industriels - Bretagne (compte Nathan)
UPDATE campaigns SET
  criteria = '{
    "jobTitles": [
      {"value": "Directeur Qualité", "type": "include"},
      {"value": "Directeur général", "type": "include"},
      {"value": "Directeur QHSE", "type": "include"},
      {"value": "Responsable QHSE", "type": "include"},
      {"value": "Ingénieur HSE", "type": "include"},
      {"value": "Directeur environnement", "type": "include"},
      {"value": "Responsable RSE", "type": "include"},
      {"value": "Directeur RSE", "type": "include"},
      {"value": "Responsable qualité", "type": "include"},
      {"value": "Responsable achats", "type": "include"},
      {"value": "Directeur achats", "type": "include"},
      {"value": "Directeur HSE", "type": "include"},
      {"value": "Responsable HSE", "type": "include"},
      {"value": "Directeur administratif et financier", "type": "include"},
      {"value": "Alternant", "type": "exclude"},
      {"value": "Stagiaire", "type": "exclude"},
      {"value": "Junior", "type": "exclude"}
    ],
    "seniorities": [
      {"code": "OWNER_PARTNER", "type": "include"},
      {"code": "C_LEVEL",       "type": "include"},
      {"code": "VP",            "type": "include"},
      {"code": "DIRECTOR",      "type": "include"},
      {"code": "MANAGER_SR",    "type": "include"},
      {"code": "MANAGER_JR",    "type": "include"},
      {"code": "STRATEGIC",     "type": "include"},
      {"code": "SENIOR",        "type": "include"},
      {"code": "ENTRY",         "type": "exclude"},
      {"code": "TRAINEE",       "type": "exclude"}
    ],
    "geoIds": [
      {"id": "103737322", "text": "Bretagne", "type": "include"}
    ],
    "sectorIds": [
      {"id": 25,   "label": "Industrie manufacturière", "parent_category": "Manufacturing", "type": "include"},
      {"id": 3198, "label": "Industrie automobile", "parent_category": "Manufacturing", "type": "include"},
      {"id": 135,  "label": "Fabrication de machines industrielles", "parent_category": "Manufacturing", "type": "include"},
      {"id": 918,  "label": "Fabrication de machines pour le commerce et les industries de services", "parent_category": "Manufacturing", "type": "include"},
      {"id": 1187, "label": "Commerce de gros d\u0027équipements industriels", "parent_category": "Wholesale", "type": "include"}
    ],
    "headcounts": ["C","D","E","F","G","H","I"],
    "keywords": ["Bilan carbone", "Empreinte carbone", "Bilan GES", "Impact environnemental"]
  }',
  priority = 1,
  status = 'En cours'
WHERE id = (
  SELECT id FROM campaigns
  WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND name ILIKE '%Industriels%'
  LIMIT 1
);

-- Supprimer les campagnes archivées (test et campagnes obsolètes)
DELETE FROM campaigns
WHERE account_id = 'c6cceb81-11e9-4bae-8b09-c55490d79646'
  AND status = 'Archivée';
