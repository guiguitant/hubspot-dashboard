# Fusion Analytics + Dépenses · plan d'implémentation

> Réf. conception : `docs/specs/2026-07-24-fusion-analytics-depenses-design.md`

**Objectif :** fusionner les onglets Dépenses et Analytics en un seul onglet Analytics à 2 sous-onglets (Chiffre d'affaires, Charges), avec 3 périodes, CA Signé depuis Notion, prévisionnel automatique, et sources étiquetées.

**Architecture :** frontend vanilla JS dans `public/pilot.html` (puis synchro vers `dist/pilot.html`), backend Express CommonJS dans `server.js`. Deux ajouts backend additifs et rétrocompatibles, puis restructuration du DOM/JS de la page Analytics en 3 étapes qui laissent l'app fonctionnelle à chaque commit.

**Stack :** Express (CommonJS), Chart.js, Pennylane API, Qonto API, Notion API, GSheet.

## Contraintes globales

- Backend CommonJS (`require`/`module.exports`), pas d'`import/export`.
- Après chaque édition de `public/pilot.html` : `cp public/pilot.html dist/pilot.html` (le serveur sert `dist/`).
- Textes UI en français, jamais de tiret cadratin « — ».
- Ne pas toucher `public/js/prospector.js` (utilisé par Dispatch).
- `/api/depenses` et `/api/analytics` sont des endpoints dashboard (auth TOTP, mono-tenant) : pas de filtrage `account_id`.
- Vérification : redémarrer le serveur (kill PID port 3000 → `node server.js`), tester via curl + Playwright, 0 erreur JS avant commit.
- Trailer de commit : `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Structure des fichiers touchés

- `server.js` : `/api/analytics` (~7323), `/api/depenses` (~6244) + `fetchDepensesTransactions` (~6231).
- `public/pilot.html` : sidebar (~3354), `page-depenses` (3953-4023, à supprimer), `page-analytics` (4026-4224), fonctions JS Analytics (~9969-10460, 10626+) et Dépenses (~14553-14760), `navigateTo` (~5619) et appels de boot (~14579).
- `dist/pilot.html` : resynchronisé après chaque édition.

---

## Task 1 : Backend · CA Signé depuis Notion dans `/api/analytics`

**Files :**
- Modify : `server.js` (endpoint `/api/analytics`, ~7323-7422)

**Interfaces :**
- Produces : la réponse `/api/analytics` gagne deux champs `caSigne` (number) et `nbSigne` (number).

**Changes :**
- Dans la boucle `for (const m of missions)`, en plus du calcul « facturé » existant, accumuler le signé : une mission est signée si sa date de création Notion (`m.dateCreation`, proxy de la date de signature) tombe dans `[startDate, endDate]`. Ajouter avant la boucle `let caSigne = 0, nbSigne = 0;` puis, dans la boucle :

```js
if (m.dateCreation) {
  const dSign = new Date(m.dateCreation);
  if (dSign >= startDate && dSign <= endDate && m.ca > 0) {
    caSigne += m.ca;
    nbSigne += 1;
  }
}
```

- Ajouter au `res.json({...})` : `caSigne: Math.round(caSigne), nbSigne,`.

- [ ] **Step 1 :** éditer l'endpoint (accumulateurs + ajout au JSON).
- [ ] **Step 2 :** resync non nécessaire (backend). Redémarrer le serveur.
- [ ] **Step 3 :** vérifier : `curl "http://localhost:3000/api/analytics?start=2026-01-01&end=2026-12-31"` renvoie `caSigne` et `nbSigne` cohérents (caSigne >= 0, nbSigne = nb missions créées en 2026).
- [ ] **Step 4 :** commit `refonte(pilot) analytics : /api/analytics expose caSigne + nbSigne (source Notion)`.

---

## Task 2 : Backend · `/api/depenses` accepte start/end + bloc snapshot

**Files :**
- Modify : `server.js` (`fetchDepensesTransactions` ~6231, `/api/depenses` ~6244)

**Interfaces :**
- Produces : `/api/depenses?start=YYYY-MM-DD&end=YYYY-MM-DD` renvoie les agrégats `computeDepenses` scopés à la période ; sans paramètres, comportement actuel (13 mois). La réponse gagne un bloc `snapshot` (Sorties ce mois, Moyenne 6 mois, Récurrentes) toujours calculé sur la fenêtre récente, indépendant de start/end.

**Changes :**
- `fetchDepensesTransactions(fromDate)` : accepter une borne basse optionnelle. Si `fromDate` fourni et plus ancienne que la fenêtre 13 mois par défaut, utiliser `fromDate` comme `value` du filtre Pennylane (pour couvrir Exercice précédent). Garder le singleton anti-concurrence uniquement pour l'appel par défaut (sans param) ; les appels paramétrés font un fetch direct (clé de cache distincte, voir ci-dessous).
- `/api/depenses` : lire `req.query.start` / `req.query.end`.
  - Sans start/end : chemin actuel inchangé (cache `depensesCache`).
  - Avec start/end : fetch Pennylane depuis `min(start, fenêtre récente 6 mois)` jusqu'à maintenant, puis :
    - `computed` = `computeDepenses(txScopedToPeriod)` pour les graphes détail (transactions filtrées `start <= date <= end`).
    - `snapshot` = `computeDepenses(txRecent)` restreint aux 3 indicateurs (sorties mois courant, moyenne 6 mois, récurrentes), calculé sur les 6 derniers mois glissants.
  - Renvoyer `{ ...computed, snapshot, pennylaneError, fetchedAt }`.
- Décision d'implémentation : pour rester simple et éviter deux fetchs, faire un seul fetch couvrant `[min(start, now-6mois), now]`, puis filtrer en mémoire deux sous-ensembles (période pour `computed`, récent pour `snapshot`).

- [ ] **Step 1 :** lire `computeDepenses` (`utils/depensesCompute.js`) pour connaître la forme exacte des agrégats et savoir quoi extraire pour `snapshot`.
- [ ] **Step 2 :** implémenter le paramétrage start/end + snapshot dans l'endpoint.
- [ ] **Step 3 :** redémarrer le serveur.
- [ ] **Step 4 :** vérifier :
  - `curl "http://localhost:3000/api/depenses"` → forme actuelle inchangée + `snapshot` présent.
  - `curl "http://localhost:3000/api/depenses?start=2025-01-01&end=2025-12-31"` → agrégats scopés à 2025, `snapshot` toujours calculé sur le récent.
- [ ] **Step 5 :** commit `refonte(pilot) depenses : /api/depenses accepte start/end (periode) + bloc snapshot`.

---

## Task 3 : Frontend · structure de page + sous-onglet Chiffre d'affaires final

**Files :**
- Modify : `public/pilot.html` (sidebar ~3354 ; `page-analytics` en-tête + période 4026-4082 ; CA sub-tab 4090-4168 ; JS `getPresetRange`/`renderAnalytics`/`refreshAnalytics`)
- Sync : `dist/pilot.html`

**Interfaces :**
- Consumes : `/api/analytics` avec `caSigne`/`nbSigne` (Task 1).
- Produces : page Analytics à 3 périodes, sans ligne de KPI communs, sans EBE/pipeline ; CA sub-tab à 4 cards (`analyticsCa` CA Facturé, nouveau `analyticsCaSigne` CA Signé, `analyticsTicketMoyen`, `analyticsNbMissions`).

**Changes :**
- Sidebar : supprimer le `<button ... navigateTo('depenses') ... data-page="depenses">` (~3354).
- Période : retirer les 4 boutons `annee-courante`, `mois-courant`, `mois-dernier`, `7-jours` ; garder `exercice-courant`, `exercice-precedent`, `custom` (Date personnalisée). Nettoyer `getPresetRange` en conséquence.
- Supprimer la ligne de cards « communes » (4053-4076) : CA Facturé et Charges réelles / Moyenne / EBE.
- CA sub-tab :
  - Supprimer le wrapper toggle pipeline (4093-4096) et le bloc `analyticsCaProjCards` (4111-4137).
  - Remplacer `analyticsCaBaseCards` par 4 cards : CA Facturé (`analyticsCa`), CA Signé (`analyticsCaSigne`, nouveau), Ticket moyen (`analyticsTicketMoyen`), Nb factures (`analyticsNbMissions`).
  - `renderAnalytics(data)` : renseigner `analyticsCa` = `data.ca`, `analyticsCaSigne` = `data.caSigne`, `analyticsNbMissions` = `data.byClient.length` (ou `data.nbSigne` selon libellé « factures »), `analyticsTicketMoyen` = `data.ca / nbMissions`.
  - `refreshAnalytics` : retirer les appels `updateTopChargesKpis`, `updateCaPipelineState`, `updateTopEbeCard`, `updateCaProjCards` (déplacés/supprimés). Garder le fetch `/api/analytics` + `renderAnalytics`.
- `switchAnalyticsTab` : remplacer l'usage de `event.target` par un paramètre d'élément explicite pour permettre le switch programmatique.

- [ ] **Step 1 :** lire `renderAnalytics` (~10626) et `refreshAnalytics`/`selectPreset` (~10354-10460) avant édition.
- [ ] **Step 2 :** éditer sidebar + période + suppression ligne KPI communs.
- [ ] **Step 3 :** éditer CA sub-tab (cards + renderAnalytics + refreshAnalytics).
- [ ] **Step 4 :** `cp public/pilot.html dist/pilot.html`, redémarrer serveur.
- [ ] **Step 5 :** Playwright : ouvrir Analytics, vérifier 4 cards CA (dont CA Signé chiffré), 3 boutons période, bascule Exercice courant/précédent, 0 erreur JS. Le sous-onglet Charges reste fonctionnel (rendu actuel, sans la case prévi retirée en Task 4).
- [ ] **Step 6 :** commit `refonte(pilot) analytics : onglet unifie, 3 periodes, sous-onglet CA (4 cards dont CA Signe)`.

---

## Task 4 : Frontend · sous-onglet Charges final (détail Pennylane + comparatif étiquetés)

**Files :**
- Modify : `public/pilot.html` (Charges sub-tab 4170-4221 ; fonctions Dépenses ~14553-14760 ; `navigateTo` ~5619 ; boot ~14579 ; suppression `page-depenses` 3953-4023)
- Sync : `dist/pilot.html`

**Interfaces :**
- Consumes : `/api/depenses?start=&end=` + `snapshot` (Task 2), `/api/charges-hybride` (existant).
- Produces : sous-onglet Charges = 3 cards snapshot + bloc Comparatif (Qonto+prévi, étiqueté) + bloc Détail (Pennylane, étiqueté, piloté par la période).

**Changes :**
- Charges sub-tab :
  - Retirer la case à cocher prévisionnel (4173-4176) et le bloc `analyticsChargesProjCards` (4178-4203).
  - Ajouter en haut 3 cards snapshot : Sorties ce mois, Moyenne mensuelle 6 mois, Dépenses récurrentes (alimentées par `depensesData.snapshot`).
  - Bloc « Comparatif » (mention source « Réel Qonto + prévisionnel GSheet ») : garder le chart N vs N-1 ; forcer `analyticsChargesPrev = true` par défaut (utiliser `/api/charges-hybride`) ; retirer la dépendance à la checkbox.
  - Bloc « Détail des dépenses » (mention source « Pennylane · saisie comptable ») : rapatrier les sections de `page-depenses` (Sorties par mois `depensesChart`, Répartition par catégorie consolidée, Top 15 fournisseurs, Dépenses récurrentes détectées).
  - Consolidation catégories : une seule vue Pennylane. Réutiliser le graphe `analyticsChargesChart` + toggle Catégories/Sous-catégories s'il y a des sous-catégories Pennylane (sinon Catégories seul) + la table `analyticsChargesDetail`, alimentés par les catégories Pennylane de `depensesData`.
- Rendu Dépenses piloté par la période : `refreshDepensesData` prend `start`/`end` de la période courante ; `renderDepensesChart/Categories/Vendors/Subscriptions` consomment `depensesData` scopé ; `renderDepensesKpis` (3 cards) consomme `depensesData.snapshot` (indépendant de la période).
- Câblage période → Charges : `renderAnalyticsChargesChart` (comparatif) et `refreshDepensesData` (détail) sont rappelés quand la période change et quand on entre dans le sous-onglet Charges.
- Supprimer `page-depenses` (3953-4023). Retirer la branche `if (page === 'depenses')` de `navigateTo` (~5619) et les appels de boot Dépenses (~14579-14583).

- [ ] **Step 1 :** lire les fonctions Dépenses (`refreshDepensesData` ~14553, `renderDepenses*` ~14590-14760) et `renderAnalyticsChargesChart`/`renderAnalyticsChargesDetail` avant édition.
- [ ] **Step 2 :** restructurer le HTML du Charges sub-tab (cards snapshot, blocs étiquetés, sections Pennylane rapatriées).
- [ ] **Step 3 :** adapter le JS (snapshot cards, hybride par défaut, période → détail, consolidation catégories).
- [ ] **Step 4 :** supprimer `page-depenses` + refs navigateTo/boot.
- [ ] **Step 5 :** `cp public/pilot.html dist/pilot.html`, redémarrer serveur.
- [ ] **Step 6 :** Playwright : sous-onglet Charges → 3 cards snapshot chiffrées, chart comparatif rendu (mois futurs hachurés/prévi), sections détail Pennylane rendues, changement de période met à jour le détail, mentions de source visibles, 0 erreur JS.
- [ ] **Step 7 :** commit `refonte(pilot) analytics : sous-onglet Charges (detail Pennylane pilote par periode + comparatif Qonto/previ etiquetes)`.

---

## Task 5 : Frontend · nettoyage du code mort

**Files :**
- Modify : `public/pilot.html` (fonctions Analytics devenues inutiles)
- Sync : `dist/pilot.html`

**Changes :**
- Supprimer les fonctions/variables devenues inutilisées : `toggleChargesPrev`, `toggleCaPipeline`, `updateCaProjCards`, `updateCaPipelineState`, `updateTopEbeCard`, `updateTopChargesKpis`, `buildEbeTooltip`, `getEbeYearForPreset`, `ensureEbeData` (si plus référencée dans cet onglet), `analyticsEbeCache`, cas de preset supprimés dans `getPresetRange`.
- Vérifier qu'aucune référence morte ne subsiste (`grep` sur chaque nom supprimé).

- [ ] **Step 1 :** `grep` chaque symbole pour confirmer non-usage avant suppression.
- [ ] **Step 2 :** supprimer le code mort.
- [ ] **Step 3 :** `cp public/pilot.html dist/pilot.html`, redémarrer serveur.
- [ ] **Step 4 :** Playwright : parcours complet (CA + Charges + 3 périodes), 0 erreur JS ; `grep` final = aucune référence orpheline.
- [ ] **Step 5 :** commit `refonte(pilot) analytics : nettoyage code mort (EBE, pipeline, previ toggle, presets)`.

---

## Auto-revue (plan vs spec)

- Couverture : structure/navigation (T3, T4) · période 3 choix (T3) · CA sub-tab 4 cards dont CA Signé Notion (T1, T3) · Charges 3 cards snapshot + Comparatif Qonto/prévi + Détail Pennylane piloté période (T2, T4) · consolidation catégories (T4) · étiquetage sources (T4) · retrait EBE/pipeline/checkbox/presets (T3, T5) · backend caSigne (T1) + depenses start/end + snapshot (T2). Tout est couvert.
- Ordre sûr : chaque tâche laisse l'app fonctionnelle (T1/T2 additifs, T3 finit le CA en gardant Charges rendu, T4 finit Charges, T5 ne fait que nettoyer).
