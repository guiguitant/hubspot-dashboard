# Prime KPI dans le compte de résultat · Phase 1 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire apparaître le pool de primes commerciales (calculé dans l'onglet KPI) comme charge d'exploitation dans le compte de résultat du Pilot, en factuel et projeté.

**Architecture :** Une fonction pure `computePrimePool` dans `utils/kpiCompute.js` reproduit le calcul du pool aujourd'hui fait côté front (`primeCompute`), à partir de la config sauvegardée en base et des missions Notion. L'endpoint `/api/ebe` l'appelle, ajoute le pool à `totalCharges` avant le calcul de l'EBE, et l'expose. Le front affiche une sous-ligne « dont primes commerciales » et une entrée dans la modale de détail des charges.

**Tech Stack :** Node.js/Express (CommonJS), Supabase (`kpi_prime_config`, `kpi_ca_split`), Notion (missions), jest, front vanilla JS (`public/pilot.html`).

## Global Constraints

- Backend en CommonJS (`require` / `module.exports`), jamais `import`/`export`.
- La logique financière vit dans `utils/` et est couverte par jest (règle du repo).
- Côté serveur, utiliser le client Supabase déjà employé par les endpoints KPI voisins (`/api/kpi/prime-config`), pas le client anon.
- Ne jamais utiliser de tiret cadratin « — » dans le code, les commentaires ou les messages.
- La source front est `public/pilot.html` ; `dist/pilot.html` est un artefact de build (ne pas éditer à la main).
- Le pool doit être **identique** à celui de l'onglet KPI : mêmes défauts de config (`tiers` [650000/7, 600000/5, 550000/3], `resultatAnnuel` 150000, `gateTrimestriel` 120000 ; taux par défaut Guillaume {txNew 2.25, txRepeat 1.25}, sinon {txNew 4.5, txRepeat 2.5}).

---

## Contexte de calcul (rappel, pour l'implémenteur)

Le pool = étage 1 (primes perso trimestrielles) + étage 2 (prime collective annuelle).

- `signedByQuarter(missions, year, splits)` (déjà dans `utils/kpiCompute.js`) renvoie `{ byPartner: { [p]: { new:[q1..q4], repeat:[q1..q4] } }, quarterTotals:[q1..q4], total }`.
- Étage 1, pour chaque partner présent dans `byPartner` :
  - portillon : le trimestre `i` ne verse que si `quarterTotals[i] >= gateTrimestriel`.
  - prime perso = somme sur les trimestres ouverts de `new[i] * txNew/100 + repeat[i] * txRepeat/100`, avec le taux du partner (`config.rates[nom]` sinon défaut).
  - Le pool est **indépendant de la liste des participants** : un partner sans CA signé ajoute 0. On itère donc directement sur les clés de `byPartner`.
- Étage 2 : `tauxColl` = taux du plus haut palier dont `seuil <= caFacture` (0 si aucun) ; `etage2 = tauxColl/100 * resultatAnnuel`.
- `pool = etage1 + etage2` (arrondi entier).

Référence front à reproduire : `primeCompute()` dans `public/pilot.html` (autour de la ligne 11610).

---

## File Structure

- `utils/kpiCompute.js` — ajout de `computePrimePool` et de deux helpers internes (`primeDefaultRates`, `normalizePrimeConfig`). Exportés.
- `utils/kpiCompute.test.js` — tests de `computePrimePool`.
- `server.js` — endpoint `/api/ebe` (autour de la ligne 8236) : fetch splits + config, appel `computePrimePool`, ajout au `totalCharges`, exposition dans la réponse.
- `public/pilot.html` — `renderCompteResultat` (sous-ligne) et `openCrDetailModal('charges')` (détail).

---

### Task 1: Fonction pure `computePrimePool` + helpers

**Files:**
- Modify: `utils/kpiCompute.js`
- Test: `utils/kpiCompute.test.js`

**Interfaces:**
- Consumes: `signedByQuarter(missions, year, splits)` (déjà exporté).
- Produces:
  - `primeDefaultRates(name) -> { txNew:number, txRepeat:number }`
  - `normalizePrimeConfig(config) -> { rates:object, tiers:Array<{seuil,taux}>, resultatAnnuel:number, gateTrimestriel:number }`
  - `computePrimePool({ missions, splits, config, year, caFacture }) -> { etage1:number, etage2:number, pool:number, tauxColl:number }`

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter en fin de `utils/kpiCompute.test.js` (le fichier importe déjà depuis `./kpiCompute` et définit un helper `mission(...)` ; réutiliser le même style d'import en ajoutant `computePrimePool`, `primeDefaultRates` à la ligne de `require`).

```js
const { computePrimePool, primeDefaultRates } = require('./kpiCompute');

describe('computePrimePool : pool de primes pour le compte de resultat', () => {
  // Config minimale explicite (pas de defauts a deviner dans les asserts).
  const cfg = {
    rates: { Vincent: { txNew: 4.5, txRepeat: 2.5 } },
    tiers: [{ seuil: 650000, taux: 7 }, { seuil: 600000, taux: 5 }, { seuil: 550000, taux: 3 }],
    resultatAnnuel: 150000,
    gateTrimestriel: 120000,
  };

  it('taux par defaut : Guillaume a la moitie', () => {
    expect(primeDefaultRates('Guillaume Dupont')).toEqual({ txNew: 2.25, txRepeat: 1.25 });
    expect(primeDefaultRates('Vincent')).toEqual({ txNew: 4.5, txRepeat: 2.5 });
  });

  it('etage 1 : un trimestre au-dessus du seuil verse la prime perso', () => {
    // Vincent signe 200000 de Newsale en T1 (>= seuil 120000).
    const m = mission({ id: 'a', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'], ca: 200000, etat: 'Signé' });
    const r = computePrimePool({ missions: [m], splits: [], config: cfg, year: 2026, caFacture: 0 });
    expect(r.etage1).toBe(9000);   // 200000 * 4.5%
    expect(r.etage2).toBe(0);      // caFacture 0 < premier palier
    expect(r.pool).toBe(9000);
  });

  it('portillon : un trimestre sous le seuil ne verse rien', () => {
    const m = mission({ id: 'b', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'], ca: 100000, etat: 'Signé' });
    const r = computePrimePool({ missions: [m], splits: [], config: cfg, year: 2026, caFacture: 0 });
    expect(r.etage1).toBe(0);      // 100000 < 120000 -> gele
    expect(r.pool).toBe(0);
  });

  it('etage 2 : palier selon caFacture', () => {
    const r = computePrimePool({ missions: [], splits: [], config: cfg, year: 2026, caFacture: 620000 });
    expect(r.tauxColl).toBe(5);          // 620000 >= 600000
    expect(r.etage2).toBe(7500);         // 5% * 150000
    expect(r.pool).toBe(7500);
  });

  it('config absente : applique les defauts (memes que le panneau KPI)', () => {
    const m = mission({ id: 'c', typeCa: 'Newsale', dateSignature: '2026-02-01', partnerCommercial: ['Vincent'], ca: 200000, etat: 'Signé' });
    const r = computePrimePool({ missions: [m], splits: [], config: null, year: 2026, caFacture: 660000 });
    // etage1 : 200000 * 4.5% (defaut) = 9000 ; etage2 : palier 660000 -> 7% * 150000 = 10500.
    expect(r.pool).toBe(19500);
  });
});
```

- [ ] **Step 2: Lancer les tests, vérifier l'échec**

Run: `npx jest utils/kpiCompute.test.js -t "computePrimePool"`
Expected: FAIL (`computePrimePool is not a function`).

- [ ] **Step 3: Implémenter les fonctions**

Dans `utils/kpiCompute.js`, avant la ligne `module.exports`, ajouter :

```js
// Taux par defaut Releaf : l'objectif de Guillaume est le double, donc son taux est la moitie.
function primeDefaultRates(name) {
  if (/guillaume/i.test(name || '')) return { txNew: 2.25, txRepeat: 1.25 };
  return { txNew: 4.5, txRepeat: 2.5 };
}

// Applique les memes defauts que le panneau KPI (front ensurePrimeConfig), pour que le compte de
// resultat affiche exactement le meme pool que l'onglet KPI meme si la config sauvegardee est partielle.
function normalizePrimeConfig(config) {
  const c = (config && typeof config === 'object') ? config : {};
  const tiers = (Array.isArray(c.tiers) && c.tiers.length)
    ? c.tiers
    : [{ seuil: 650000, taux: 7 }, { seuil: 600000, taux: 5 }, { seuil: 550000, taux: 3 }];
  return {
    rates: (c.rates && typeof c.rates === 'object') ? c.rates : {},
    tiers,
    resultatAnnuel: typeof c.resultatAnnuel === 'number' ? c.resultatAnnuel : 150000,
    gateTrimestriel: typeof c.gateTrimestriel === 'number' ? c.gateTrimestriel : 120000,
  };
}

// Pool de primes de l'annee = etage 1 (perso trimestriel, avec portillon) + etage 2 (collectif annuel).
// Reproduit primeCompute() du front. Le pool est independant de la liste des participants : on itere
// sur les partners porteurs de CA signe (cles de byPartner) ; un partner sans signe ajoute 0.
function computePrimePool({ missions, splits, config, year, caFacture }) {
  const cfg = normalizePrimeConfig(config);
  const sq = signedByQuarter(missions || [], year, splits || []);
  const gateOk = sq.quarterTotals.map((t) => t >= cfg.gateTrimestriel);

  let etage1 = 0;
  for (const name of Object.keys(sq.byPartner || {})) {
    const r = cfg.rates[name] || primeDefaultRates(name);
    const bp = sq.byPartner[name];
    for (let i = 0; i < 4; i++) {
      if (!gateOk[i]) continue;
      etage1 += (bp.new[i] || 0) * (r.txNew / 100) + (bp.repeat[i] || 0) * (r.txRepeat / 100);
    }
  }

  const caF = Math.max(0, Number(caFacture) || 0);
  const tiersAsc = cfg.tiers.slice().sort((a, b) => a.seuil - b.seuil);
  let tauxColl = 0;
  for (const t of tiersAsc) { if (caF >= t.seuil) tauxColl = t.taux; }
  const etage2 = (tauxColl / 100) * cfg.resultatAnnuel;

  return {
    etage1: Math.round(etage1),
    etage2: Math.round(etage2),
    pool: Math.round(etage1 + etage2),
    tauxColl,
  };
}
```

Puis ajouter `primeDefaultRates`, `normalizePrimeConfig`, `computePrimePool` à `module.exports`.

- [ ] **Step 4: Lancer les tests, vérifier le succès**

Run: `npx jest utils/kpiCompute.test.js -t "computePrimePool"`
Expected: PASS (4 tests).

- [ ] **Step 5: Lancer toute la suite kpiCompute (non-régression)**

Run: `npx jest utils/kpiCompute.test.js`
Expected: PASS (tous les tests existants + les nouveaux).

- [ ] **Step 6: Commit**

```bash
git add utils/kpiCompute.js utils/kpiCompute.test.js
git commit -m "feat(pilot) prime: fonction pure computePrimePool + tests"
```

---

### Task 2: Brancher le pool dans `/api/ebe`

**Files:**
- Modify: `server.js` (endpoint `/api/ebe`, autour des lignes 8236 à 8320)

**Interfaces:**
- Consumes: `computePrimePool` (Task 1), `signedByQuarter` (existant), table `kpi_prime_config` (id `default`), table `kpi_ca_split`.
- Produces: dans la réponse JSON, `charges.total` inclut désormais le pool, et un nouveau champ `charges.primesCommerciales` (number) porte le montant du pool.

**Rappel :** `computePrimePool` est déjà importé indirectement ? Non. En haut de `server.js`, la ligne d'import est `const { computeKpi, totalCaAnnee, signedByQuarter, clawbackCandidates } = require('./utils/kpiCompute');`. Il faut y ajouter `computePrimePool`.

- [ ] **Step 1: Ajouter l'import**

Modifier la ligne d'import (server.js:12) pour ajouter `computePrimePool` :

```js
const { computeKpi, totalCaAnnee, signedByQuarter, clawbackCandidates, computePrimePool } = require('./utils/kpiCompute');
```

- [ ] **Step 2: Charger les splits et la config, calculer le pool, l'ajouter aux charges**

Dans `/api/ebe`, juste après le calcul de `totalCharges` (server.js:8258, ligne `const totalCharges = Math.round(chargesData.totalCharges || 0);`), insérer :

```js
    // Primes commerciales (pool KPI) : charge d'exploitation (compte 622), ajoutee AVANT l'EBE.
    // Meme source que l'onglet KPI : config sauvegardee + missions Notion + splits d'attribution.
    let primesCommerciales = 0;
    try {
      const [cfgRow, splitRows] = await Promise.all([
        supabase.from('kpi_prime_config').select('config').eq('id', 'default').maybeSingle(),
        supabase.from('kpi_ca_split').select('*'),
      ]);
      const primeCfg = cfgRow && cfgRow.data ? cfgRow.data.config : null;
      const splits = (splitRows && splitRows.data) ? splitRows.data : [];
      const poolRes = computePrimePool({ missions, splits, config: primeCfg, year: yearParam, caFacture });
      primesCommerciales = poolRes.pool;
    } catch (e) {
      console.error('Erreur calcul primes /api/ebe:', e.message);
      primesCommerciales = 0; // ne jamais bloquer le compte de resultat
    }
    const totalChargesAvecPrimes = totalCharges + primesCommerciales;
```

Note : le client à utiliser est `supabase` (vérifié : c'est celui de `/api/kpi/prime-config`, server.js:6647). Ne pas introduire `supabaseAdmin` ici, pour rester cohérent avec les endpoints KPI voisins.

- [ ] **Step 3: Utiliser `totalChargesAvecPrimes` dans la cascade EBE**

Remplacer les usages de `totalCharges` dans le calcul de l'EBE (server.js:8269-8271) par `totalChargesAvecPrimes` :

```js
    const ebeFactuel = caFacture - totalChargesAvecPrimes + totalSubv + totalAide;
    const caProjete  = caFacture + pipelinePondere;
    const ebeProjete = caProjete - totalChargesAvecPrimes + totalSubv + totalAide;
```

- [ ] **Step 4: Exposer les primes dans la réponse**

Modifier la ligne `charges: { total: totalCharges },` (server.js:8305) en :

```js
      charges: { total: totalChargesAvecPrimes, primesCommerciales },
```

- [ ] **Step 5: Vérifier manuellement l'endpoint**

Démarrer le backend (`npm start`) puis, dans un autre terminal :

Run: `curl -s "http://localhost:3000/api/ebe?year=2026" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('primes=',j.charges.primesCommerciales,'total charges=',j.charges.total);})"`

Expected : `primes=` affiche un nombre >= 0, et `total charges` = charges hybrides + primes. Si l'auth dashboard bloque l'appel, tester via l'UI (Task 3) à la place.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(pilot) prime: pool ajoute aux charges du compte de resultat (/api/ebe)"
```

---

### Task 3: Affichage front (sous-ligne + détail)

**Files:**
- Modify: `public/pilot.html` (`renderCompteResultat` autour de 13541 ; `openCrDetailModal('charges')` autour de 13585)

**Interfaces:**
- Consumes: `d.charges.primesCommerciales` (number) exposé par `/api/ebe` (Task 2).

- [ ] **Step 1: Ajouter la sous-ligne dans la cascade**

Dans `renderCompteResultat`, juste après le bloc de la masse salariale (public/pilot.html:13542-13544), ajouter une sous-ligne primes :

```js
      if (d.charges && d.charges.primesCommerciales) {
        html += subRow('dont primes commerciales (deja dans les charges)', '(' + formatEuro(d.charges.primesCommerciales) + ')');
      }
```

- [ ] **Step 2: Ajouter le détail dans la modale des charges**

Dans `openCrDetailModal`, branche `kind === 'charges'`, après la ligne de la masse salariale (public/pilot.html:13589), ajouter :

```js
        if (d.charges && d.charges.primesCommerciales) body += '<div style="display:flex;justify-content:space-between;padding:0.4rem 0;color:var(--text-secondary)"><span>dont primes commerciales</span><span>' + formatEuro(d.charges.primesCommerciales) + '</span></div>';
```

- [ ] **Step 3: Vérifier dans l'UI**

Démarrer le backend (`npm start`) et le front (`npm run frontend:dev`), ouvrir le Pilot, aller sur « Compte de resultat », année 2026.

Expected :
- La ligne « Charges d'exploitation » inclut les primes.
- Une sous-ligne « dont primes commerciales (deja dans les charges) » apparaît si le pool > 0.
- Le clic sur « Charges d'exploitation » ouvre la modale avec la ligne « dont primes commerciales ».
- Le montant affiché est **identique** au « Pool total » de l'onglet KPI pour la même année.

- [ ] **Step 4: Commit**

```bash
git add public/pilot.html
git commit -m "feat(pilot) prime: sous-ligne primes commerciales dans le compte de resultat"
```

---

## Vérification finale de la Phase 1

- [ ] Le pool du compte de résultat correspond au « Pool total » de l'onglet KPI (même année).
- [ ] L'EBE, le résultat d'exploitation et le résultat net baissent du montant du pool.
- [ ] `npx jest utils/kpiCompute.test.js` passe intégralement.
- [ ] Aucune erreur console côté serveur ni navigateur.

## Suites (hors Phase 1, plans à venir)

- **Phase 2** : `computePrimePayments` + injection dans `buildPrevisionnel` (trésorerie), les 4 états, la règle du mois de versement.
- **Phase 3** : table `kpi_prime_versements`, endpoints, validation humaine par deal, exclusion des primes validées, paramètre mois de versement étage 2.
