# Audit Prospector — 2026-04-22

**Branche** : `chore/audit-prospector`
**Contexte** : audit demandé après merge de `feat/emelia-import` sur master. Objectif = incohérences, bugs, code mort, API obsolètes.

---

## Synthèse exécutive

| Catégorie | Findings | Action menée |
|---|---|---|
| Endpoints serveur obsolètes | 2 endpoints Task 1 orphelins + 6 endpoints "DEAD-looking" mais documentés | 2 supprimés, 6 signalés pour décision |
| Code mort frontend (`prospector.js`) | 3 fonctions + 2 variables + 1 console.log debug | Tout supprimé |
| Résidu Task 1 | Endpoints `/api/scraping/*`, `RESUME.md` obsolète, table DB inutilisée | Endpoints retirés, RESUME.md flaggé stale |
| Docs incohérentes | `CLAUDE.md` référence V7 et `SKILL.md` inexistants | `CLAUDE.md` corrigé |
| React `src/` | Pas mort — sert login + formulaire campagne | Conservé tel quel |
| Dispatch automation | Endpoints intouchés (safety par défaut) | — |

---

## 1. Endpoints serveur

### 1.1 Endpoints Task 1 orphelins — **SUPPRIMÉS**

Les commits récents (`0a7167d feat: remove Task 1 scraping infrastructure`) ont retiré `/sync`, `/incomplete`, `/enrich`, mais les endpoints de **reporting** correspondants sont restés :

| Méthode | Route | server.js (avant) | État |
|---|---|---|---|
| GET | `/api/scraping/summaries` | 5998–6016 | **Supprimé** — aucun caller (frontend, scripts, src/) |
| POST | `/api/scraping/summary` | 6018–6067 | **Supprimé** — aucun caller |

Seules références restantes : `skill_prospector_V10_backup.md` (archive volontaire, laissée intacte).

### 1.2 Endpoints "DEAD" sans caller mais documentés dans V11 — **À TA DÉCISION**

Ces endpoints n'ont **aucun caller** dans le repo (ni frontend, ni scripts), mais sont documentés dans `skill_prospector_V11.md`. Je ne les ai **pas retirés** : probablement destinés à des consommateurs externes (Dispatch, outils tiers).

| Méthode | Route | Ligne server.js | Doc V11 | Avis |
|---|---|---|---|---|
| POST | `/api/prospector/import` | 4037 | oui | Import JSON générique. Semble redondant avec `/import-emelia` ; probablement usable par Dispatch externe |
| GET | `/api/prospector/export` | 4195 | non | Export CSV. Pas de bouton UI. **Bon candidat suppression** si jamais exposé |
| GET | `/api/prospector/validated-profiles` | 4521 | oui (§213) | Utilisé par Dispatch Task 2 ? à confirmer |
| GET | `/api/prospector/status-history/:id` | 4684 | non | Audit trail. Pas de consommateur |
| POST | `/api/sequences/stop` | 5858 | oui (§348) | Référencé dans workflow doc |
| GET | `/api/sequences/states` | 6072 | non | Pas de consommateur visible |

**Recommandation** : passer en revue Dispatch + outils externes, puis soit supprimer, soit ajouter un commentaire `// Called by <système>` pour justifier leur présence.

### 1.3 Endpoints DISPATCH-ONLY — **CONSERVÉS** (safety par défaut)

Tous les endpoints dont le commentaire inline mentionne Dispatch/automation sont conservés (règle CLAUDE.md : "NEVER modify prospector.js without careful review") :

- `GET /api/prospector/pending-messages`
- `POST /api/prospector/message-sent`
- `GET /api/sequences/due-actions`
- `POST /api/sequences/complete-step`
- `POST /api/dispatch/summary`
- `POST /api/sequences/bulk-generate-messages`

---

## 2. Code mort frontend (`public/js/prospector.js` + `dist/js/prospector.js`)

### Fonctions supprimées (HIGH confidence, zéro caller après grep global)

| Fonction | Ligne avant | Taille | Raison |
|---|---|---|---|
| `_seqBadgeHtml(s)` | 745 | 8 lignes | Retourne du HTML de badge pour séquence — aucun caller |
| `initCardDrag()` | 1546 | 57 lignes | Drag-reorder des cartes campagne — défini mais jamais appelé |
| `_onStepTypeChange()` | 2348 | 1 ligne | Fonction vide avec commentaire `// no longer needed in split panel` |

### Variables supprimées

| Variable | Ligne | Raison |
|---|---|---|
| `let _prospectFilters = {};` | 372 | Déclarée, jamais lue ni assignée |
| `let _seqStatesCache = null;` | 2016 | Commentaire "cache for list badges" — jamais implémenté |

### Debug leftover supprimé

- `console.log('Account changed to:', e.detail?.name);` (ligne 3439)

**Total retiré** : ~70 lignes de code mort.

---

## 3. Résidu Task 1 (après commit `0a7167d`)

### Code serveur — **TRAITÉ**

- ✅ Endpoints `/api/scraping/summaries` + `/api/scraping/summary` supprimés (§1.1)
- ⚪ Statuts `scrapping_pending` et `Profil incomplet` restent valides dans les constantes `VALID_PROSPECT_STATUSES` / `ACTIVE_PROSPECT_STATUSES` (server.js ~4231, 4240). **Gardés** — prospects historiques avec ces statuts existent encore en DB (cf. `scripts/purge-incomplete-prospects.js`).

### Migrations — **GARDÉES** (historique)

| Migration | Status | Justification |
|---|---|---|
| `10_scraping_summaries.sql` | Table inutilisée | Orpheline après suppression endpoints. **Pas supprimée** — migrations SQL sont du versioning historique, on ne réécrit pas le passé. À envisager : `DROP TABLE scraping_summaries` via nouvelle migration |
| `17_profil_incomplet_status.sql` | Statut toujours valide | Utilisé par UI + purge script |
| `20_scraping_workflow_v2.sql` | Colonnes dormantes | `scrapping_attempts` plus utilisée — à retirer via migration future |

### Scripts — **GARDÉS**

- `scripts/purge-incomplete-prospects.js` — utilitaire one-shot pour nettoyer les prospects "Profil incomplet" d'un botched run 2026-04-19. À supprimer **une fois exécuté**.
- `scripts/fix-stuck-prospects.js`, `scripts/regenerate-salesnav-urls.js` — non audités (hors scope Task 1)

### Docs

- ✅ `CLAUDE.md` — corrigé (§4)
- ⚠️ `RESUME.md` — **très obsolète** (dernière maj 2026-04-07). Mentionne Task 1 actif, 9 migrations (on en a 21), liste d'endpoints dépassée. J'ai ajouté un bandeau STALE en tête de fichier plutôt que de le réécrire intégralement — une réécriture complète nécessite ton input sur la vision du projet.

---

## 4. Documentation

### `CLAUDE.md` — **CORRIGÉ**

Problèmes trouvés :
- Référence à `skill_prospector_V7.md` (n'existe pas, actuellement V11)
- Référence à `SKILL.md` (n'existe pas)
- Description `AUTH_SETUP.md` dit "Magic Link" alors que le fichier décrit du **PIN-based auth**
- `public/js/prospector.js` décrit comme "Dispatch system" — c'est en fait le **SPA frontend complet** (Dispatch est un consommateur externe)
- Estimation server.js à "~6000 lignes" — fait ~7550

Corrections appliquées (voir diff CLAUDE.md).

### Autres docs

| Fichier | État | Action |
|---|---|---|
| `skill_prospector_V11.md` | À jour | — |
| `skill_prospector_V10_backup.md` | Archive volontaire | **Ne pas toucher** |
| `AUTH_SETUP.md` | Contenu correct (PIN-based) | — |
| `RLS_SETUP.md` | Correct | — |
| `RESUME.md` | Très obsolète | Bandeau STALE ajouté |
| `CONTEXT_PROPOSAL_ENGINE.md` | Pas audité (hors Prospector) | — |
| `CRM/DISPATCH_INSTRUCTIONS_DEPRECATED.md` | Déjà marqué DEPRECATED dans le nom | Laissé en place |
| `CRM/PROSPECTOR_BRIEF.md` | Référence `/import` + `/export` — cohérent avec endpoints encore présents | — |
| `parking-lot.md` | Roadmap en cours | — |
| `docs/superpowers/plans/2026-04-21-emelia-import.md` | Plan sprint actif | — |
| `claude-code-prompt-nouveau-mode-recherche.md` | Spec feature (commit d'aujourd'hui) | — |

---

## 5. Duality React (`src/`) vs Vanilla JS (`public/js/`)

**Verdict : les deux sont vivants, pas de code mort.**

- `public/prospector.html` (vanilla JS) = SPA principale — servie sur `/prospector`
- `src/App.jsx` (React/Vite) = pages d'auth + formulaire campagne — servi sur `/prospector-login`, `/campaigns/new`, `/campaigns/edit/:id`
- Les 7 composants `src/components/campaigns/*.jsx` (GeoSearch, HeadcountPicker, KeywordTagInput, SalesNavTagInput, SalesNavUrlPreview, SectorSelector, SeniorityPicker) sont tous importés par `CampaignFormPage.jsx` — **aucun n'est orphelin**.

---

## 6. Bugs et incohérences potentiels (non corrigés — à review)

Choses repérées pendant l'audit qui ne sont **ni mort, ni doc, ni cleanup trivial** :

1. **`server.js` ~4130** (`/import-emelia`) — la dédup historique excluait les statuts `"Non pertinent"` et `"Perdu"` via `.not('status', 'in', ...)`. La nouvelle version (ton commit `a24dcfc`) retire ce filtre et dédup sur **tous les statuts**. C'est voulu selon V11 (pour éviter les doublons vanity vs encoded), mais ça a un effet de bord : un prospect en `"Non pertinent"` bloquera un ré-import ultérieur. Volontaire ?

2. **`prospector.js` ~3200** (`_emeliaIsPreselected`) — pattern propre, mais la variable est une "singleton mutable" dans l'IIFE, potentielle fuite d'état si l'utilisateur ouvre le wizard, abandonne, puis revient via un autre chemin. Pas bloquant.

3. **`server.js` ~4231** (`VALID_PROSPECT_STATUSES`) — contient `'scrapping_pending'` (double `p` = typo historique) et `'Profil incomplet'`. Si tu veux nettoyer les statuts legacy, il faut une migration + update des prospects en base d'abord.

4. **`dist/js/prospector.js` et `public/js/prospector.js` sont identiques** mais tous deux committés. La source est `public/`, `dist/` est généré par Vite (copie de `public/` + bundle React). **Les deux versionner crée un risque de drift.** Piste : soit gitignore `dist/js/prospector.js` (et laisser Vite/CI le régénérer), soit tout garder et automatiser la copie via hook pré-commit. Hors scope ici.

5. **`package.json`** — `lucide-react` et `react-router-dom@^7` listés en deps. Vérifier que toutes les deps React sont réellement utilisées (hors scope).

6. **Test préexistant en échec sur `master`** : `utils/buildSalesNavUrl.test.js` ligne 79 — le test attend `"keywords:"` dans l'URL construite pour `{ keywords: ['Bilan Carbone', 'RSE'] }`, mais `buildSalesNavUrl` retourne aujourd'hui `(recentSearchParam:(doLogHistory:true),spellCorrectionEnabled:true)` sans le segment keywords. Introduit probablement par `627ed17 fix(skill): 3 bugs post Task 1 run + keyword purge from Sales Nav URL` — le fix a retiré les keywords de l'URL Sales Nav mais pas mis à jour le test. **44/45 tests passent.** Non corrigé dans cet audit (hors scope, décision produit à prendre : garder les keywords ou aligner le test).

---

## 7. Actions non menées (à ta décision)

- [ ] Supprimer (ou non) les 6 endpoints "DEAD-looking mais documentés V11" (§1.2)
- [ ] Réécrire `RESUME.md` (ou le retirer — info redondante avec skill V11 + CLAUDE.md)
- [ ] Migration de nettoyage : `DROP TABLE scraping_summaries` + `ALTER TABLE prospects DROP COLUMN scrapping_attempts`
- [ ] Décider du sort de `dist/js/*.js` versionnés (gitignore ? build auto ?)
- [ ] Audit des dependances `package.json` (deps inutilisées ?)

---

## Fichiers modifiés sur cette branche

- `server.js` — retrait endpoints `/api/scraping/summaries` + `/api/scraping/summary` (~70 lignes)
- `public/js/prospector.js` — retrait 3 fonctions + 2 vars + 1 console.log (~70 lignes)
- `dist/js/prospector.js` — idem (miroir)
- `CLAUDE.md` — docs corrigées
- `RESUME.md` — bandeau STALE en tête
- `docs/audits/2026-04-22-prospector-audit.md` — ce rapport

**Total** : ~140 lignes de code retirées, 6 endpoints documentés signalés pour décision.
