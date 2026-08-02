# Primes : découplage charge / décaissement + réel figé + état d'avancement · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rattacher la charge d'une prime au bon exercice comptable (dernier mois du trimestre de facturation, décembre pour l'étage 2) au lieu du mois de décaissement, dans le prévisionnel comme dans le réel, et ajouter un écran de suivi de l'avancement des primes.

**Architecture:** Le moteur pur `computePrimePayments` (utils/kpiCompute.js) produit désormais DEUX échéanciers : décaissement (`byMonth`/`byPartnerMonth`, inchangés, pour la trésorerie) et charge (`byMonthCharge`/`byPartnerMonthCharge`/`detailCharge`, nouveaux, pour le compte de résultat). Le write-back GSheet écrit la charge; un helper serveur partagé alimente à la fois le write-back et un nouvel endpoint de suivi; `computeChargesHybride` isole les primes du réel Qonto pour que la charge ne soit jamais re-datée au paiement.

**Tech Stack:** Node.js/Express CommonJS (server.js), fonctions pures utils/ testées avec jest, front vanilla public/pilot.html, Google Sheets (googleapis), Qonto API, Supabase.

## Global Constraints

- Répondre à l'utilisateur en français; ne JAMAIS utiliser de tiret cadratin « — » (remplacer par « · », deux-points, virgule ou point-virgule), y compris dans les commentaires de code.
- Backend en CommonJS (`require`/`module.exports`), pas d'`import`/`export`.
- NE JAMAIS modifier `public/js/prospector.js` (utilisé par l'automatisation Dispatch).
- La source du front est `public/pilot.html`; `dist/pilot.html` est un artefact resynchronisé au démarrage du serveur : appliquer les mêmes changements aux deux fichiers.
- Secrets Google (`client_email`, `private_key`, `private_key_id`) dans `.env` : jamais committés.
- Ne JAMAIS réintroduire un fold des primes dans le JS de l'EBE : le canal charge reste `.Primes → CR_Prev` (formule tableur).
- CONSERVER `byMonth` / `byPartnerMonth` (décaissement) inchangés : la trésorerie et les 194 tests jest en dépendent.
- Les 194 tests jest existants doivent rester verts (`npm test`).
- Noms verrouillés (identiques dans toutes les tâches) : helper `lastMonthOfQuarter(y, q)`; sorties moteur `byMonthCharge`, `byPartnerMonthCharge`, `detailCharge`; helper serveur `computePrimesChargeSchedule(nowIso)`; statuts `'verse'`, `'du'`, `'a_venir'`, `'provisoire'`.
- Chaque message de commit se termine par la ligne : `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Statut « versé » : reste à 0 tant que la Phase 3 (validations `versements`) n'est pas branchée; ne pas tenter de le peupler dans ce lot.

## File Structure

- `utils/kpiCompute.js` (MODIFIER) : helper `lastMonthOfQuarter`; `computePrimePayments` produit les échéanciers de charge + statuts. Cœur pur, testé.
- `utils/kpiCompute.test.js` (MODIFIER) : tests du découplage charge/décaissement, provisions, étage 2, rattrapage plafonné, statuts.
- `server.js` (MODIFIER) : helper partagé `computePrimesChargeSchedule`; write-back sur la charge; suppression `PRIMES_PLANCHER`; `computeChargesHybride` isole les primes Qonto; endpoint `GET /api/primes/avancement`.
- `public/pilot.html` + `dist/pilot.html` (MODIFIER) : 2 sous-onglets KPI + vue « État d'avancement ».
- `docs/superpowers/specs/2026-07-31-primes-gsheet-writeback-design.md` (MODIFIER) : bandeau REMPLACÉ.
- Note mémoire `gsheet-primes-writeback.md` + `MEMORY.md` (MODIFIER) : nouveau modèle.

---

## Convention de statut (verrouillée, utilisée T2 à T9)

Pour chaque entrée de charge d'un deal (étage 1) :
- `'verse'` : le couple est dans `versements` (Phase 3) · aujourd'hui jamais (versements toujours `[]`).
- `'du'` : acompte facturé, mois de décaissement strictement passé (`dateDecaissement < nowKey`), non versé.
- `'a_venir'` : acompte facturé, mois de décaissement présent ou futur (`dateDecaissement >= nowKey`).
- `'provisoire'` : acompte non facturé (provision).

`detailCharge` = liste plate d'objets `{ etage, deal, nom, partner, montant, dateCharge, dateDecaissement, statut }`.
- `dateCharge` = clé `'YYYY-MM'` où la charge est écrite dans le prévisionnel, ou `null` si la charge est déjà portée par le réel Qonto (cas `'du'` dont le décaissement est clos : cf. R4).
- Seules les entrées à `dateCharge` non `null` alimentent `byMonthCharge` / `byPartnerMonthCharge` (ce qui est écrit dans le GSheet). `detailCharge` contient TOUTES les entrées (source de l'écran d'avancement et de la réconciliation).

---

## Task 1: Helper `lastMonthOfQuarter`

**Files:**
- Modify: `utils/kpiCompute.js` (après `monthAfterQuarterClose`, ~ligne 382)
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Produces: `lastMonthOfQuarter(y, q) -> 'YYYY-MM'` (mois de clôture du trimestre : T1→03, T2→06, T3→09, T4→12). Exporté depuis kpiCompute.js.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter dans `utils/kpiCompute.test.js` (après les imports, comme bloc `describe` autonome) :

```js
const { lastMonthOfQuarter } = require('./kpiCompute');

describe('lastMonthOfQuarter : dernier mois du trimestre (date de charge)', () => {
  it('T1->03, T2->06, T3->09, T4->12', () => {
    expect(lastMonthOfQuarter(2026, 1)).toBe('2026-03');
    expect(lastMonthOfQuarter(2026, 2)).toBe('2026-06');
    expect(lastMonthOfQuarter(2026, 3)).toBe('2026-09');
    expect(lastMonthOfQuarter(2026, 4)).toBe('2026-12');
  });
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `npm test -- kpiCompute`
Expected: FAIL, `lastMonthOfQuarter is not a function`.

- [ ] **Step 3: Implémenter le helper**

Dans `utils/kpiCompute.js`, juste après `monthAfterQuarterClose` (~ligne 382) :

```js
// Cle 'YYYY-MM' du dernier mois du trimestre q (1-4) de l'annee y = mois de cloture.
// T1=mars(03), T2=juin(06), T3=sept(09), T4=dec(12). C'est la date de CHARGE (rattachement),
// pendant de monthAfterQuarterClose qui donne le mois de DECAISSEMENT.
function lastMonthOfQuarter(y, q) {
  return y + '-' + String(q * 3).padStart(2, '0');
}
```

Ajouter `lastMonthOfQuarter` à l'objet `module.exports` en bas du fichier.

- [ ] **Step 4: Lancer le test, vérifier le succès**

Run: `npm test -- kpiCompute`
Expected: PASS (le nouveau bloc + les 194 tests existants).

- [ ] **Step 5: Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) primes : helper lastMonthOfQuarter (date de charge = cloture trimestre)"
```

---

## Task 2: Découplage charge/décaissement dans le moteur (étage 1 facturé)

**Files:**
- Modify: `utils/kpiCompute.js` (`computePrimePayments`, lignes 398-490)
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Consumes: `lastMonthOfQuarter` (Task 1); helpers existants `quarterOfDate`, `yearOfDate`, `monthAfterQuarterClose`.
- Produces: `computePrimePayments(...)` renvoie EN PLUS `byMonthCharge` (`{ 'YYYY-MM': montant }`), `byPartnerMonthCharge` (`{ partner: { 'YYYY-MM': montant } }`), `detailCharge` (liste d'objets `{ etage, deal, nom, partner, montant, dateCharge, dateDecaissement, statut }`). `byMonth`, `byPartnerMonth`, `enAttente`, `enAttenteByPartner`, `verse` inchangés.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter dans le `describe('computePrimePayments ...')` de `utils/kpiCompute.test.js` :

```js
it('charge etage 1 : datee au dernier mois du trimestre de facturation (mars), decaissement en avril', () => {
  const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10', participants: ['Vincent'] });
  expect(r.byPartnerMonthCharge.Vincent['2026-03']).toBe(9000); // charge = cloture T1
  expect(r.byPartnerMonth.Vincent['2026-04']).toBe(9000);       // decaissement inchange
  expect(r.byMonthCharge['2026-03']).toBe(9000);
});

it('charge etage 1 : statut a_venir quand le decaissement est futur', () => {
  const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10', participants: ['Vincent'] });
  const e = r.detailCharge.find(d => d.deal === 'a');
  expect(e.dateCharge).toBe('2026-03');
  expect(e.dateDecaissement).toBe('2026-04');
  expect(e.statut).toBe('a_venir');
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npm test -- kpiCompute`
Expected: FAIL, `Cannot read properties of undefined (reading 'Vincent')` sur `byPartnerMonthCharge`.

- [ ] **Step 3: Implémenter les accumulateurs de charge + le calcul étage 1**

Dans `computePrimePayments`, après les accumulateurs existants (`byMonth`, `byPartnerMonth`, `detail`, ~lignes 415-419), ajouter :

```js
  const byMonthCharge = {};
  const byPartnerMonthCharge = {};
  const detailCharge = [];
  const addCharge = (partner, mk, amount) => {
    if (!partner || !mk) return;
    byMonthCharge[mk] = (byMonthCharge[mk] || 0) + amount;
    (byPartnerMonthCharge[partner] = byPartnerMonthCharge[partner] || {})[mk] =
      (byPartnerMonthCharge[partner][mk] || 0) + amount;
  };
```

Dans la boucle étage 1, branche « acompte présent » (aujourd'hui lignes 452-461, celle qui calcule `mk`), remplacer le corps par le calcul des deux dates + statut. Le `mk` de décaissement (et son rattrapage vers `byMonth`) reste EXACTEMENT tel quel; on ajoute la charge à côté :

```js
        // Decaissement (inchange) : M+1 de la cloture du trimestre de facturation.
        const qFact = quarterOfDate(acompte);
        const yFact = yearOfDate(acompte);
        let mk = (qFact && yFact) ? monthAfterQuarterClose(yFact, qFact) : monthAfterQuarterClose(year, q + 1);
        const decaissementMk = mk; // memorise avant rattrapage decaissement
        const isPast = mk < nowKey;
        if (isPast) {
          if (pastPolicy === 'drop') { /* decaissement passe non repris (byMonth) */ }
          else mk = nowKey;
        }
        if (!(isPast && pastPolicy === 'drop')) {
          add(mk, montant, { etage: 1, deal: deal.id, nom: deal.nom, partner: p, montant, rattrapage: isPast });
          addPM(p, mk, montant);
        }

        // Charge (nouveau) : dernier mois du trimestre de facturation. Statut selon le decaissement.
        const chargeMkTheorique = (qFact && yFact) ? lastMonthOfQuarter(yFact, qFact) : lastMonthOfQuarter(year, q + 1);
        const statut = decaissementMk < nowKey ? 'du' : 'a_venir';
        let chargeMk = chargeMkTheorique;
        if (chargeMk < nowKey) {
          // Mois de charge deja clos (R4). Si le decaissement est clos aussi, la charge est
          // deja portee par le reel Qonto (Option B) : ne pas l'ecrire (dateCharge=null).
          // Sinon, reporter au dernier mois du trimestre courant ouvert, sans depasser le decaissement.
          if (decaissementMk < nowKey) chargeMk = null;
          else chargeMk = floorChargeKey <= decaissementMk ? floorChargeKey : decaissementMk;
        }
        addCharge(p, chargeMk, montant);
        detailCharge.push({ etage: 1, deal: deal.id, nom: deal.nom, partner: p, montant, dateCharge: chargeMk, dateDecaissement: decaissementMk, statut });
```

Définir `floorChargeKey` près de `nowKey` (~ligne 402) :

```js
  // Dernier mois du trimestre courant ouvert (plancher de charge dynamique, R3/R4).
  const nowQuarter = quarterOfDate(now) || quarterOfDate((now || '') + '-01') || 1;
  const nowYear = yearOfDate(now) || year;
  const floorChargeKey = lastMonthOfQuarter(nowYear, nowQuarter);
```

Ajouter `byMonthCharge`, `byPartnerMonthCharge`, `detailCharge` au `return` (ligne 489).

Note : la branche « acompte absent » (provision) et l'étage 2 sont traités aux Tasks 3 et 4.

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `npm test -- kpiCompute`
Expected: PASS (nouveaux tests + tous les existants, `byMonth` intact).

- [ ] **Step 5: Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) primes : moteur produit l'echeancier de CHARGE (etage 1 facture) distinct du decaissement"
```

---

## Task 3: Provisions glissantes (étage 1 non facturé) + rattrapage plafonné

**Files:**
- Modify: `utils/kpiCompute.js` (`computePrimePayments`, branche « acompte absent », ~ligne 449)
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Consumes: `addCharge`, `detailCharge`, `floorChargeKey` (Task 2).
- Produces: pour un deal non facturé, une provision dans `byPartnerMonthCharge[partner][floorChargeKey]` + une entrée `detailCharge` `statut: 'provisoire'`, `dateCharge = floorChargeKey`, `dateDecaissement = null`. `enAttente` / `enAttenteByPartner` conservés.

- [ ] **Step 1: Écrire les tests qui échouent**

```js
it('provision : deal non facture pose une charge au trimestre courant ouvert (statut provisoire)', () => {
  const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: null })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-08-10', participants: ['Vincent'] });
  expect(r.byPartnerMonthCharge.Vincent['2026-09']).toBe(9000); // T3 courant -> sept
  expect(r.enAttente).toBe(9000);                                 // conserve
  const e = r.detailCharge.find(d => d.deal === 'a');
  expect(e.statut).toBe('provisoire');
  expect(e.dateDecaissement).toBeNull();
  expect(r.byMonth['2026-09']).toBeUndefined();                   // aucun decaissement
});

it('rattrapage charge plafonne : charge + decaissement passes => aucune charge ecrite (portee par le reel)', () => {
  const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-07-15', participants: ['Vincent'] });
  const e = r.detailCharge.find(d => d.deal === 'a');
  expect(e.dateCharge).toBeNull();     // charge non ecrite (reel Qonto)
  expect(e.statut).toBe('du');
  expect(r.byPartnerMonthCharge.Vincent).toBeUndefined();
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npm test -- kpiCompute`
Expected: FAIL (`byPartnerMonthCharge.Vincent` undefined pour la provision).

- [ ] **Step 3: Implémenter la provision**

Dans la branche « acompte absent » (aujourd'hui ligne 449 : `if (!acompte) { enAttente += montant; enAttenteByPartner[p] = ...; continue; }`), remplacer par :

```js
        if (!acompte) {
          // Provision : pas d'acompte facture => aucun decaissement date, mais on POSE une charge
          // probable au dernier mois du trimestre courant ouvert (glisse a chaque recalcul).
          enAttente += montant;
          enAttenteByPartner[p] = (enAttenteByPartner[p] || 0) + montant;
          addCharge(p, floorChargeKey, montant);
          detailCharge.push({ etage: 1, deal: deal.id, nom: deal.nom, partner: p, montant, dateCharge: floorChargeKey, dateDecaissement: null, statut: 'provisoire' });
          continue;
        }
```

Le second test (rattrapage plafonné) passe déjà grâce à la logique `chargeMk = null` de la Task 2; le vérifier.

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `npm test -- kpiCompute`
Expected: PASS. Vérifier en particulier que le test existant « acompte non facture : en attente, aucun versement » (byMonth vide, enAttente 9000) reste vert.

- [ ] **Step 5: Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) primes : provisions glissantes (deal non facture) + rattrapage de charge plafonne"
```

---

## Task 4: Étage 2 · charge décembre N (provisoire)

**Files:**
- Modify: `utils/kpiCompute.js` (`computePrimePayments`, bloc étage 2, lignes 466-487)
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Consumes: `addCharge`, `detailCharge` (Task 2).
- Produces: charge collective dans `byMonthCharge[year+'-12']` et `byPartnerMonthCharge[partner][year+'-12']`; décaissement inchangé en `(year+1)+'-'+moisE2`. Entrées `detailCharge` `etage: 2`, `statut: 'provisoire'`.

- [ ] **Step 1: Écrire les tests qui échouent**

```js
it('charge etage 2 : datee en decembre N (provisoire), decaissement en mars N+1', () => {
  const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 660000, versements: [], now: '2026-07-15', participants: ['Vincent', 'Guillaume', 'Nathan'] });
  expect(r.byMonthCharge['2026-12']).toBe(10500);              // charge dec N
  expect(r.byMonth['2027-03']).toBe(10500);                    // decaissement inchange (N+1)
  expect(r.byPartnerMonthCharge.Vincent['2026-12']).toBe(3500);
  const e2 = r.detailCharge.find(d => d.etage === 2 && d.partner === 'Vincent');
  expect(e2.dateCharge).toBe('2026-12');
  expect(e2.statut).toBe('provisoire');
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npm test -- kpiCompute`
Expected: FAIL (`byMonthCharge['2026-12']` undefined).

- [ ] **Step 3: Implémenter la charge étage 2**

Dans le bloc étage 2 (lignes 473-486), après le calcul du décaissement `mk` et la répartition existante sur `byPartnerMonth` (inchangée), ajouter la charge décembre N :

```js
      // Charge collective : rattachee a l'exercice N (decembre N), provisoire tant que N n'est pas clos.
      const chargeMkE2 = year + '-12';
      for (const p of parts) {
        addCharge(p, chargeMkE2, share);
        detailCharge.push({ etage: 2, deal: null, nom: 'Prime collective', partner: p, montant: share, dateCharge: chargeMkE2, dateDecaissement: mk, statut: 'provisoire' });
      }
```

(`parts`, `share`, `mk` sont les variables déjà présentes dans le bloc étage 2, lignes 481-484.)

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `npm test -- kpiCompute`
Expected: PASS. Les tests étage 2 existants (byMonth['2027-03'] = 10500, byPartnerMonth en 2027-03) restent verts.

- [ ] **Step 5: Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) primes : etage 2 charge en decembre N (provision), decaissement mars N+1"
```

---

## Task 5: Helper serveur partagé `computePrimesChargeSchedule` + réconciliation

**Files:**
- Modify: `server.js` (remplacer `computePrimesByPartnerMonth`, lignes 8271-8323)
- Vérification: manuelle (pas de harness jest sur server.js) + réutilise les tests moteur.

**Interfaces:**
- Consumes: `computePrimePayments` enrichi (Tasks 2-4), `primesMap.roundPreservingSum`.
- Produces: `computePrimesChargeSchedule(nowIso)` async → `{ byPartnerMonthCharge, detailCharge, participants, reconciliation }` où `reconciliation[partner] = { verse, du, aVenir, provisoire, total }` (entiers, `total = verse+du+aVenir+provisoire`). Énumère les années de signature `[currentYear-2 .. currentYear]` et ne retient dans `byPartnerMonthCharge` que les charges dont le mois tombe dans `currentYear`. Appelle le moteur avec le VRAI `now` (nowIso).

- [ ] **Step 1: Remplacer la fonction**

Remplacer intégralement `computePrimesByPartnerMonth` (lignes 8271-8323) par :

```js
// Echeancier de CHARGE des primes de l'exercice courant, par associe et par mois, + reconciliation
// par statut. Enumere plusieurs annees de SIGNATURE (une charge peut etre facturee l'annee suivant
// la signature) et ne garde que les charges datees dans l'exercice courant. `now` REEL (provisions +
// plancher). Partage par le write-back et par l'endpoint d'avancement (une seule verite).
async function computePrimesChargeSchedule(nowIso) {
  const [cfgRow, splitRows, factRows, objRows] = await Promise.all([
    supabase.from('kpi_prime_config').select('config').eq('id', 'default').maybeSingle(),
    supabase.from('kpi_ca_split').select('*'),
    supabase.from('facture_overrides').select('*'),
    supabase.from('kpi_objectives').select('*'),
  ]);
  const config = cfgRow && cfgRow.data ? cfgRow.data.config : null;
  const splits = (splitRows && splitRows.data) || [];
  const factOverrides = (factRows && factRows.data) || [];
  const objectives = (objRows && objRows.data) || [];
  const missions = await fetchAllNotionMissions();

  const currentYear = new Date(nowIso).getFullYear();
  const currentPrefix = String(currentYear) + '-';
  const kpiRef = computeKpi({ missions, objectives, splits, year: currentYear });
  const participants = primeParticipantsForYear(kpiRef);

  // Enumeration multi-exercice : deal signe en N-2..N, charge potentiellement en N.
  const floatByPartnerMonth = {};
  const detailCharge = [];
  for (const y of [currentYear - 2, currentYear - 1, currentYear]) {
    const caFacture = computeBillingForYear(missions, factOverrides, y).total;
    const pay = computePrimePayments({ missions, splits, config, year: y, caFacture, versements: [], now: nowIso, participants });
    // Charges ECRITES (dateCharge non null) tombant dans l'exercice courant -> byPartnerMonthCharge.
    for (const [partner, months] of Object.entries(pay.byPartnerMonthCharge || {})) {
      const dst = floatByPartnerMonth[partner] = floatByPartnerMonth[partner] || {};
      for (const [mk, amt] of Object.entries(months)) {
        if (!mk.startsWith(currentPrefix)) continue;
        dst[mk] = (dst[mk] || 0) + amt;
      }
    }
    // Detail par deal (toutes entrees, y compris provisions et 'du') dont la charge concerne N.
    for (const e of pay.detailCharge || []) {
      const inYear = (e.dateCharge && e.dateCharge.startsWith(currentPrefix))
        || (!e.dateCharge && e.dateDecaissement && e.dateDecaissement.startsWith(currentPrefix));
      if (inYear) detailCharge.push(e);
    }
  }

  // Arrondi entier en preservant le total par associe (aligne a l'euro avec Pilot).
  const byPartnerMonthCharge = {};
  for (const [partner, months] of Object.entries(floatByPartnerMonth)) {
    byPartnerMonthCharge[partner] = primesMap.roundPreservingSum(months);
  }

  // Reconciliation par statut (source : detailCharge). total = verse + du + aVenir + provisoire.
  const reconciliation = {};
  for (const p of participants) reconciliation[p] = { verse: 0, du: 0, aVenir: 0, provisoire: 0, total: 0 };
  const bucket = { verse: 'verse', du: 'du', a_venir: 'aVenir', provisoire: 'provisoire' };
  for (const e of detailCharge) {
    if (!reconciliation[e.partner]) reconciliation[e.partner] = { verse: 0, du: 0, aVenir: 0, provisoire: 0, total: 0 };
    const k = bucket[e.statut];
    if (k) { reconciliation[e.partner][k] += e.montant; reconciliation[e.partner].total += e.montant; }
  }
  for (const p of Object.keys(reconciliation)) {
    const r = reconciliation[p];
    for (const k of ['verse', 'du', 'aVenir', 'provisoire', 'total']) r[k] = Math.round(r[k]);
  }

  return { byPartnerMonthCharge, detailCharge, participants, reconciliation };
}
```

- [ ] **Step 2: Vérifier le chargement du serveur**

Run: `node -e "require('./server.js')"` puis Ctrl+C, ou démarrer le serveur (voir Task 6 Step 3).
Expected: pas d'erreur de syntaxe / de référence.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(pilot) primes : helper partage computePrimesChargeSchedule (charge multi-exercice + reconciliation par statut)"
```

---

## Task 6: Bascule du write-back sur la charge + suppression `PRIMES_PLANCHER`

**Files:**
- Modify: `server.js` (`syncPrimesToSheet` lignes 8334-8359; constante `PRIMES_PLANCHER` ligne 26)

**Interfaces:**
- Consumes: `computePrimesChargeSchedule(nowIso)` (Task 5).
- Produces: `syncPrimesToSheet()` écrit `byPartnerMonthCharge` dans `.Primes`; renvoie `{ ok, updated, cells, participants, dry, byPartnerMonthCharge, reconciliation }`.

- [ ] **Step 1: Remplacer le corps de `syncPrimesToSheet`**

Dans l'en-tête de `syncPrimesToSheet` (lignes 8335-8340), garder `nowIso` et `nowKey`, mais SUPPRIMER les lignes désormais inutiles `const currentYear = new Date().getFullYear();` et `const years = [currentYear];` (l'échéancier gère le multi-exercice en interne). Puis remplacer le `try` (lignes 8341-8353) par :

```js
  try {
    const { byPartnerMonthCharge, participants, reconciliation } = await computePrimesChargeSchedule(nowIso);
    const grid = await gsheets.readGrid(GOOGLE_SHEET_ID, MASSE_TAB, 'A1:BZ300');
    const layout = primesMap.discoverLayout(grid, { labelCol: 2, partnerNames: participants });
    primesMap.assertPartners(layout, participants);
    const { updates } = primesMap.buildUpdates(layout, byPartnerMonthCharge, MASSE_TAB, nowKey);
    const dry = process.env.PRIMES_SYNC_DRYRUN === '1';
    let updated = 0;
    if (!dry) ({ updated } = await gsheets.batchWrite(GOOGLE_SHEET_ID, updates));
    const summary = { updated, cells: updates.length, participants, dry };
    await writePrimesSyncState({ last_run_at: nowIso, ok: true, summary });
    console.log(`[primes-sync] ok : ${updates.length} cellules, ${updated} ecrites${dry ? ' (dry-run)' : ''}`);
    return { ok: true, ...summary, byPartnerMonthCharge, reconciliation };
  } catch (e) {
    console.error('[primes-sync] echec :', e.message);
    await writePrimesSyncState({ last_run_at: nowIso, ok: false, summary: { error: e.message } });
    return { ok: false, error: e.message };
  }
```

- [ ] **Step 2: Supprimer `PRIMES_PLANCHER`**

Supprimer la constante et son commentaire (lignes 24-26). Vérifier qu'il ne reste aucune référence :

Run: `grep -rn "PRIMES_PLANCHER" server.js`
Expected: aucun résultat.

- [ ] **Step 3: Vérifier en dry-run**

Démarrer le serveur avec le flag dry-run (n'écrit rien dans le Sheet, lit et calcule seulement) :

```bash
PRIMES_SYNC_DRYRUN=1 node server.js
```

Dans un autre terminal (le dashboard est protégé; utiliser le même hôte/port local, port 3000) :

```bash
curl.exe -X POST http://localhost:3000/api/primes/sync-gsheet
```

Expected: JSON `{"ok":true,"dry":true,...,"byPartnerMonthCharge":{...},"reconciliation":{...}}`. Vérifier que les mois de charge sont bien 09 (T3), 12 (étage 2), pas 10 ni 2027-03; et que `reconciliation[p].total == verse+du+aVenir+provisoire`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(pilot) primes : write-back ecrit la CHARGE (dernier mois trimestre), suppression du plancher fixe"
```

---

## Task 7: Option B · isoler les primes du réel Qonto dans `computeChargesHybride`

**Files:**
- Modify: `server.js` (`computeChargesHybride`, lignes 7938-8114; ajouter une constante de sous-catégorie près des autres constantes GSheet ~ligne 26)

**Interfaces:**
- Consumes: la ligne `.Primes` de CR_Prev (déjà agrégée dans « Frais de personnel »).
- Produces: `computeChargesHybride` exclut la sous-catégorie Qonto des primes du réel, et lit la charge des primes depuis CR_Prev pour TOUS les mois de la période (pas seulement les mois non clos).

Note : la formule GSheet `.Primes → CR_Prev` place les primes dans la catégorie « Frais de personnel ». On ne peut pas isoler la seule ligne primes depuis CR_Prev sans connaître la sous-catégorie. Approche retenue, robuste et minimale : recalculer la charge de primes de la période via `computePrimesChargeSchedule` et l'injecter, tout en retirant du réel Qonto la sous-catégorie « Primes ». Cela garantit que la charge des primes vient TOUJOURS du calcul (jamais du décaissement réel).

- [ ] **Step 1: Ajouter la constante de sous-catégorie**

Près des constantes (~ligne 26, à la place libérée par `PRIMES_PLANCHER`) :

```js
// Sous-categorie Qonto dediee aux virements de primes commerciales (a categoriser dans Qonto).
// Les transactions de cette sous-categorie sont retirees du reel : la charge des primes vient
// toujours du calcul (mois de charge), jamais du mois de decaissement bancaire.
const PRIMES_QONTO_SUBCAT = process.env.PRIMES_QONTO_SUBCAT || 'Primes commerciales';
```

- [ ] **Step 2: Exclure la sous-catégorie du réel Qonto**

Dans `computeChargesHybride`, boucle d'agrégation des transactions réelles `txsN` (lignes 8008-8018), ignorer les primes :

```js
      for (const tx of txsN) {
        const sousCat = (tx.cashflow_subcategory && tx.cashflow_subcategory.name) || null;
        if (sousCat === PRIMES_QONTO_SUBCAT) continue; // primes retirees du reel (portees par le calcul)
        const cat = (tx.cashflow_category && tx.cashflow_category.name) || tx.category || 'Non catégorisé';
        catMap[cat] = (catMap[cat] || 0) + tx.amount;
        const subKey = sousCat ? `${cat}||${sousCat}` : `${cat}||`;
        if (!subCatMap[subKey]) subCatMap[subKey] = { categorie: cat, sousCat, montant: 0 };
        subCatMap[subKey].montant += tx.amount;
        const d = new Date(tx.settled_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        chargesParMoisN[key] = (chargesParMoisN[key] || 0) + tx.amount;
      }
```

- [ ] **Step 3: Injecter la charge des primes pour tous les mois de la période**

Juste avant le calcul de `realTotal`/`prevTotal` final (~ligne 8086, là où `totalCharges` est composé), ajouter la charge des primes calculée (mois de charge), pour toute la période, réel comme prévisionnel :

```js
    // Option B : la charge des primes vient TOUJOURS du calcul (mois de charge), pour tous les mois
    // de la periode (y compris clos), afin de ne jamais etre re-datee au decaissement par le reel Qonto.
    let primesChargeTotal = 0;
    try {
      const nowIso = new Date().toISOString();
      const { byPartnerMonthCharge } = await computePrimesChargeSchedule(nowIso);
      for (const months of Object.values(byPartnerMonthCharge || {})) {
        for (const [mk, amt] of Object.entries(months)) {
          if (mk >= startKey && mk <= endKey) primesChargeTotal += amt;
        }
      }
    } catch (e) { console.error('[charges-hybride] primes non injectees:', e.message); }
```

Puis ajouter `primesChargeTotal` au total des charges retourné (là où `totalCharges` est calculé, ligne ~8086). Repérer la composition existante `realTotal + prevTotal` et y ajouter `+ Math.round(primesChargeTotal)`. Documenter en commentaire que ce terme remplace, pour les primes, à la fois le réel Qonto (retiré Step 2) et l'éventuelle ligne `.Primes` du CR_Prev prévisionnel.

IMPORTANT anti-double-compte : la ligne `.Primes` alimente déjà CR_Prev « Frais de personnel » pour les mois non clos (`prevTotal`). Pour éviter de compter deux fois les primes prévisionnelles, soustraire du prévisionnel la contribution `.Primes` déjà incluse, OU (plus simple et sûr) ne PAS injecter `primesChargeTotal` pour les mois non clos et ne l'injecter que pour les mois clos (`mk < todayKey`), puisque les mois non clos ont déjà les primes via CR_Prev. Remplacer la condition d'injection par :

```js
          if (mk >= startKey && mk <= endKey && mk < todayKey) primesChargeTotal += amt;
```

Ainsi : mois clos → primes via le calcul (injecté ici, réel Qonto exclu Step 2); mois non clos → primes via CR_Prev (formule, déjà dans `prevTotal`). Aucune prime comptée deux fois.

- [ ] **Step 4: Vérifier**

Démarrer le serveur et appeler `/api/ebe` sur l'année courante :

```bash
node server.js
# autre terminal :
curl.exe http://localhost:3000/api/ebe
```

Expected: réponse sans erreur; `charges.total` cohérent (les primes réelles éventuelles ne sont plus datées au décaissement). Comme aucune prime n'est encore versée, l'impact réel est nul aujourd'hui; vérifier surtout l'absence de régression sur `charges.total` (comparer au commit précédent : doit être identique tant qu'aucune prime n'est dans Qonto).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(pilot) primes : Option B, primes isolees du reel Qonto et charge portee par le calcul (mois clos)"
```

---

## Task 8: Endpoint `GET /api/primes/avancement`

**Files:**
- Modify: `server.js` (après les routes primes existantes, ~ligne 8373)

**Interfaces:**
- Consumes: `computePrimesChargeSchedule(nowIso)` (Task 5).
- Produces: `GET /api/primes/avancement` → `{ parAssocie, parDeal, total, reconciliation }`. `parDeal` = `detailCharge` enrichi de `dateFactureAcompte`. `total` = agrégat des statuts tous associés.

- [ ] **Step 1: Ajouter la route**

Après `GET /api/primes/sync-status` (ligne 8373) :

```js
// Etat d'avancement des primes (charge) : par associe, par deal, total, avec statuts. Lecture seule.
app.get('/api/primes/avancement', async (_req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const { detailCharge, participants, reconciliation } = await computePrimesChargeSchedule(nowIso);
    const total = { verse: 0, du: 0, aVenir: 0, provisoire: 0, total: 0 };
    for (const p of Object.keys(reconciliation)) {
      for (const k of ['verse', 'du', 'aVenir', 'provisoire', 'total']) total[k] += reconciliation[p][k];
    }
    res.json({ parAssocie: reconciliation, parDeal: detailCharge, total, participants });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

Note : `detailCharge` contient déjà `deal`, `nom`, `partner`, `montant`, `dateCharge`, `dateDecaissement`, `statut`, `etage`. La `dateFactureAcompte` n'est pas indispensable au premier rendu (le statut la résume); si besoin ultérieur, l'ajouter dans le moteur au push de `detailCharge`. YAGNI pour ce lot.

- [ ] **Step 2: Vérifier**

```bash
node server.js
curl.exe http://localhost:3000/api/primes/avancement
```

Expected: JSON avec `parAssocie` (par associé, statuts), `parDeal` (liste), `total`. Vérifier `total.total == total.verse + total.du + total.aVenir + total.provisoire`.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(pilot) primes : endpoint GET /api/primes/avancement (suivi par associe et par deal)"
```

---

## Task 9: Front · 2 sous-onglets KPI + vue « État d'avancement »

**Files:**
- Modify: `public/pilot.html` (`renderKpiPrime` ~11531-11561; ajouter `renderPrimeViewTabs`, `switchPrimeView`, `renderPrimeAdvancement`; variable de module `primeView`)
- Modify: `dist/pilot.html` (mêmes changements)

**Interfaces:**
- Consumes: `GET /api/primes/avancement` (Task 8); pattern CSS `.kpi-signed-tabs` / `.kpi-signed-tab` (existant ~4222).
- Produces: deux sous-onglets « Tableau des primes » (existant) et « État d'avancement » (nouveau).

- [ ] **Step 1: Ajouter la variable d'état + la barre d'onglets dans le squelette**

Dans `renderKpiPrime`, remplacer l'affectation `body.innerHTML = ...` (lignes 11553-11556) par :

```js
      body.innerHTML =
        '<div id="prime-coverage" style="margin-bottom:0.9rem"></div>'
        + '<div id="prime-clawback" style="margin-bottom:0.9rem"></div>'
        + '<div class="kpi-signed-tabs" id="primeViewTabs" style="margin-top:1rem"></div>'
        + '<div class="prime-results" id="kpiPrimeResults" style="margin-top:0.9rem"></div>'
        + '<div id="kpiPrimeAdvancement" style="margin-top:0.9rem;display:none"></div>';

      primeRecompute();
      renderKpiCoverage();
      renderKpiClawback();
      renderPrimeViewTabs();
      switchPrimeView(primeView);
```

Déclarer la variable de module près des autres états de primes (ex. à côté de `primeParticipants`) :

```js
    let primeView = 'table'; // 'table' | 'advancement'
```

- [ ] **Step 2: Ajouter les fonctions d'onglets (clonées de renderKpiSignedTabs/switchKpiSignedTab)**

Après `renderKpiPrime` :

```js
    function renderPrimeViewTabs() {
      const el = document.getElementById('primeViewTabs');
      if (!el) return;
      const tabs = [['table', 'Tableau des primes'], ['advancement', 'État d\'avancement']];
      el.innerHTML = tabs.map(([k, label]) =>
        '<button class="kpi-signed-tab' + (primeView === k ? ' active' : '') + '" onclick="switchPrimeView(\'' + k + '\')">' + label + '</button>'
      ).join('');
    }

    function switchPrimeView(view) {
      primeView = view;
      const tab = document.getElementById('kpiPrimeResults');
      const adv = document.getElementById('kpiPrimeAdvancement');
      if (tab) tab.style.display = (view === 'table') ? '' : 'none';
      if (adv) adv.style.display = (view === 'advancement') ? '' : 'none';
      renderPrimeViewTabs();
      if (view === 'advancement') renderPrimeAdvancement();
    }
```

- [ ] **Step 3: Ajouter la vue « État d'avancement »**

```js
    async function renderPrimeAdvancement() {
      const el = document.getElementById('kpiPrimeAdvancement');
      if (!el) return;
      el.innerHTML = '<div class="prime-card"><p style="margin:0;color:var(--text-secondary)">Chargement…</p></div>';
      let data;
      try {
        const res = await fetch('/api/primes/avancement');
        data = await res.json();
      } catch (e) {
        el.innerHTML = '<div class="prime-card"><p style="margin:0;color:var(--danger)">Erreur de chargement du suivi.</p></div>';
        return;
      }
      const deals = (data && data.parDeal) || [];
      if (!deals.length) {
        el.innerHTML = '<div class="prime-card"><p style="margin:0;color:var(--text-secondary)">Aucune prime à suivre pour cette année.</p></div>';
        return;
      }
      const LABELS = { verse: 'Versé', du: 'Dû', aVenir: 'À venir', provisoire: 'Provisoire' };
      // Total (bandeau)
      const t = data.total || { verse: 0, du: 0, aVenir: 0, provisoire: 0, total: 0 };
      let html = '<div class="prime-card"><p class="prime-card-h">Suivi des décaissements de primes</p>'
        + '<div style="display:flex;flex-wrap:wrap;gap:0.8rem">'
        + ['verse', 'du', 'aVenir', 'provisoire'].map(k =>
            '<div><div style="font-size:0.72rem;color:var(--text-secondary)">' + LABELS[k] + '</div><div style="font-weight:700">' + primeFmtEur(t[k]) + '</div></div>'
          ).join('')
        + '<div><div style="font-size:0.72rem;color:var(--text-secondary)">Total</div><div style="font-weight:700">' + primeFmtEur(t.total) + '</div></div>'
        + '</div></div>';
      // Par associé
      const pa = data.parAssocie || {};
      html += '<div class="prime-card"><p class="prime-card-h">Par associé</p><table class="prime-recap"><thead><tr>'
        + '<th style="text-align:left">Associé</th><th style="text-align:right">Versé</th><th style="text-align:right">Dû</th><th style="text-align:right">À venir</th><th style="text-align:right">Provisoire</th><th style="text-align:right">Total</th></tr></thead><tbody>'
        + Object.keys(pa).map(p => {
            const r = pa[p];
            return '<tr><td>' + primeEsc(p) + '</td><td style="text-align:right">' + primeFmtEur(r.verse) + '</td><td style="text-align:right">' + primeFmtEur(r.du) + '</td><td style="text-align:right">' + primeFmtEur(r.aVenir) + '</td><td style="text-align:right">' + primeFmtEur(r.provisoire) + '</td><td class="tot" style="text-align:right">' + primeFmtEur(r.total) + '</td></tr>';
          }).join('')
        + '</tbody></table></div>';
      // Par deal
      html += '<div class="prime-card"><p class="prime-card-h">Par deal</p><table class="prime-recap"><thead><tr>'
        + '<th style="text-align:left">Deal</th><th style="text-align:left">Associé</th><th style="text-align:right">Montant</th><th style="text-align:left">Charge</th><th style="text-align:left">Décaissement</th><th style="text-align:left">Statut</th></tr></thead><tbody>'
        + deals.map(d =>
            '<tr><td>' + primeEsc(d.nom || (d.etage === 2 ? 'Prime collective' : 'Sans nom')) + '</td><td>' + primeEsc(d.partner) + '</td>'
            + '<td style="text-align:right">' + primeFmtEur(d.montant) + '</td>'
            + '<td>' + (d.dateCharge || 'réel') + '</td><td>' + (d.dateDecaissement || '-') + '</td>'
            + '<td>' + (LABELS[d.statut === 'a_venir' ? 'aVenir' : d.statut] || d.statut) + '</td></tr>'
          ).join('')
        + '</tbody></table></div>';
      el.innerHTML = html;
    }
```

(Réutilise `primeFmtEur`, `primeEsc` existants; `.prime-card` et `.prime-recap` existants.)

- [ ] **Step 4: Répliquer dans dist/pilot.html**

Appliquer Steps 1-3 à l'identique dans `dist/pilot.html` (mêmes numéros de fonctions). Vérifier :

Run: `grep -n "renderPrimeAdvancement" public/pilot.html dist/pilot.html`
Expected: présent dans les deux.

- [ ] **Step 5: Vérifier dans le navigateur**

Démarrer le serveur, ouvrir Pilot, section KPI primes : deux sous-onglets apparaissent; « État d'avancement » affiche total + par associé + par deal; « Tableau des primes » affiche l'existant; la bascule fonctionne et l'onglet actif est conservé après un re-rendu (ex. après « Données réelles »).

- [ ] **Step 6: Commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(pilot) primes : 2 sous-onglets KPI (tableau + etat d'avancement des decaissements)"
```

---

## Task 10: Documentation, mémoire et recette

**Files:**
- Modify: `docs/superpowers/specs/2026-07-31-primes-gsheet-writeback-design.md` (bandeau REMPLACÉ)
- Modify: note mémoire `C:\Users\gourdin\.claude\projects\c--Users-gourdin-Github-hubspot-dashboard\memory\gsheet-primes-writeback.md` + `MEMORY.md`

- [ ] **Step 1: Marquer l'ancienne spec comme remplacée**

En tête de `docs/superpowers/specs/2026-07-31-primes-gsheet-writeback-design.md`, ajouter :

```markdown
> REMPLACÉ le 2026-08-02 par `2026-08-02-primes-charge-decaissement-decouplage-design.md` (découplage charge/décaissement, réel figé, état d'avancement). Conservé pour historique.
```

- [ ] **Step 2: Mettre à jour la note mémoire**

Réécrire `gsheet-primes-writeback.md` : le write-back écrit désormais la CHARGE (dernier mois du trimestre de facturation, décembre pour l'étage 2), plancher fixe `PRIMES_PLANCHER` supprimé au profit d'un plancher dynamique, provisions incluses, Option B (primes isolées du réel Qonto), lien `[[ca-charges-gsheet-vs-pilot]]`. Mettre à jour la ligne correspondante dans `MEMORY.md`.

- [ ] **Step 3: Recette chiffrée (dry-run)**

Lancer un dry-run réel et consigner les montants attendus :

```bash
PRIMES_SYNC_DRYRUN=1 node server.js
curl.exe -X POST http://localhost:3000/api/primes/sync-gsheet
curl.exe http://localhost:3000/api/primes/avancement
```

Checklist de recette :
- La charge étage 1 T3 est en `2026-09` (pas `2026-10`).
- La charge étage 2 est en `2026-12` (pas `2027-03`).
- `reconciliation[p].total == verse + du + aVenir + provisoire` pour chaque associé.
- La somme de `byPartnerMonthCharge` (charges écrites) plus les charges `du` déjà passées (réel) est cohérente avec le total « gagné » affiché dans l'onglet KPI.
- Vérifier dans le tableur que la formule `.Primes → CR_Prev` agrège bien la colonne `12` (décembre) dans l'exercice N (contrôle manuel, non automatisable).
- Colonnes GSheet : `discoverLayout` trouve bien les colonnes `03/06/09/12` de l'exercice; sinon les créer dans le tableur.

- [ ] **Step 4: Synchro réelle (après validation du dry-run)**

Sans le flag dry-run, déclencher la synchro (bouton Pilot « Synchroniser le GSheet » ou `curl.exe -X POST .../api/primes/sync-gsheet`), puis vérifier dans le Google Sheet que `.Primes` porte septembre / décembre et que les anciennes cellules (octobre 2026, mars 2027) sont à 0.

- [ ] **Step 5: Commit**

```bash
git add docs/ "C:/Users/gourdin/.claude/projects/c--Users-gourdin-Github-hubspot-dashboard/memory/gsheet-primes-writeback.md" "C:/Users/gourdin/.claude/projects/c--Users-gourdin-Github-hubspot-dashboard/memory/MEMORY.md"
git commit -m "docs(pilot) primes : spec remplacee, memoire et recette du modele charge/decaissement"
```

---

## Notes d'implémentation transverses

- **Anti-double-compte (le plus important)** : la charge des primes ne doit apparaître qu'UNE fois dans l'EBE. Mois non clos → via `.Primes`/CR_Prev (`prevTotal`). Mois clos → via `primesChargeTotal` injecté (Task 7), avec la sous-catégorie Qonto exclue du réel. Ne jamais réintroduire de fold JS.
- **`now` réel partout côté charge** : `computePrimesChargeSchedule` passe `nowIso` (jamais `OLD`) pour que provisions (R3) et rattrapage (R4) fonctionnent.
- **Trésorerie intacte** : le handler `/api/tresorerie` (server.js ~6413) continue de lire `pay.byMonth` (décaissement). Ne pas le toucher.
- **Prérequis opérationnel** : créer la sous-catégorie Qonto `PRIMES_QONTO_SUBCAT` (défaut « Primes commerciales ») et y classer les virements de primes.
