# Releaf Prospector — Scraping Workflow (Source unique de vérité)

Workflow autonome pour l'extraction de prospects LinkedIn (Tâche 1).
**Exécution : du lundi au vendredi à 10h05. Profil Chrome : `Sales_nav`.**

---

## Règles absolues d'exécution

1. **`fetch()` uniquement** : Tous les appels API vers `localhost:3000` doivent utiliser `fetch()` dans le navigateur. Jamais `curl`, jamais `bash`.
2. **Sales Navigator obligatoire** : L'extraction se fait sur Sales Navigator (`linkedin.com/sales/`). Les URLs classiques (`linkedin.com/in/...`) doivent être récupérées pour chaque profil.
3. **Session Sales Nav active** : Si Sales Navigator redirige vers `/login`, `/checkpoint` ou la page d'accueil LinkedIn classique → arrêt immédiat (`stopped_reason: 'session_expired'`).
4. **Try/catch par prospect** : Chaque traitement de profil dans un `try/catch`. Si un profil plante → loguer dans `_errors[]`, passer au suivant.
5. **Aucune action LinkedIn directe** : Pas d'invitation, pas de message. Cette tâche ne fait que scraper et soumettre à validation.
6. **Try/finally global** : Tout le workflow doit être enveloppé dans un `try/finally` pour garantir que le lock est toujours relâché, même en cas de crash.

```javascript
try {
  // ... tout le workflow (Étapes 0b à 3)
} finally {
  await fetch('/api/task-locks/release', { method: 'POST', headers, body: JSON.stringify({ lock_type: 'linkedin_task1' }) });
}
```

---

## Authentification

```javascript
const token = localStorage.getItem('auth_token');
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`
};
```

---

## URL de base

```
http://localhost:3000
```

---

## Variables globales

```javascript
const _startedAt = Date.now();
const _errors = [];
let _stopped_reason = null; // null = normal, 'session_expired', 'rate_limited'

const MAX_PROFILES_PER_CAMPAIGN = 30;  // Ne pas soumettre plus de 30 profils par campagne
const MAX_PROFILES_PER_RUN = 80;       // Limite globale par exécution
let _totalSubmitted = 0;               // Compteur global inter-campagnes

const _summary = {
  campaigns_processed: 0,
  profiles_found: 0,
  profiles_rejected_duplicates: 0,
  profiles_rejected_excluded: 0,
  profiles_submitted: 0,
};
```

---

## Statuts des campagnes (référence)

| Statut | Scraping ? |
|--------|-----------|
| À lancer | ✅ Oui — besoin de prospects |
| En cours | ✅ Oui — prospection active |
| En suivi | ❌ Non — suivi uniquement, pas de nouveaux prospects |
| Terminée | ❌ Non |
| Archivée | ❌ Non |

---

## Workflow Scraping (Tâche 1 — 1x/jour)

### Étape 0 — Acquérir le lock

```javascript
const lockResp = await fetch('/api/task-locks/acquire', {
  method: 'POST', headers, body: JSON.stringify({ lock_type: 'linkedin_task1', task_name: 'task1' })
});
const lock = await lockResp.json();
```

Si `lock.acquired === false` → STOP.

### Étape 0b — Vérifier la session Sales Navigator

Naviguer vers `https://www.linkedin.com/sales/home` et vérifier que la session est active.

```javascript
// Vérifier que Sales Navigator est accessible
const currentUrl = window.location.href;
if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint') || !currentUrl.includes('/sales/')) {
  _stopped_reason = 'session_expired';
  await _postSummary();
  return; // STOP — sortie du try, finally relâche le lock
}
```

### Étape 1 — Charger les campagnes à prospecter

```javascript
const campsResp = await fetch('/api/prospector/campaigns?active=true', { headers });
const allCampaigns = await campsResp.json();

// Seules les campagnes "À lancer" et "En cours" ont besoin de nouveaux prospects
const campaigns = allCampaigns
  .filter(c => ['À lancer', 'En cours'].includes(c.status))
  .sort((a, b) => (a.priority || 99) - (b.priority || 99));
```

Si aucune campagne → `_postSummary()` et arrêter.

### Étape 2 — Pour chaque campagne : extraction Sales Navigator

Pour chaque campagne, dans l'ordre de priorité.
**Vérifier la limite globale** : si `_totalSubmitted >= MAX_PROFILES_PER_RUN` → arrêter les campagnes restantes.

#### 2a — Récupérer les profils existants (pour déduplication)

```javascript
const existingResp = await fetch(`/api/prospector/prospects?campaign_id=${campaign.id}`, { headers });
const existing = await existingResp.json();

// Sets de déduplication (normaliser : minuscules, sans trailing slash)
const existingLinkedinUrls = new Set(existing.map(p => (p.linkedin_url || '').toLowerCase().replace(/\/$/, '')));
const existingSalesNavUrls = new Set(existing.map(p => (p.sales_nav_url || '').toLowerCase().replace(/\/$/, '')));
```

**Note sur la portée** : la déduplication se fait par campagne. Un même profil peut exister dans 2 campagnes différentes — c'est voulu (un prospect peut être ciblé par plusieurs angles).

#### 2b — Construire les filtres et exclusions

```javascript
const criteria = campaign.criteria || {};
// Filtres Sales Navigator à appliquer dans l'UI :
// - Secteur d'activité : criteria.sector || campaign.sector
// - Géographie : criteria.geography || campaign.geography
// - Intitulés de poste : criteria.job_titles || []  (tableau de strings)
// - Taille entreprise : criteria.employees_min / criteria.employees_max
// - CA entreprise : criteria.revenue_min / criteria.revenue_max

// `criteria` est un objet JSONB stocké sur la campagne.
// `campaign.sector` et `campaign.geography` sont des colonnes TEXT de niveau campagne.

// Mots-clés d'exclusion : campagne + universels
const campaignExclusions = (campaign.excluded_keywords || []).map(k => k.toLowerCase());
const UNIVERSAL_EXCLUSIONS = [
  'stagiaire', 'alternant', 'alternante', 'apprenti', 'apprentie',
  'stage', 'alternance', 'étudiant', 'étudiante',
  'intern', 'internship'
];
const allExclusions = [...UNIVERSAL_EXCLUSIONS, ...campaignExclusions];
```

#### 2c — Naviguer et rechercher sur Sales Navigator

**URL de recherche :** `https://www.linkedin.com/sales/search/people/`

```
1. Naviguer vers /sales/search/people/
2. Appliquer les filtres de recherche via l'interface Sales Navigator :
   - "Geography" → criteria.geography || campaign.geography
   - "Current company headcount" → criteria.employees_min / employees_max
   - "Industry" → criteria.sector || campaign.sector
   - "Current job title" → criteria.job_titles (un par un)
3. Attendre le chargement des résultats
```

**Pagination :**
- Sales Navigator affiche **25 résultats par page**
- Parcourir les pages en cliquant sur le bouton "Next" / "Suivant"
- **Maximum de pages à parcourir** : `Math.ceil(MAX_PROFILES_PER_CAMPAIGN / 25)` (soit 2 pages pour 30 profils)
- Arrêter la pagination si le nombre de profils retenus pour cette campagne atteint `MAX_PROFILES_PER_CAMPAIGN`

**Pour chaque résultat de la page :**

Les résultats sont des cards dans la liste. Pour chaque card :

1. **Extraire les données visibles** : nom, prénom, titre de poste, entreprise
2. **Filtrer par exclusion** (titre de poste) :
   ```javascript
   const jobTitle = (profile.job_title || '').toLowerCase();
   if (allExclusions.some(word => jobTitle.includes(word))) {
     _summary.profiles_rejected_excluded++;
     continue;
   }
   ```

#### 2d — Extraire l'URL LinkedIn classique

Pour chaque profil retenu après filtrage :

1. **Récupérer l'URL Sales Navigator** depuis le lien du profil dans la liste : format `linkedin.com/sales/lead/ACw...`
2. **D'abord essayer depuis la liste** : vérifier si l'URL classique (`linkedin.com/in/...`) est accessible directement dans la card (attribut `href` du lien du nom, survol, ou donnée dans le DOM). C'est souvent le cas et ça évite d'ouvrir chaque profil.
3. **Seulement si introuvable dans la liste** : cliquer sur le profil → chercher le lien "View on LinkedIn" ou l'URL `linkedin.com/in/...` → revenir à la liste
4. **Normaliser** l'URL classique : minuscules, supprimer le trailing slash, pas de paramètres de query

```javascript
// Normalisation de l'URL
const normalizedUrl = linkedinUrl.toLowerCase().replace(/\/$/, '').split('?')[0];
```

Si l'URL classique est introuvable → loguer dans `_errors[]` et passer au profil suivant. **Ne jamais utiliser une URL Sales Navigator comme `linkedin_url`.**

#### 2e — Déduplication et validation

```javascript
try {
  _summary.profiles_found++;

  // Filtrage exclusion (déjà fait en 2c, mais double-check)
  const jobTitle = (profile.job_title || '').toLowerCase();
  if (allExclusions.some(word => jobTitle.includes(word))) {
    _summary.profiles_rejected_excluded++;
    continue;
  }

  // Déduplication
  const normalizedUrl = profile.linkedin_url.toLowerCase().replace(/\/$/, '');
  const normalizedSalesUrl = (profile.sales_nav_url || '').toLowerCase().replace(/\/$/, '');

  if (existingLinkedinUrls.has(normalizedUrl) || existingSalesNavUrls.has(normalizedSalesUrl)) {
    _summary.profiles_rejected_duplicates++;
    continue;
  }

  // Ajouter au batch
  toSync.push(profile);
  existingLinkedinUrls.add(normalizedUrl); // éviter les doublons intra-batch

  // Limites
  if (toSync.length >= MAX_PROFILES_PER_CAMPAIGN) break;
  if (_totalSubmitted + toSync.length >= MAX_PROFILES_PER_RUN) break;
} catch (err) {
  _errors.push({ step: '2e', prospect_id: null, message: err.message });
}
```

#### 2f — Synchroniser dans Prospector

```javascript
if (toSync.length > 0) {
  const syncResp = await fetch('/api/prospector/sync', {
    method: 'POST', headers,
    body: JSON.stringify({
      campaign_id: campaign.id,
      prospects: toSync.map(p => ({
        first_name: p.first_name,
        last_name: p.last_name,
        linkedin_url: p.linkedin_url,       // URL classique UNIQUEMENT (linkedin.com/in/...)
        sales_nav_url: p.sales_nav_url,     // URL Sales Navigator (linkedin.com/sales/lead/...)
        company: p.company,
        job_title: p.job_title,
        sector: criteria.sector || campaign.sector || '',
        geography: criteria.geography || campaign.geography || '',
        status: 'Profil à valider',
        interaction: {
          type: 'Ajout LinkedIn',
          content: 'Profil trouvé sur Sales Navigator — en attente de validation'
        }
      }))
    })
  });

  const result = await syncResp.json();
  const count = result.created || toSync.length;
  _summary.profiles_submitted += count;
  _totalSubmitted += count;
}

_summary.campaigns_processed++;
```

### Gestion du rate limiting Sales Navigator

À tout moment pendant le scraping, si Sales Navigator affiche :
- Un captcha
- "You've reached the commercial use limit"
- Une page blanche ou un redirect vers `/login`

→ Arrêt immédiat :
```javascript
_stopped_reason = 'rate_limited';
await _postSummary();
return; // finally relâche le lock
```

### Étape 3 — Résumé final

```javascript
await _postSummary();
// Le finally global relâche le lock
```

**Fonction `_postSummary` :**

```javascript
async function _postSummary() {
  const duration = Math.round((Date.now() - _startedAt) / 1000);

  // Persister le résumé en base
  await fetch('/api/scraping/summary', {
    method: 'POST', headers,
    body: JSON.stringify({
      ran_at: new Date(_startedAt).toISOString(),
      duration_seconds: duration,
      campaigns_processed: _summary.campaigns_processed,
      profiles_found: _summary.profiles_found,
      profiles_rejected_duplicates: _summary.profiles_rejected_duplicates,
      profiles_rejected_excluded: _summary.profiles_rejected_excluded,
      profiles_submitted: _summary.profiles_submitted,
      stopped_reason: _stopped_reason,
      errors: _errors,
    })
  });

  // Afficher le résumé dans la conversation
  console.log(`
📋 RÉSUMÉ TÂCHE 1 — Scraping Sales Navigator
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Début : ${new Date(_startedAt).toLocaleTimeString('fr-FR')}
Fin : ${new Date().toLocaleTimeString('fr-FR')}
Durée : ${Math.floor(duration / 60)}min ${duration % 60}s

Campagnes traitées : ${_summary.campaigns_processed}
Profils trouvés : ${_summary.profiles_found}
Rejetés (doublons) : ${_summary.profiles_rejected_duplicates}
Rejetés (exclus) : ${_summary.profiles_rejected_excluded}
Soumis à validation : ${_summary.profiles_submitted}
${_stopped_reason ? `\nArrêt : ${_stopped_reason}` : ''}
${_errors.length > 0 ? `\nErreurs (${_errors.length}) :\n${_errors.map(e => `  - [${e.step}] ${e.message}`).join('\n')}` : ''}

Les nouveaux profils sont visibles dans Prospector (filtre "Profil à valider").
  `);
}
```

---

## Endpoints récapitulatifs

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/task-locks/acquire` | Acquérir un lock |
| POST | `/api/task-locks/release` | Relâcher un lock |
| GET | `/api/prospector/campaigns?active=true` | Campagnes actives |
| GET | `/api/prospector/prospects?campaign_id=...` | Profils existants d'une campagne |
| POST | `/api/prospector/sync` | Synchroniser les profils extraits |
| POST | `/api/scraping/summary` | Persister le résumé d'exécution |

---

**Version :** V3 — Persistance résumés (scraping_summaries), auth Bearer token
**Mise à jour :** 2026-04-09
