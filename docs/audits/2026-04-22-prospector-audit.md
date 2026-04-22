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

### 1.2 Endpoints sans caller — **TRANCHÉ** après confirmation Nathan

> Claude Dispatch n'a d'autre doc que `skill_prospector_V11.md`. Donc : endpoint absent de V11 ∧ aucun caller interne ⇒ **mort**.

| Méthode | Route | Doc V11 | Décision |
|---|---|---|---|
| POST | `/api/prospector/import` (générique JSON) | ❌ absent | **Supprimé** — `/import-emelia` est le seul moyen d'import documenté |
| GET | `/api/prospector/export` | ❌ absent | **Supprimé** |
| GET | `/api/prospector/status-history/:id` | ❌ absent | **Supprimé** |
| GET | `/api/sequences/states` | ❌ absent | **Supprimé** |
| GET | `/api/prospector/validated-profiles` | ✅ V11 §218 | **Gardé** (Dispatch récupère les "Nouveau") |
| POST | `/api/sequences/stop` | ✅ V11 §348, §799 | **Gardé** (Dispatch appelle avec `reason='error'`) |

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

### Migrations — **NETTOYAGE VIA MIGRATION 22** ✅ appliquée

Migration `22_drop_scraping_infrastructure.sql` :
- `DROP TABLE scraping_summaries` (orpheline depuis suppression endpoints)
- `ALTER TABLE prospects DROP COLUMN scrapping_attempts` (plus lue ni écrite)
- `DROP INDEX idx_prospects_scrapping_pending`

**Appliquée sur Supabase le 2026-04-22 par Nathan** via SQL Editor du dashboard.

Les migrations 10, 17, 20 restent en place (historique). Le statut `scrapping_pending` et `Profil incomplet` restent dans la CHECK constraint des prospects — prospects legacy existent encore en DB.

### Scripts — **GARDÉS**

- `scripts/purge-incomplete-prospects.js` — utilitaire one-shot pour nettoyer les prospects "Profil incomplet" d'un botched run 2026-04-19. À supprimer **une fois exécuté**.
- `scripts/fix-stuck-prospects.js`, `scripts/regenerate-salesnav-urls.js` — non audités (hors scope Task 1)

### Docs

- ✅ `CLAUDE.md` — corrigé (§4)
- ⚠️ `RESUME.md` — **supprimé**. Trop obsolète (dernière maj 2026-04-07), redondant avec `CLAUDE.md` + `skill_prospector_V11.md` qui sont les sources à jour. Une réécriture nécessiterait ton input produit ; en attendant, la suppression élimine le risque de lecture trompeuse. Git history le conserve si besoin.

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

1. ~~**`server.js` ~4130** (`/import-emelia`) — la dédup historique excluait les statuts `"Non pertinent"` et `"Perdu"`. La nouvelle version (ton commit `a24dcfc`) retire ce filtre et dédup sur **tous les statuts**.~~ **Confirmé volontaire par Nathan (2026-04-22)**. Un prospect en `"Non pertinent"` ou `"Perdu"` bloquera bien un ré-import futur — comportement attendu pour éviter de retraiter les prospects déjà décidés.

2. **`prospector.js` ~3200** (`_emeliaIsPreselected`) — pattern propre, mais la variable est une "singleton mutable" dans l'IIFE, potentielle fuite d'état si l'utilisateur ouvre le wizard, abandonne, puis revient via un autre chemin. Pas bloquant.

3. **`server.js` ~4231** (`VALID_PROSPECT_STATUSES`) — contient `'scrapping_pending'` (double `p` = typo historique) et `'Profil incomplet'`. Si tu veux nettoyer les statuts legacy, il faut une migration + update des prospects en base d'abord.

4. **`dist/js/prospector.js` et `public/js/prospector.js` sont identiques** mais tous deux committés. La source est `public/`, `dist/` est généré par Vite (copie de `public/` + bundle React). **Les deux versionner crée un risque de drift.** Piste : soit gitignore `dist/js/prospector.js` (et laisser Vite/CI le régénérer), soit tout garder et automatiser la copie via hook pré-commit. Hors scope ici.

5. **`package.json`** — `lucide-react` et `react-router-dom@^7` listés en deps. Vérifier que toutes les deps React sont réellement utilisées (hors scope).

6. ~~Test préexistant en échec~~ — **Corrigé**. `utils/buildSalesNavUrl.test.js` ligne 79 testait `expect(url).toContain('keywords:')`, mais le commit `627ed17 fix(skill): 3 bugs post Task 1 run + keyword purge from Sales Nav URL` a intentionnellement retiré les keywords de l'URL Sales Nav (confirmé par le commentaire inline `buildSalesNavUrl.js:69` : "keywords et instructions Claude ne sont PAS injectés"). Le test a été aligné sur la nouvelle réalité (`expect(url).not.toContain('keywords:')`). **45/45 tests passent.**

---

## 7. Actions restantes (à ta décision)

- [x] ~~Endpoints "DEAD" dans V11 ou non~~ — Tranché (§1.2)
- [x] ~~RESUME.md~~ — Supprimé
- [x] ~~Migration nettoyage scraping~~ — `migrations/22_drop_scraping_infrastructure.sql` créée, **à exécuter sur Supabase quand prêt**
- [x] ~~Test buildSalesNavUrl préexistant~~ — Corrigé
- [ ] **Décider du sort de `dist/js/*.js` versionnés** — soit gitignore + build auto en CI, soit hook pré-commit. Laisse tel quel pour l'instant (architectural)
- [ ] **Audit des dépendances `package.json`** — vérifier `lucide-react`, vieilles deps — hors scope audit
- [x] ~~§6.1 : dédup `/import-emelia` sur tous statuts~~ — Confirmé volontaire par Nathan

---

## Fichiers modifiés sur cette branche

- `server.js` — retrait 6 endpoints morts : `/api/scraping/summaries`, `/api/scraping/summary`, `/api/prospector/import`, `/api/prospector/export`, `/api/prospector/status-history/:id`, `/api/sequences/states` (~230 lignes)
- `public/js/prospector.js` + `dist/js/prospector.js` — retrait 3 fonctions + 2 vars + 1 console.log (~150 lignes au total)
- `CLAUDE.md` — refs obsolètes corrigées (V11 au lieu de V7, PIN au lieu de Magic Link, etc.)
- `RESUME.md` — supprimé (trop obsolète pour être utile)
- `utils/buildSalesNavUrl.test.js` — test aligné sur le comportement post-`627ed17`
- `migrations/22_drop_scraping_infrastructure.sql` — créée (à exécuter manuellement sur Supabase)
- `docs/audits/2026-04-22-prospector-audit.md` — ce rapport

**Total** : **~380 lignes de code retirées**, 6 endpoints obsolètes supprimés, 45/45 tests passent, 1 migration SQL prête à appliquer.
