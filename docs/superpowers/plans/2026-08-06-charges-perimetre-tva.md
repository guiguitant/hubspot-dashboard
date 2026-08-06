# Charges : périmètre, TVA, fenêtrage · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre le total de charges du compte de résultat comptablement juste (périmètre P&L, réel en HT, vraie fin de mois, filtre primes fonctionnel) et rendre les écrans incapables de diverger en silence.

**Architecture:** Deux nouveaux modules purs testés (`utils/chargesPerimetre.js` : normalisation, exclusions, fin de mois ; `utils/tvaCharges.js` : conversion HT par table de taux), branchés dans `computeChargesHybride` et la route legacy `/api/charges`. Corrections ciblées des filtres `> 0` et des libellés front. La spec fait foi : `docs/superpowers/specs/2026-08-06-charges-perimetre-tva-design.md`.

**Tech Stack:** Node.js/Express CommonJS (server.js), utils/ purs testés jest, front vanilla public/pilot.html + dist/pilot.html (identiques), Qonto API, GSheet.

## Global Constraints

- Backend CommonJS ; commentaires en français ; JAMAIS de tiret cadratin « — » (remplacer par « · », deux-points, virgule, point-virgule).
- `public/pilot.html` et `dist/pilot.html` restent IDENTIQUES.
- NE PAS toucher : trésorerie, write-back primes (`syncPrimesToSheet`, `computePrimesChargeSchedule`), moteur `utils/kpiCompute.js`, `public/js/prospector.js`.
- Le prélèvement à la source (référence PAS-DSN) reste en charges : on exclut des SOUS-CATÉGORIES précises, jamais « Impôts et taxes » en bloc.
- Les 213 tests jest existants restent verts (`npm test`) ; `node --check server.js` passe après chaque tâche.
- Un serveur peut tourner sur le port 3000 : ne jamais le redémarrer depuis une tâche, ne jamais envoyer de POST.
- Noms verrouillés : `utils/chargesPerimetre.js` exporte `normalizeLabel(s)`, `isPrimeSubcategory(sousCat)`, `isHorsExploitation(cat, sousCat)`, `monthEndDate(ymKey)` ; `utils/tvaCharges.js` exporte `montantHT(tx, tableTaux)`.
- Chaque commit se termine par : `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Repères code (mesurés par l'audit, à re-vérifier au moment d'éditer)

- `computeChargesHybride` : server.js ~7939-8163. Agrégations réel : ~8013 (catMap), ~8016 (subCatMap), ~8019 (chargesParMoisN), ~8026 (chargesParMoisNm1). Filtre primes actuel : ~8011 (txsN) et ~8022-8023 (txsNm1). Bornes au 28 : ~7992 (N-1) et ~7999 (réel). Réinjection primes : ~8036-8100 (participants ~8055, sousCat ~8083-8085).
- Route legacy `/api/charges` : ~7840-7933 (agrégations ~7865, ~7885, ~7888).
- `/api/previsionnel-charges` : ~8176-8233 ; filtres fautifs ~8208 (`if (sum > 0)`), ~8221 (`if (montant > 0)`), et ~8127 (`prevSubVentilation`, dans computeChargesHybride).
- Parser table TVA : `fetchAndParseCategoriesTVA` ~4838 ; lit la colonne A (~4855 `row[0]`) alors que les noms sont en colonne C ; taux à scanner à partir de la colonne D.
- Constante primes : server.js:27 `PRIMES_QONTO_SUBCAT`.
- Front : carte « Charges annuelles » pilot.html ~4090 (libellé) et ~10218-10244 (`renderChargesCards`) ; commentaire mensonger ~10215-10217 et ~10436.

---

### Task 1 · `utils/chargesPerimetre.js` : normalisation, exclusions, fin de mois

**Files:** Create `utils/chargesPerimetre.js` ; Test `utils/chargesPerimetre.test.js`.

**Produces:**
```js
// Normalise un libelle : minuscules, accents retires, espaces compactes. '' si null.
function normalizeLabel(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}
// Sous-categories Qonto des virements de primes d'associes (liste normalisee, surchargée par env
// PRIMES_QONTO_SUBCATS, valeurs separees par des virgules). Comparaison insensible accents/casse.
const PRIMES_SUBCATS = (process.env.PRIMES_QONTO_SUBCATS || 'Primes associées,Primes commerciales')
  .split(',').map(normalizeLabel).filter(Boolean);
function isPrimeSubcategory(sousCat) { return PRIMES_SUBCATS.includes(normalizeLabel(sousCat)); }
// Sous-categories hors exploitation (PCG) : TVA reversee = compte de tiers, jamais une charge ;
// IS = charge hors exploitation, deja recalculee par computeIS (double compte sinon).
// Le prelevement a la source RESTE en charges : on n'exclut jamais la categorie entiere.
const HORS_EXPLOITATION = ['paiements de la tva', 'impot sur les societes'].map(normalizeLabel);
function isHorsExploitation(cat, sousCat) { return HORS_EXPLOITATION.includes(normalizeLabel(sousCat)); }
// Fin de mois REELLE d'une cle 'YYYY-MM', en heure locale (meme referentiel que le bucketing
// des transactions) : new Date(y, m, 0) = dernier jour du mois m. Remplace la borne fixe au 28.
function monthEndDate(ymKey) {
  const [y, m] = String(ymKey).split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59, 999);
}
module.exports = { normalizeLabel, isPrimeSubcategory, isHorsExploitation, monthEndDate, PRIMES_SUBCATS, HORS_EXPLOITATION };
```

**Steps:** tests d'abord (rouge) : `normalizeLabel('Primes associées ') === 'primes associees'` ; `isPrimeSubcategory('PRIMES ASSOCIÉES')` vrai, `('Primes commerciales')` vrai, `('Salaires')` faux, `(null)` faux ; `isHorsExploitation('Impôts et taxes','Paiements de la TVA')` vrai, `(..., 'Impôt sur les sociétés')` vrai (avec accents : la normalisation doit matcher `impot sur les societes`), `(..., 'Autres impôts et taxes')` faux ; `monthEndDate('2026-07')` → 31 juillet, `('2026-02')` → 28, `('2024-02')` → 29. Puis implémentation, vert, commit `feat(pilot) charges : helpers perimetre (normalisation, exclusions PCG, fin de mois)`.

Attention au test `isHorsExploitation` : la sous-catégorie Qonto réelle s'écrit « Impôt sur les sociétés » (accents) ; vérifier via normalisation que le match tient, sinon ajuster la liste après lecture des libellés réels (voir Task 2 Step 1).

---

### Task 2 · Brancher exclusions + filtre primes dans le réel (hybride + legacy)

**Files:** Modify `server.js`.

- [ ] Step 1 : relever les libellés EXACTS des sous-catégories concernées via `curl.exe -s "http://localhost:3000/api/charges?start=2026-01-01&end=2026-12-31"` (lecture seule) : « Paiements de la TVA », « Impôt sur les sociétés », « Primes associées ». Ajuster la liste de Task 1 si l'orthographe réelle diffère (re-commit utils si besoin).
- [ ] Step 2 : dans `computeChargesHybride`, remplacer le filtre primes actuel (~8011 et ~8022-8023, comparaison `=== PRIMES_QONTO_SUBCAT`) par `chargesPerimetre.isPrimeSubcategory(sousCat)`, et ajouter l'exclusion `isHorsExploitation(cat, sousCat)` juste après, dans les DEUX boucles (txsN, txsNm1). Compter ce qui est exclu : `primesExclues = { nb, montant }` et `horsExploitationExclues = { nb, montant }`, exposés dans l'objet retourné et journalisés en une ligne (`console.log('[charges] exclusions : primes %d€ (%d tx), hors-exploitation %d€ (%d tx)')`). Supprimer la constante `PRIMES_QONTO_SUBCAT` (l'unique vérité devient le module).
- [ ] Step 3 : appliquer les DEUX MÊMES exclusions à la route legacy `/api/charges` (~7860-7890), pour qu'aucun écran ne raconte une autre histoire.
- [ ] Step 4 : `node --check server.js` ; `npm test` ; vérification lecture seule : `/api/charges-hybride?start=2026-01-01&end=2026-12-31` doit baisser d'environ 14 400 (primes) + 31 485 (TVA reversée + IS jan-juil) et exposer les compteurs non nuls. Commit `fix(pilot) charges : exclusions PCG (TVA reversee, IS) + filtre primes fonctionnel (D2/D3/D6)`.

---

### Task 3 · Vraie fin de mois (D4)

**Files:** Modify `server.js` (~7991-7994 et ~7998-8001).

Remplacer les quatre bornes `new Date(... + '-28T23:59:59')` (fenêtre réelle N et fenêtre N-1) par `chargesPerimetre.monthEndDate(cle)`. Les bornes de début restent au 1er. Vérifications : `real.total` attendu ≈ 307 663 AVANT les exclusions de Task 2 (comme les tâches sont séquentielles, vérifier plutôt : la ventilation de juillet contient la paie de fin de mois, et `comparaison.N[6]` (juillet) ≈ 70 188 moins les exclusions ; documenter la valeur mesurée dans le rapport). Vérifier aussi une fenêtre courte (avril seul) qui passait de 43 671 à 15 900 avec le bug. `npm test`, commit `fix(pilot) charges : fenetre reelle jusqu'a la vraie fin de mois (D4)`.

---

### Task 4 · Totaux = somme de leur série (D5)

**Files:** Modify `server.js` (~8208, ~8221, ~8127).

Remplacer les trois `> 0` par `!== 0`. Vérification : `/api/previsionnel-charges?start=2026-01&end=2026-12` → `totalCharges` strictement égal à la somme de `comparaison.N` (l'audit prévoyait 453 883 avant les autres correctifs). `npm test`, commit `fix(pilot) charges : les categories negatives restent dans les totaux (D5)`.

---

### Task 5 · Parser table TVA + module de conversion

**Files:** Modify `server.js` (`fetchAndParseCategoriesTVA` ~4838) ; Create `utils/tvaCharges.js` ; Test `utils/tvaCharges.test.js`.

- [ ] Step 1 : corriger le parser : nom de catégorie en colonne C (`row[2]`), scan des taux à partir de la colonne D. Ajouter la lecture d'une colonne « récupérable » si présente (oui/non, défaut oui). Vérifier : `/api/categories-tva` ne renvoie plus une liste vide.
- [ ] Step 2 : `utils/tvaCharges.js`, fonction pure `montantHT(tx, tableTaux)` :
```js
// Convertit une transaction Qonto (TTC) en charge HT. Priorite : 1) taux de la table pour le
// couple categorie/sous-categorie (cle normalisee) ; 2) taux de la table pour la categorie seule ;
// 3) aucun taux connu : montant TTC inchange (prudence : on ne devine pas).
// Si la table marque la TVA NON recuperable, le TTC est le vrai cout : inchange.
function montantHT(tx, tableTaux) { /* implementation guidee par les tests */ }
```
Tests : taux 20 % → 120 devient 100 ; taux 10 % ; taux 0 % inchangé ; non récupérable inchangé ; catégorie inconnue inchangée ; correspondance insensible aux accents (réutiliser `normalizeLabel`).
- [ ] Step 3 : préparer pour l'utilisateur la liste des ~20 lignes à coller dans le classeur (catégorie Qonto, sous-catégorie, taux, récupérable), depuis la ventilation réelle mesurée : Frais de personnel 0 % SAUF Rémunération dirigeants 20 % (à confirmer comptable), Assurances 0 %, Impôts et taxes 0 %, Banque 0 %, Restauration 10 %, Travel/Transport 10 % NON récupérable, SaaS / Logiciels / Dépenses opérationnelles / administratives 20 %. La livrer dans le rapport, PAS l'écrire dans le classeur.
- [ ] Commit `feat(pilot) charges : parser table TVA (colonne C) + module de conversion HT teste`.

---

### Task 6 · Conversion HT branchée sur le réel

**Files:** Modify `server.js`.

Appliquer `tvaCharges.montantHT(tx, tableTaux)` aux points d'agrégation du réel : computeChargesHybride ~8013/8016/8019 (N) et ~8026 (N-1, impératif pour une comparaison homogène), et route legacy `/api/charges` (~7865/7885/7888). La table est chargée une fois par appel via `fetchAndParseCategoriesTVA` (cache existant). Tant que la table du classeur n'est pas remplie par l'utilisateur, la règle de prudence (« aucun taux connu : TTC inchangé ») fait que ce commit ne change RIEN aux totaux : le vérifier explicitement (totaux identiques avant/après). Commit `feat(pilot) charges : reel converti en HT par taux de categorie (D1, inerte tant que la table est vide)`.

---

### Task 7 · Réinjection primes : corrections annexes de l'audit

**Files:** Modify `server.js` (~8036-8100).

(a) Participants dérivés de l'année de la FENÊTRE (`startKey`), pas de l'année courante ; (b) `sousCat: '.Primes'` (aligné CR_Prev) et commentaire corrigé ; (c) log du montant réinjecté (`[charges] reinjection primes : X€ sur N mois clos`), pour que « zéro » ne soit plus silencieux. `npm test`, commit `fix(pilot) charges : reinjection primes (annee de fenetre, libelle .Primes, log)`.

---

### Task 8 · Front : libellés honnêtes

**Files:** Modify `public/pilot.html` ET `dist/pilot.html` (identiques).

Carte Analytics (~4090) : libellé « Budget de charges HT · CR_Prev » et sous-titre inchangé ; corriger les commentaires mensongers (~10215-10217, ~10436) qui affirment que la carte et le compte de résultat partagent la même source. Aucun changement de logique. Vérifier parité `cmp`, parsing JS, `npm test`. Commit `fix(pilot) charges : la carte Analytics annonce sa source (budget CR_Prev)`.

---

### Task 9 · Recette chiffrée + rattrapage primes 2025 + doc

- [ ] Script de recette (scratchpad, lecture seule) : pour chaque endpoint de charges, vérifier `|total - somme(série mensuelle)| <= nb mois` ; mesurer et consigner les totaux finaux 2025 et 2026 ; comparer aux attendus de la spec §3.
- [ ] Guider l'utilisateur pour le rattrapage primes 2025 : d'abord vérifier que la ligne Primes de Plan_TRE ne recopie pas Masse_salariale, puis saisie 12 000 (Vincent) + 12 000 (Guillaume) en 12/2025 dans `.Primes`, puis mesurer `/api/ebe?year=2025`.
- [ ] Mettre à jour la note mémoire (nouveaux invariants, exclusions, table TVA à maintenir) et marquer les sujets hors lot (subventions, SaaS immobilisé) au parking.
- [ ] Commit doc + rapport final.
