# CR hors capitalisation · plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vue « CR hors capitalisation » à côté du CR comptable (contrefactuel « développements restés en charges »), plus la zone fiscale estimative grisée des deux vues.

**Architecture:** Module pur `utils/crRetraite.js` (calculs + invariants, TDD) ; branchement additif dans `/api/ebe` (champ `retraite`, détail des dotations par immo, correctif année NULL, invariant données réelles, effet cumulé) ; front `pilot.html` (pastilles de vue, pont de réconciliation, zone grisée, modales, bandeaux). Miroir trésorerie `computeResultatFactuelForYear` INTOUCHÉ.

**Tech Stack:** Node/Express CommonJS, jest, vanilla JS front (pilot.html), Supabase lecture seule via helpers existants.

**Spec de référence (FAIT FOI) :** `docs/superpowers/specs/2026-08-13-cr-retraite-design.md` (sections A à E, questions cabinet, annexe). Chaque tâche a un brief détaillé dans `.superpowers/sdd/2026-08-13-cr-retraite-design/`.

## Global Constraints

- Backend CommonJS (`require`/`module.exports`) ; JAMAIS de tiret cadratin « — » nulle part ; textes UI en français.
- `public/pilot.html` et `dist/pilot.html` bit-identiques après toute modif (copie + `cmp`).
- `public/js/prospector.js` intouché. Miroir `computeResultatFactuelForYear` intouché. Aucun consommateur existant de `/api/ebe` cassé (champ `retraite` additif).
- Aucun appel HTTP de test (jest uniquement) ; aucune écriture Supabase ; le serveur du port 3000 n'est pas à nous.
- Tests : `npx jest` vert au départ (381) et à l'arrivée (381 + nouveaux). `node --check server.js` après toute modif serveur.
- Commits en français `feat(pilot) cr-hors-capitalisation : ...` terminés par `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Barème IS : 15 % jusqu'à 42 500 €, 25 % au-delà (valeurs par défaut ; `computeIS` de server.js reste la source unique, passé en paramètre au module pur).

---

### Task 1: Module pur `utils/crRetraite.js` (TDD)

**Files:**
- Create: `utils/crRetraite.js`
- Test: `utils/crRetraite.test.js`

**Interfaces (Produces):**
- `computeCrRetraite({ ebe:{factuel,projete}, amortissements, productionImmobilisee:{factuel,projete}, dotationsParImmo:[{nom,dotation,aPostes,assietteCredit}], creditTotal, isFn })` → `{ ebe:{factuel,projete}, dotationsNeutralisees:{montant,parImmo:[{nom,dotation}]}, amortissements, resultatExploitation:{...}, is:{...}, impotNet:{...}, resultatNet:{...}, creditAdosseAuxDotations }` (formules spec A.1-A.6).
- `computeEffetCumule(serie, anneeCible)` avec `serie = [{annee, productionImmobilisee, dotationsNeutralisees}]` → `{ montant, anneeBascule }` (spec B.5).
- `verifierInvariantImmos(items)` avec `items = [{nom, sommeProductionImmobilisee, montantAmortissable}]` → `[{nom, ecart}]` pour |écart| > 2 € (spec B.3).

- [ ] Écrire les tests RED (invariants I1 à I6 + effet cumulé + invariant immos, spec D) ; les exécuter, vérifier l'échec.
- [ ] Implémenter le module minimal ; `npx jest utils/crRetraite.test.js` vert.
- [ ] `npx jest` complet vert ; commit.

### Task 2: Serveur (`/api/ebe`)

**Files:**
- Modify: `server.js` (`sumDotationsForYear` ~925, `/api/ebe` ~9294-9451 ; `computeResultatFactuelForYear` INTERDIT de modification)

**Interfaces:**
- Consumes: les 3 fonctions du Task 1 ; helpers existants (`fetchPostesByImmo`, `montantAmortissable`, `computeDotationForYear`, `computeProductionImmobilisee`, `computeIS`, `computePlanAmortissement`).
- Produces: `computeDotationsDetailForYear(year)` → `{ total, parImmo:[{nom,dotation,aPostes,assietteCredit}] }` (tolérante, spec B.1) ; champ `retraite` dans `/api/ebe` = sortie du module + `effetCumule` + `invariantCasse` (spec B.3/B.5).

- [ ] `computeDotationsDetailForYear` + wrapper `sumDotationsForYear` (appelants intacts) ; correctif année NULL (repli mise en service, patron de `sumCreditsForYear` ~953, spec B.2).
- [ ] Branchement `retraite` dans `/api/ebe` (module pur + série effet cumulé + invariant données réelles, zéro fetch supplémentaire) ; log `[retraite] ...`.
- [ ] `node --check server.js` ; `npx jest` complet vert ; commit.

### Task 3: Front (pilot.html ×2)

**Files:**
- Modify: `public/pilot.html` (zone CR ~3934-3972 et ~14130-14400) puis copie exacte vers `dist/pilot.html`

**Interfaces (Consumes):** `d.retraite` de `/api/ebe` (Task 2), patrons existants (`.cr-year-btn`, `row()/subRow()`, bloc Estimatif gris, `_crAlerteHtml`, `escapeHtml`, `formatEuro`).

- [ ] Pastilles « CR comptable / CR hors capitalisation » (`crViewMode`), Projeté décoché par défaut en vue hors capitalisation + badge « pipeline pondéré inclus » (spec C.1) ; renommage case « Colonne projetée (année complète + pipeline pondéré) ».
- [ ] Pont de réconciliation + phrase fixe + tableau hors capitalisation + modales (dotations avec cumul/année de bascule, IS) (spec C.2-C.4).
- [ ] Zone fiscale estimative grisée des DEUX vues + infobulles EBITDA/RCAI (spec C.6-C.7) ; bandeaux conditionnels (déficit, invariantCasse, badge quote-parts env `PILOT_QUOTEPARTS_VALIDEES`) (spec C.5).
- [ ] Copie dist + `cmp` ; `npx jest` vert ; commit.

## Self-review

Couverture spec : A→T1, B→T2, C→T3, D→T1 (+B.3 côté T2), E documentaire (rien à coder sauf bandeaux C.5), questions cabinet hors code, réglage 236-I HORS LOT (non codé). Types cohérents entre T1 (Produces) et T2/T3 (Consumes). Pas de placeholder.
