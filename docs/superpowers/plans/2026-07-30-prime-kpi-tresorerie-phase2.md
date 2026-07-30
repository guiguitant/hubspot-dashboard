# Prime KPI dans la trésorerie · Phase 2 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire apparaître les versements de primes commerciales comme décaissements datés dans la trésorerie prévisionnelle (impact sur le solde), selon le calendrier de versement (étage 1 deal par deal conditionné à la facturation de l'acompte, étage 2 en N+1).

**Architecture :** Une fonction pure `computePrimePayments` (utils/kpiCompute.js) produit une map `{ 'YYYY-MM': montant }` des versements. Le serveur la calcule au site de la trésorerie principale (comme `remboursementCreditByMonth`) et la passe à `buildPrevisionnel`, qui l'intègre dans `decaissementsTRE` de chaque mois non clos (donc dans le solde). Le front ajoute une ligne dans la modale de détail mensuel.

**Tech Stack :** Node.js/Express (CommonJS), utils jest, front vanilla JS (public/pilot.html).

## Global Constraints

- Backend CommonJS (`require`/`module.exports`), jamais `import`/`export`.
- Logique financière dans `utils/`, couverte par jest.
- Jamais de tiret cadratin « — » dans le code, les commentaires ou les messages.
- Source front = `public/pilot.html` ; `dist/pilot.html` est un artefact de build (ne pas éditer).
- Réutiliser les briques Phase 1 déjà exportées de `utils/kpiCompute.js` : `signedByQuarter`, `normalizePrimeConfig`, `primeDefaultRates`.
- Étage 2 : base de facturation = la MÊME que l'onglet KPI (`computeBillingForYear(missions, factOverrides, year).total`), via le `caFacture` passé à la fonction pure.
- Phase 2 = versements NON validés uniquement (pas de table de validation) : `versements` vaut `[]`, tout est « à verser ».

## Rappel des règles (spec)

Les 4 états d'une part de prime étage 1 (deal + partner), à l'instant `now` :
- **versée** : présente dans `versements` (Phase 3) → exclue de la trésorerie. En Phase 2, `versements=[]`, donc jamais.
- **planifiée** : acompte facturé, mois de versement dans le futur → injectée à ce mois.
- **rattrapage** : acompte facturé, mois de versement déjà passé → reportée sur le mois courant (`now`).
- **en attente** : acompte non facturé → provision, hors trésorerie.

Mois de versement étage 1 d'un deal signé au trimestre `q` : `max(mois suivant la clôture de q, mois suivant la facturation de l'acompte)`. Clôture : T1 → mars, donc versement avril ; T2 → juillet ; T3 → octobre ; T4 → janvier N+1.

Étage 2 (collectif) : montant `tauxColl% × resultatAnnuel`, versé au mois configuré de N+1 (défaut mars N+1). Pas de condition de facturation.

---

## File Structure

- `utils/kpiCompute.js` — ajout de `computePrimePayments` (+ 2 helpers de date internes). Exporté.
- `utils/kpiCompute.test.js` — tests de `computePrimePayments`.
- `server.js` — `buildPrevisionnel` (param + injection) et le site de trésorerie (~6374, calcul de la map).
- `public/pilot.html` — modale de détail mensuel trésorerie (une ligne).

---

### Task 1: Fonction pure `computePrimePayments` + tests

**Files:**
- Modify: `utils/kpiCompute.js`
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Consumes: `signedByQuarter`, `normalizePrimeConfig`, `primeDefaultRates` (déjà dans le fichier).
- Produces: `computePrimePayments({ missions, splits, config, year, caFacture, versements, now, versementEtage2Mois }) -> { byMonth: {'YYYY-MM': number}, detail: {'YYYY-MM': Array}, enAttente: number, verse: number }`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter `computePrimePayments` à la ligne de `require` en tête de `utils/kpiCompute.test.js`, puis ajouter ce bloc en fin de fichier :

```js
describe('computePrimePayments : echeancier des versements de primes', () => {
  const cfg = {
    rates: { Vincent: { txNew: 4.5, txRepeat: 2.5 } },
    tiers: [{ seuil: 650000, taux: 7 }, { seuil: 600000, taux: 5 }, { seuil: 550000, taux: 3 }],
    resultatAnnuel: 150000,
    gateTrimestriel: 120000,
  };
  // Deal T1 (signe fevrier), Newsale, Vincent, 200000, acompte facture le 15/03/2026.
  const dealT1 = (over = {}) => mission({
    id: 'a', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'],
    ca: 200000, etat: 'Signé', dateFactureAcompte: '2026-03-15', ...over,
  });

  it('deal facture a temps : versement planifie au mois suivant la cloture (avril)', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.byMonth['2026-04']).toBe(9000); // 200000 * 4.5%
    expect(r.enAttente).toBe(0);
  });

  it('deal facture en retard : versement glisse au mois suivant la facturation', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: '2026-08-20' })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.byMonth['2026-09']).toBe(9000);
    expect(r.byMonth['2026-04']).toBeUndefined();
  });

  it('mois de versement deja passe : rattrapage sur le mois courant', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-07-15' });
    expect(r.byMonth['2026-07']).toBe(9000);
    expect(r.detail['2026-07'][0].rattrapage).toBe(true);
  });

  it('acompte non facture : en attente, aucun versement', () => {
    const r = computePrimePayments({ missions: [dealT1({ dateFactureAcompte: null })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(r.enAttente).toBe(9000);
    expect(Object.keys(r.byMonth).length).toBe(0);
  });

  it('trimestre sous le seuil (gele) : rien', () => {
    const r = computePrimePayments({ missions: [dealT1({ ca: 100000 })], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [], now: '2026-02-10' });
    expect(Object.keys(r.byMonth).length).toBe(0);
    expect(r.enAttente).toBe(0);
  });

  it('etage 2 : verse au mois configure en N+1 (defaut mars)', () => {
    const r = computePrimePayments({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 660000, versements: [], now: '2026-07-15' });
    expect(r.byMonth['2027-03']).toBe(10500); // 7% * 150000
  });

  it('versement deja valide : exclu du byMonth, compte dans verse', () => {
    const r = computePrimePayments({ missions: [dealT1()], splits: [], config: cfg, year: 2026, caFacture: 0, versements: [{ etage: 1, mission_id: 'a', partner: 'Vincent' }], now: '2026-02-10' });
    expect(Object.keys(r.byMonth).length).toBe(0);
    expect(r.verse).toBe(9000);
  });
});
```

- [ ] **Step 2: Lancer les tests, vérifier l'échec**

Run: `npx jest utils/kpiCompute.test.js -t "computePrimePayments"`
Expected: FAIL (`computePrimePayments is not a function`).

- [ ] **Step 3: Implémenter la fonction**

Dans `utils/kpiCompute.js`, avant `module.exports`, ajouter :

```js
// Cle 'YYYY-MM' du mois qui suit la cloture du trimestre q (1-4) de l'annee y.
// Cloture T1=mars, T2=juin, T3=sept, T4=dec ; "mois suivant" = avril, juillet, octobre, janvier(N+1).
function monthAfterQuarterClose(y, q) {
  let m = q * 3 + 1, yy = y;
  if (m > 12) { m = 1; yy = y + 1; }
  return yy + '-' + String(m).padStart(2, '0');
}

// Cle 'YYYY-MM' du mois qui suit une date 'YYYY-MM-DD' (ou ISO). Null si date absente/invalide.
function monthAfterDate(d) {
  if (!d) return null;
  const y = Number(String(d).slice(0, 4)), m = Number(String(d).slice(5, 7));
  if (!y || !m) return null;
  let mm = m + 1, yy = y;
  if (mm > 12) { mm = 1; yy = y + 1; }
  return yy + '-' + String(mm).padStart(2, '0');
}

// Echeancier des versements de primes de l'annee `year` : map { 'YYYY-MM': montant } + detail.
// Etage 1 deal par deal (conditionne a la facturation de l'acompte, avec portillon trimestriel),
// etage 2 en N+1. `versements` = validations Phase 3 (couples deja verses, exclus). `now` = date
// courante ('YYYY-MM-DD' ou ISO) pour le rattrapage. Les cles zero-paddees se comparent lexicalement.
function computePrimePayments({ missions, splits, config, year, caFacture, versements = [], now, versementEtage2Mois }) {
  const cfg = normalizePrimeConfig(config);
  const sq = signedByQuarter(missions || [], year, splits || []);
  const gateOk = sq.quarterTotals.map((t) => t >= cfg.gateTrimestriel);
  const nowKey = String(now || '').slice(0, 7);

  // Index des validations (Phase 3) : etage 1 -> 'E1|mission|partner' ; etage 2 -> 'E2|partner'.
  const verseKeys = new Set();
  for (const v of versements || []) {
    if (Number(v.etage) === 2) verseKeys.add('E2|' + v.partner);
    else verseKeys.add('E1|' + v.mission_id + '|' + v.partner);
  }

  // Date de facturation de l'acompte par mission.
  const acompteByMission = {};
  for (const m of (missions || [])) acompteByMission[m.id] = m.dateFactureAcompte || null;

  const byMonth = {};
  const detail = {};
  let enAttente = 0, verse = 0;
  const add = (mk, amount, info) => {
    byMonth[mk] = (byMonth[mk] || 0) + amount;
    (detail[mk] = detail[mk] || []).push(info);
  };

  // --- Etage 1 : deal par deal, par partner ---
  for (const p of Object.keys(sq.detailByPartner || {})) {
    const rate = cfg.rates[p] || primeDefaultRates(p);
    for (let q = 0; q < 4; q++) {
      if (!gateOk[q]) continue;
      for (const deal of (sq.detailByPartner[p][q] || [])) {
        const taux = deal.type === 'new' ? rate.txNew : rate.txRepeat;
        const montant = Math.round(deal.montant * (taux / 100));
        if (montant <= 0) continue;
        if (verseKeys.has('E1|' + deal.id + '|' + p)) { verse += montant; continue; }
        const acompte = acompteByMission[deal.id];
        if (!acompte) { enAttente += montant; continue; }
        let mk = monthAfterQuarterClose(year, q + 1);
        const mkFact = monthAfterDate(acompte);
        if (mkFact && mkFact > mk) mk = mkFact;      // le plus tardif des deux
        const rattrapage = mk < nowKey;
        if (rattrapage) mk = nowKey;
        add(mk, montant, { etage: 1, deal: deal.id, nom: deal.nom, partner: p, montant, rattrapage });
      }
    }
  }

  // --- Etage 2 : collectif, verse en N+1 ---
  const caF = Math.max(0, Number(caFacture) || 0);
  const tiersAsc = cfg.tiers.slice().sort((a, b) => a.seuil - b.seuil);
  let tauxColl = 0;
  for (const t of tiersAsc) { if (caF >= t.seuil) tauxColl = t.taux; }
  const collTotal = Math.round((tauxColl / 100) * cfg.resultatAnnuel);
  // Etage 2 verse en une ligne (total collectif). L'exclusion par partner valide arrive en Phase 3.
  if (collTotal > 0) {
    const moisE2 = String(versementEtage2Mois || cfg.versementEtage2Mois || '03').padStart(2, '0');
    let mk = (year + 1) + '-' + moisE2;
    const rattrapage = mk < nowKey;
    if (rattrapage) mk = nowKey;
    add(mk, collTotal, { etage: 2, montant: collTotal, rattrapage });
  }

  return { byMonth, detail, enAttente, verse };
}
```

Puis ajouter `computePrimePayments` à `module.exports`.

- [ ] **Step 4: Lancer les tests, vérifier le succès**

Run: `npx jest utils/kpiCompute.test.js -t "computePrimePayments"`
Expected: PASS (7 tests).

- [ ] **Step 5: Suite complète (non-régression)**

Run: `npx jest utils/kpiCompute.test.js`
Expected: PASS (tous).

- [ ] **Step 6: Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) prime: fonction pure computePrimePayments + tests"
```

---

### Task 2: Injecter les versements dans `buildPrevisionnel`

**Files:**
- Modify: `server.js` (import ligne 12 ; `buildPrevisionnel` 5325, 6053, 6230, return ~6255 ; site trésorerie ~6361-6382)

**Interfaces:**
- Consumes: `computePrimePayments` (Task 1), `computeBillingForYear` (déjà importé), tables `kpi_prime_config`, `kpi_ca_split`, `facture_overrides`.
- Produces: chaque mois du prévisionnel expose `primesCommercialesVersees` (number), inclus dans `decaissementsTRE` et donc dans le solde.

- [ ] **Step 1: Importer `computePrimePayments`**

À la ligne 12 de `server.js`, ajouter `computePrimePayments` à la destructuration existante de `./utils/kpiCompute` :

```js
const { computeKpi, totalCaAnnee, signedByQuarter, clawbackCandidates, computePrimePool, computePrimePayments } = require('./utils/kpiCompute');
```

- [ ] **Step 2: Ajouter le paramètre à `buildPrevisionnel`**

Dans la signature de `buildPrevisionnel` (server.js:5325), ajouter `primePaymentsByMonth = {}` à la fin des paramètres destructurés (juste après `remboursementCreditByMonth = {}`).

- [ ] **Step 3: Calculer le décaissement du mois**

Juste après la ligne 6053 (`const chargesFixesExtra = isClos ? 0 : Math.round(chargesFixesParMois[mKey] || 0);`), ajouter :

```js
    const primesCommercialesVersees = isClos ? 0 : Math.round(primePaymentsByMonth[mKey] || 0);
```

- [ ] **Step 4: Intégrer au décaissement TRE (donc au solde)**

Ligne 6230, ajouter `+ primesCommercialesVersees` à `decaissementsTRE` :

```js
      decaissementsTRE: decaissementsTREBase + chargesFixesExtra + masseDelta + tvaReversementM1 + primesCommercialesVersees,
```

- [ ] **Step 5: Exposer le champ dans l'objet mensuel**

Juste après la ligne du `remboursementCreditImpot` dans l'objet retourné (server.js ~6255), ajouter une ligne :

```js
      primesCommercialesVersees,
```

- [ ] **Step 6: Calculer `primePaymentsByMonth` au site de la trésorerie et le passer**

Juste avant l'appel `const result = await buildPrevisionnel({` (server.js ~6374), ajouter le bloc de calcul (miroir de `remboursementCreditByMonth`, tolérant) :

```js
    // Versements de primes commerciales (echeancier KPI) : decaissements dates dans le previsionnel.
    // Tolerant : un echec ne fait pas tomber la treso. On calcule pour l'annee courante ET l'annee
    // precedente (etage 2 verse en N+1, etage 1 de T4 verse en janvier N+1) puis on fusionne par mois.
    const primePaymentsByMonth = {};
    try {
      const [cfgRow, splitRows, factRows] = await Promise.all([
        supabase.from('kpi_prime_config').select('config').eq('id', 'default').maybeSingle(),
        supabase.from('kpi_ca_split').select('*'),
        supabase.from('facture_overrides').select('*'),
      ]);
      if (cfgRow && cfgRow.error) throw cfgRow.error;
      if (splitRows && splitRows.error) throw splitRows.error;
      if (factRows && factRows.error) throw factRows.error;
      const primeCfg = cfgRow && cfgRow.data ? cfgRow.data.config : null;
      const splits = (splitRows && splitRows.data) ? splitRows.data : [];
      const factOverrides = (factRows && factRows.data) ? factRows.data : [];
      const nowIso = new Date().toISOString();
      const currentYear = new Date().getFullYear();
      for (const y of [currentYear - 1, currentYear]) {
        const caFactureY = computeBillingForYear(notionMissions, factOverrides, y).total;
        const pay = computePrimePayments({ missions: notionMissions, splits, config: primeCfg, year: y, caFacture: caFactureY, versements: [], now: nowIso });
        for (const [mk, amt] of Object.entries(pay.byMonth)) {
          primePaymentsByMonth[mk] = (primePaymentsByMonth[mk] || 0) + amt;
        }
      }
    } catch (e) {
      console.error('Erreur calcul versements primes:', e.message);
    }

```

Puis, dans l'objet passé à `buildPrevisionnel(...)`, ajouter `primePaymentsByMonth,` à la fin (à côté de `remboursementCreditByMonth,`).

- [ ] **Step 7: Vérifier le parse et l'effet**

Run: `node --check server.js`
Expected: exit 0, no output.

Démarrer le backend (`npm start`), puis (bypass local 127.0.0.1) :

Run: `curl -s "http://127.0.0.1:3000/api/tresorerie" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const rows=(j.previsionnel||[]).filter(m=>m.primesCommercialesVersees).map(m=>({mois:(m.annee+'-'+m.mois),primes:m.primesCommercialesVersees}));console.log('mois avec primes:',JSON.stringify(rows));})"`

Expected : au moins un mois avec `primesCommercialesVersees > 0` (si le pool de l'année est non nul). La route de la trésorerie est `/api/tresorerie` (server.js:6329), accessible en local via le bypass 127.0.0.1. Si la structure de réponse n'expose pas `previsionnel` directement, l'inspecter (`console.log(Object.keys(j))`) et adapter. En dernier recours, vérifier via l'UI (Task 3).

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat(pilot) prime: versements injectes dans la tresorerie previsionnelle"
```

---

### Task 3: Ligne « Primes commerciales » dans la modale de détail mensuel

**Files:**
- Modify: `public/pilot.html` (section « Charges TTC » de la modale de détail mensuel, ~15959)

**Interfaces:**
- Consumes: `m.primesCommercialesVersees` (number) exposé par la trésorerie (Task 2). Comme il est déjà inclus dans `decaissementsTRE`, le « Total charges » (`decTotal`) le compte automatiquement ; on ajoute seulement la sous-ligne de détail.

- [ ] **Step 1: Ajouter la ligne de charge**

Dans la modale de détail mensuel, section « Charges TTC », juste après la ligne `if (rembAvance) html += row('Remb. Avance remboursable BPI', rembAvance, { sign: '−' });` (public/pilot.html ~15962) et AVANT la ligne `Total charges`, ajouter :

```js
      if (m.primesCommercialesVersees) html += row('Primes commerciales', m.primesCommercialesVersees, { sign: '−' });
```

- [ ] **Step 2: Vérifier dans l'UI**

Démarrer backend + front, ouvrir la Trésorerie, cliquer un mois qui porte un versement de prime (voir Task 2 Step 7 pour lequel).

Expected :
- La modale affiche « Primes commerciales · − <montant> » dans la section Charges.
- Le « Total charges » et le « Solde fin » du mois reflètent ce décaissement (le solde baisse du montant de la prime).

- [ ] **Step 3: Commit**

```bash
git add public/pilot.html
git commit -m "feat(pilot) prime: ligne versements primes dans le detail tresorerie mensuel"
```

---

## Vérification finale de la Phase 2

- [ ] `npx jest utils/kpiCompute.test.js` passe intégralement.
- [ ] La trésorerie montre les versements de primes aux bons mois (avril/juillet/octobre/janvier pour l'étage 1 selon facturation ; mars N+1 pour l'étage 2).
- [ ] Le solde de trésorerie baisse du montant des versements aux mois concernés.
- [ ] `node --check server.js` OK.

## Hors périmètre (Phase 3 à venir)

- Table `kpi_prime_versements`, endpoints, validation humaine par deal, et exclusion des primes validées (le paramètre `versements` de `computePrimePayments` est déjà prêt à les recevoir).
- Répartition par partner de l'étage 2 (Phase 2 verse le total collectif en une ligne).
- Répercussion dans les endpoints de scénarios (server.js ~7044, ~7279) : comme `remboursementCreditByMonth`, seuls la trésorerie principale reçoit les versements en Phase 2.
- Repère « provision » (pool gagné − versé) dans l'UI.
