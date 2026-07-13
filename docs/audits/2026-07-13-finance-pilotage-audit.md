# Méga-audit Releaf Pilot : Onglets Finance & Pilotage

**Date :** 13 juillet 2026
**Périmètre :** Cockpit, Dashboard, Facturation, Analyse clients, Trésorerie/P&L/EBE, Analytics, KPI/Primes, Masse salariale, Scénarios, Frais km : `server.js` (11 386 l.) + `public/pilot.html` (16 968 l.) + `utils/`.
**Méthode :** 14 auditeurs de domaine + 6 lenses transverses (sécurité, perf, archi, intégrité, UX, game-changers) → dédup → vérification adversariale à 2 voix des 26 findings critical/high (26/26 confirmés, 0 réfuté) → jury de 3 juges sur 83 opportunités → critique de complétude. 70 agents, 1 132 lectures de code.
**Rapport interactif :** https://claude.ai/code/artifact/43941cbd-0214-4d28-be7d-f7a5c93280e6

> **Verdict.** Outil riche et bien pensé (5 sources croisées, moteur de projection sérieux). Le risque n'est pas qu'il plante mais qu'il **affiche un chiffre faux sans le signaler** : panne d'API → zéros crédibles sans alerte, mélange HT/TTC, bornes de mois, doubles comptages. La plupart des correctifs critiques sont courts (XS/S).

---

## 🔴 Critiques : chiffres faux, silencieux, qui pilotent le cash

### C1. Panne Qonto avalée en silence, puis cache 5 min : `server.js:3914`
Si Qonto tombe (token expiré, 429), l'API répond 200 avec `soldeActuel=null` et tous les mois clos à 0 €, et met ce résultat vide en cache 5 min. Aucun flag `qontoError` (alors que `pennylaneError` existe et est affiché l.12985). L'écran qui sert à décider si les salaires passent montre des zéros crédibles.
**Fix :** capturer `qontoError`, ne pas écrire le cache si solde vide, bandeau front symétrique de Pennylane. **Effort S.** (6 auditeurs)

### C2. Crédits Plan_TRE en double sur les mois clos (cash fantôme) : `server.js:5776`
Un crédit du GSheet (ex. crédit d'IS ~15,8 k€) est ajouté aux encaissements d'un mois clos sans contrepartie décaissement. Le `soldeFin` du mois est gonflé et le cumul propage l'erreur sur toute la courbe 13 mois.
**Fix :** `creditsPlanTre: isClos ? 0 : montant` (comme déjà fait pour `creditTvaPlanTre` l.5730). + test jest. **Effort XS.**

### C3. Charges futures = 0 € en silence hors périmètre du Sheet : `server.js:5642`
Tout mois non couvert par le Plan_TRE (année N+1 non saisie) est projeté à 0 € de charges → solde de fin de courbe qui s'envole. Pire : si `parsePlanTresorerie` renvoie `error` sans throw, TOUS les mois futurs passent à 0 sans warning, caché 10 min.
**Fix :** `if (data.error) throw` ; marquer `chargesMissing` et hachurer côté front. **Effort S.**

### C4. Double comptage des factures « englobantes » liées à 2 lignes : `server.js:4848`
Une facture Pennylane liée à 2 lignes (cas encouragé par la popup « Garder ») pousse son `remainingAmount` TTC entier 2× dans `facturesAEncaisser`. Une facture SAUR de 30 k€ → +30 k€ de trésorerie prévisionnelle fantôme + alerte cockpit gonflée.
**Fix :** dédup par `invoiceNumber` (Set global) avant push, ou prorata. **Effort S.**

### C5. Toggle « Salariés baseline » OFF double-compte la masse salariale : `server.js:4775`
Scénario `include_salaries_baseline=false` + GSheet ON : garde la vraie masse salariale dans CR_Prev ET ajoute 100 % de l'équipe fictive → +35-45 k€/mois, 200-400 k€ sur l'horizon. Tout scénario de restructuration paraît catastrophique.
**Fix :** `delta = total - baselineTotal` quand `includeGSheet=true`. **Effort S.**

### C6. Confidentialité masse salariale illusoire : `server.js:4604`
`/api/auth-masse-salariale` ne pose aucun jeton (mdp défaut `'admin'`). Les salaires nominatifs sont servis par `/api/scenarios/baseline/salaries`, `/masse-salariale-monthly`, `/api/debug/masse-salariale` et `/api/tresorerie` sans vérifier ce mdp : seule la session TOTP (partagée) suffit.
**Fix :** middleware serveur (cookie signé) sur les 4 endpoints, retirer le détail de `/api/tresorerie`, supprimer l'endpoint debug, refuser de démarrer sans `MASSE_SALARIALE_PASSWORD`. **Effort M.**

---

## 🟠 Élevés : indicateurs faux ou décisions faussées

| # | Titre | Emplacement | Effort |
|---|-------|-------------|--------|
| E1 | **EBE mélange CA HT et charges TTC** : la TVA (jusqu'à ~100 k€/550 k€), l'IS, le remboursement BPI et les virements internes sont comptés en charges → EBE sous-estimé, courbe qui saute de ~20 % entre mois réel/budgété. Fix : normaliser HT, exclure IS/emprunts/transferts. | `server.js:7500`,`:7198` | M |
| E2 | **Charges du dernier mois tronquées au 28** : les débits des 29-31 (paie, URSSAF) disparaissent → EBE surestimé en permanence. Fix : vrai dernier jour du mois + test. | `server.js:7217` | XS |
| E3 | **EBE « factuel » asymétrique** : CA facturé YTD (6 mois) vs 12 mois de charges → EBE apparaît négatif à mi-année. Oublie le reste-à-facturer signé. Fix : YTD vs YTD ou atterrissage annuel. | `server.js:7488` | M |
| E4 | **Base des primes ignore l'année** : un solde 2024 non émis gonfle 2025 ET 2026 ; un palier = 3-4,5 k€ de prime en écart, partagés entre associés. Fix : filtrer sur l'année de la mission + test. | `utils/billing.js:60` | S |
| E5 | **CA 2025 hardcodé** dans `/api/dashboard` : tout le « vs N-1 » figé sur 425,8 k€ fabriqués (≠ ~550 k€ réel), drill-down 2025 vide. Fix : table Supabase d'overrides. | `server.js:1331` | M |
| E6 | **Fenêtre Qonto figée à 6 mois** vs scénarios en année civile → solde d'ancrage faux, premiers mois à 0 € en fin d'année. Fix : `monthsBack` dynamique. | `server.js:3912` | S |
| E7 | **Année 2026 codée en dur (front)** : bombe au 01/01/2027, front/back divergent. Fix : `new Date().getFullYear()` + libellés dynamiques. | `pilot.html:6299` | XS |
| E8 | **`formatEuro` affiche « 0 € »** pour toute donnée manquante → trou indistinguable d'un vrai zéro. Fix : `--` pour null/NaN. | `pilot.html:6277` | S |
| E9 | **Deux définitions du « CA signé HubSpot »** : `/api/dashboard` ne filtre pas le pipeline, kanban/primes si → « le CA de juin » diffère selon la page. Fix : filtre `default` partout. | `server.js:408` | S |
| E10 | **Verrou anti-bruteforce TOTP contournable** : se cale sur `X-Forwarded-For` spoofable, pas de `trust proxy`. Fix : `trust proxy` + compteur global. | `server.js:139` | S |

---

## 🟡 Moyens

| # | Titre | Emplacement | Effort |
|---|-------|-------------|--------|
| M1 | Preset « Mois dernier » exclut le dernier jour (fuseau `toISOString`) → factures fin de mois hors CA. | `pilot.html:10228` | XS |
| M2 | Deal fictif : encaissement HT mais TVA reversée M+1 → tréso sous-estimée de 20 %/deal. | `server.js:5157` | S |
| M3 | Objectifs CA en `localStorage` → divergents par navigateur/associé, nuls après vidage cache. | `pilot.html:6264` | S |
| M4 | Overrides de statut Supabase « obsolètes » toujours appliqués → un ancien « Payé » masque un impayé, fausse les primes. | `pilot.html:11728` | S |
| M5 | Erreurs Pennylane/masse salariale jamais affichées sur le cockpit → « 0 en retard » en vert alors que la donnée manque. | `pilot.html:15760` | S |
| M6 | « Ticket moyen »/« Nb factures » comptent des clients distincts, pas des missions → surestimé (SAUR = 1). | `pilot.html:10871` | S |
| M7 | « CA par client » inclut les missions annulées/non facturées → alertes de concentration faussées. | `pilot.html:15967` | S |
| M8 | `computeCommercialSigned` : erreur Supabase avalée + pas de pagination (>1000 lignes) → commissions à 0 silencieuses. | `server.js:676` | S |

---

## ⚙️ Performance & architecture

- **P1** Cockpit : 3 endpoints en série + 5,4 s d'animation → peut dépasser la minute à froid. Fix : `Promise.all` + animation ~1 s. `pilot.html:15620` : S
- **P2** Cold path Pennylane : ~150 appels `/matched_transactions` séquentiels à chaque expiration de cache (10 min) → 30-60 s. Fix : persister `paidAt`, delta seulement. `server.js:3797` : M
- **P3** Tous les caches in-memory → chaque redeploy Render repart à froid (40-60 s au 1er user). Fix : warm-up au boot. `server.js:3710` : M
- **P4** `/api/dashboard` repagine tout l'historique HubSpot à chaque appel + toutes les 5 min, sans cache. Fix : cache 5 min. `server.js:408` : S
- **P5** Scénarios : ~30 appels Qonto/comparaison (URL avec timestamp ms → cache jamais réutilisé). Fix : arrondir `since` au jour. `server.js:3894` : S
- **A1** ~5 % de la logique financière testée : `buildPrevisionnel` (1 005 l.) enfermé dans `server.js`, non testable. Fix : extraction progressive des fonctions pures vers `utils/` + fixtures. `server.js:4798` : L

---

## 🕳️ Angles morts (critique de complétude)

1. **⚠️ Frais km : trajets fabriqués à rebours depuis un montant cible** (`server.js:3516`) : `/api/frais-km/generate` prend un montant de remboursement voulu et reconstruit des itinéraires pour l'atteindre. **Point de vigilance URSSAF/fiscal à trancher avec l'expert-comptable** : pas un bug, une décision à assumer.
2. **Aucun backup Supabase** des données saisies main (overrides, objectifs, config primes, scénarios) : perte définitive en cas d'incident.
3. **Dettes fournisseurs invisibles** : `fetchSupplierInvoices()` est du code mort → la tréso ne voit que le budget, jamais les factures fournisseurs réelles.
4. **Robustesse process** : `node:22-slim` → une promesse rejetée non catchée tue le process ; pas de healthcheck ni monitoring.
5. **Subvention BPI France 2030 de 100 k€ orpheline** (`data/revenus-exceptionnels.json`) après dépréciation de la table : à vérifier qu'elle est reprise ailleurs.

---

## 🚀 Game changers (jury CFO / Faisabilité / Fit TDA, /10)

| Score | Type | Levier | Effort |
|------:|------|--------|--------|
| 9.0 | game-changer | **Alertes proactives quotidiennes** (mail/Slack) : le cockpit vient à toi | S |
| 8.7 | game-changer | **Alerte « point bas de trésorerie »** (seuil salaires + TVA) | M |
| 8.7 | game-changer | **Relances impayés en 1 clic** depuis Facturation | M |
| 8.7 | quick-win | **Bloc « Prochaine action »** en tête de cockpit (mode TDA) | S |
| 8.7 | game-changer | **Étendre le MCP `releaf-deals` à la finance** (interroger la tréso en langage naturel) | S |
| 8.7 | quick-win | **Module DSO + machine à relances** | M |
| 8.3 | game-changer | **Vue « atterrissage annuel »** (facturé + reste à facturer signé + pipeline) : répare aussi E3 | M |
| 8.3 | game-changer | **Digest hebdo automatique** (lundi matin : 5 chiffres + 3 actions) | M |
| 8.3 | quick-win | **Carte « TVA du mois »** sur le cockpit | S |
| 8.0 | quick-win | **Auto-rapprochement bancaire** (mois clos vs solde Qonto réel) | S |

---

## Feuille de route proposée

- **Sprint 1 : Colmater (quelques heures) :** C1, C2, E2, E7, E8 (fuites silencieuses, XS/S, gros impact fiabilité).
- **Sprint 2 : Méthode (1-2 j) :** E1, E3, C3, C4, C5, E4, E5.
- **Sprint 3 : Verrouiller (1 j) :** C6, E10, backup Supabase (angle mort 2), warm-up (P3).
- **Sprint 4 : Game changers (itératif) :** « Prochaine action » + carte TVA → alertes proactives → MCP finance → relances/DSO ; tests (A1) en fond.
