# Garde-fou de réconciliation « dette de primes » · plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alerter quand le restant dû de la ligne de dette « Primes associés AAAA », saisi à la main dans le Google Sheet, ne correspond pas aux virements de primes réellement partis de Qonto.

**Architecture:** Un module pur `utils/primesReconciliation.js` compare deux jeux de données qu'il reçoit en paramètre (lignes de dette du Sheet, transactions Qonto brutes) et n'effectue aucun appel réseau. `server.js` fetche, met en cache 5 minutes, et expose le résultat sur `/api/tresorerie`. Le front affiche un badge et une ligne de modale. **Aucun montant existant n'est modifié** : la trésorerie nette de dette reste calculée exactement comme aujourd'hui.

**Tech Stack:** Node.js CommonJS, Jest 30, API Qonto v2, front vanilla JS dans `public/pilot.html`.

**Spec:** `docs/superpowers/specs/2026-08-31-primes-reconciliation-dette-design.md`

## Global Constraints

- **Ne pas démarrer tant que la branche `feat/ca-avancement` est en cours.** Une autre session travaille sur l'arbre. Créer `feat/primes-reconciliation-dette` depuis `master` une fois cette branche mergée.
- Backend en **CommonJS** : `require` / `module.exports`, jamais `import` / `export`.
- Le module `utils/primesReconciliation.js` doit rester **pur** : aucun `fetch`, aucun accès Supabase, aucune lecture de fichier. Seule exception tolérée, alignée sur `utils/chargesPerimetre.js` : la lecture de `process.env` au chargement du module.
- Tous les montants exposés par le module sont **arrondis à l'euro**, et les statuts sont calculés **sur ces valeurs arrondies** (spec §4.1, politique d'arrondi).
- Toute modification de `public/pilot.html` doit être **reportée à l'identique dans `dist/pilot.html`** : le projet maintient la parité des deux fichiers.
- Le rapprochement ne doit **jamais** écrire dans le Google Sheet ni modifier `totalDettes` / `tresorerieNetteDeDette`.
- Ne pas toucher `PRIMES_QONTO_SUBCATS` ni `chargesPerimetre.isPrimeSubcategory` : l'exclusion Option B des primes du réel Qonto doit rester strictement inchangée.
- Taux de TVA par défaut : `0.20`. Tolérance d'écart par défaut : `1` euro.
- `jest.config.js` ne cible que `**/utils/**/*.test.js` et **ne charge pas `.env`** : les tests sur les constantes par défaut sont donc stables. Ne pas ajouter `PRIMES_TVA_TAUX` ni `PRIMES_ECART_TOLERANCE` à un éventuel `setupFiles` sans adapter les tests concernés.

## Fichiers touchés

| Fichier | Rôle | Tâches |
|---|---|---|
| `utils/primesReconciliation.js` | **Créé.** Module pur : rattachement, agrégation, conversion HT, statuts, alertes, fenêtre de lecture. | 1-4 |
| `utils/primesReconciliation.test.js` | **Créé.** Suite Jest du module. | 1-4 |
| `server.js` | **Modifié.** Lecture Qonto multi-comptes en cache + exposition sur `/api/tresorerie`. | 5 |
| `public/pilot.html` | **Modifié.** Badge dans le tableau Dettes + bloc dans la modale nette de dette. | 6 |
| `dist/pilot.html` | **Modifié.** Report à l'identique. | 6 |

---

### Task 1: Module pur · helpers de base

**Files:**
- Create: `utils/primesReconciliation.js`
- Test: `utils/primesReconciliation.test.js`

**Interfaces:**
- Consomme : `normalizeLabel` et `PRIMES_SUBCATS` depuis `utils/chargesPerimetre.js` (déjà exportés).
- Produit : `envNumber(raw, defaut)`, `estLignePrimes(label)`, `agregerDebitsParSousCategorie(transactions)` retournant une `Map` de clé normalisée vers `{ montant, nb }`, et les constantes `PRIMES_TVA_TAUX`, `PRIMES_ECART_TOLERANCE`.

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `utils/primesReconciliation.test.js` :

```js
'use strict';

const {
  envNumber,
  estLignePrimes,
  agregerDebitsParSousCategorie,
  PRIMES_TVA_TAUX,
  PRIMES_ECART_TOLERANCE,
} = require('./primesReconciliation');

describe('envNumber', () => {
  it('renvoie le defaut si la variable est absente ou vide', () => {
    expect(envNumber(undefined, 0.2)).toBe(0.2);
    expect(envNumber('', 0.2)).toBe(0.2);
  });
  it('accepte la valeur zero, qui ne doit pas retomber sur le defaut', () => {
    expect(envNumber('0', 1)).toBe(0);
  });
  it('renvoie le defaut si la valeur est non numerique', () => {
    expect(envNumber('abc', 1)).toBe(1);
  });
});

describe('estLignePrimes', () => {
  it('reconnait une ligne de primes quelle que soit la casse', () => {
    expect(estLignePrimes('Primes associes 2025')).toBe(true);
    expect(estLignePrimes('PRIME exceptionnelle')).toBe(true);
  });
  it('ignore les autres lignes de dette', () => {
    expect(estLignePrimes('Avance remboursable BPI')).toBe(false);
    expect(estLignePrimes('Emprunt bancaire')).toBe(false);
    expect(estLignePrimes('')).toBe(false);
    expect(estLignePrimes(null)).toBe(false);
  });
});

describe('agregerDebitsParSousCategorie', () => {
  const tx = (side, amount, nom) => ({ side, amount, cashflow_subcategory: nom ? { name: nom } : null });

  it('agrege plusieurs debits sur la meme sous-categorie (une prime, plusieurs decaissements)', () => {
    const m = agregerDebitsParSousCategorie([
      tx('debit', 1200, 'Primes associes 2025'),
      tx('debit', 2400, 'Primes associes 2025'),
    ]);
    expect(m.get('primes associes 2025')).toEqual({ montant: 3600, nb: 2 });
  });

  it('normalise accents, casse et espaces multiples pour la cle', () => {
    const m = agregerDebitsParSousCategorie([
      tx('debit', 100, 'Primes  ASSOCIÉS   2025 '),
    ]);
    expect(m.get('primes associes 2025')).toEqual({ montant: 100, nb: 1 });
  });

  it('ignore les credits : un virement entrant n eteint jamais une dette', () => {
    const m = agregerDebitsParSousCategorie([
      tx('credit', 5000, 'Primes associes 2025'),
    ]);
    expect(m.has('primes associes 2025')).toBe(false);
  });

  it('ignore les transactions sans sous-categorie', () => {
    const m = agregerDebitsParSousCategorie([tx('debit', 100, null)]);
    expect(m.size).toBe(0);
  });

  it('renvoie une map vide pour une entree vide ou absente', () => {
    expect(agregerDebitsParSousCategorie([]).size).toBe(0);
    expect(agregerDebitsParSousCategorie(undefined).size).toBe(0);
  });
});

describe('constantes par defaut', () => {
  it('expose un taux de TVA de 20 % et une tolerance de 1 euro', () => {
    expect(PRIMES_TVA_TAUX).toBe(0.20);
    expect(PRIMES_ECART_TOLERANCE).toBe(1);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npx jest utils/primesReconciliation.test.js`
Expected: FAIL, `Cannot find module './primesReconciliation'`

- [ ] **Step 3: Écrire l'implémentation minimale**

Créer `utils/primesReconciliation.js` :

```js
'use strict';

// Rapprochement pur entre les lignes de dette de primes du Google Sheet (onglet Dettes) et les
// debits Qonto de la sous-categorie HOMONYME. Garde-fou en lecture seule : ce module ne corrige
// jamais un montant, il signale un ecart.
// Spec : docs/superpowers/specs/2026-08-31-primes-reconciliation-dette-design.md
//
// Module pur, sans effet de bord (hormis la lecture de process.env au chargement, meme convention
// que utils/chargesPerimetre.js) : server.js fetche les dettes (parseDettes) et les transactions
// Qonto, ce module ne fait que comparer. Meme decoupage que utils/dealsNotionCoherence.js.

const { normalizeLabel, PRIMES_SUBCATS } = require('./chargesPerimetre');

// Lit une variable d'environnement numerique. Ecrit a la main plutot qu'avec `Number(x) || defaut`
// parce que ce dernier ferait retomber la valeur '0' sur le defaut, ce qui interdirait une
// tolerance de zero euro.
function envNumber(raw, defaut) {
  if (raw === undefined || raw === null || raw === '') return defaut;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaut;
}

// Taux de TVA des factures de primes d'associes : la dette du Sheet est en HT, le virement Qonto
// est en TTC. Fixe et nomme volontairement, plutot que la cascade TVA a trois etages des charges :
// cette derniere retombe silencieusement sur le TTC quand Pennylane n'a pas la facture, ce qui
// fabriquerait un faux ecart de 20 % (spec section 3).
const PRIMES_TVA_TAUX = envNumber(process.env.PRIMES_TVA_TAUX, 0.20);

// Tolerance d'ecart en euros : calibree pour n'absorber que l'arrondi de la division par 1,20.
const PRIMES_ECART_TOLERANCE = envNumber(process.env.PRIMES_ECART_TOLERANCE, 1);

// Une ligne du carnet de dettes est une ligne de primes si son libelle contient "prime".
// Meme convention que `estAvance = (label) => /avance/i.test(label)` cote server.js.
function estLignePrimes(label) {
  return /prime/i.test(String(label || ''));
}

// Somme des DEBITS Qonto par sous-categorie normalisee -> Map(cle -> { montant, nb }).
// Les credits sont ignores : un virement entrant d'un associe ne doit jamais eteindre une dette.
function agregerDebitsParSousCategorie(transactions) {
  const parSousCat = new Map();
  for (const tx of transactions || []) {
    if (!tx || tx.side !== 'debit') continue;
    const nom = (tx.cashflow_subcategory && tx.cashflow_subcategory.name) || '';
    const cle = normalizeLabel(nom);
    if (!cle) continue;
    const cur = parSousCat.get(cle) || { montant: 0, nb: 0 };
    cur.montant += Number(tx.amount) || 0;
    cur.nb += 1;
    parSousCat.set(cle, cur);
  }
  return parSousCat;
}

module.exports = {
  envNumber,
  estLignePrimes,
  agregerDebitsParSousCategorie,
  PRIMES_TVA_TAUX,
  PRIMES_ECART_TOLERANCE,
  PRIMES_SUBCATS,
};
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npx jest utils/primesReconciliation.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add utils/primesReconciliation.js utils/primesReconciliation.test.js
git commit -m "feat(pilot) reconciliation primes : helpers purs (detection ligne, agregation des debits par sous-categorie)"
```

---

### Task 2: Module pur · rattachement, conversion HT et statuts

**Files:**
- Modify: `utils/primesReconciliation.js`
- Test: `utils/primesReconciliation.test.js`

**Interfaces:**
- Consomme : `estLignePrimes`, `agregerDebitsParSousCategorie`, `PRIMES_TVA_TAUX`, `PRIMES_ECART_TOLERANCE` (Task 1).
- Produit : `reconcilePrimes({ dettes, transactions, primesSubcats, tauxTva, tolerance })` retournant `{ lignes, totaux, alertes }`. `alertes` reste un tableau vide jusqu'à la Task 3. Chaque entrée de `lignes` porte `{ label, montantInitial, restant, declareRembourseHT, reelTTC, reelHT, nbTransactions, ecart, statut, couvertParExclusion }`.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `utils/primesReconciliation.test.js` :

```js
const { reconcilePrimes } = require('./primesReconciliation');

// Jeu de donnees de reference : 3600 TTC verses = 3000 HT.
const SUBCATS = ['primes associes 2025', 'primes associes 2026'];
const dette = (label, montantInitial, restant) => ({ label, montantInitial, restant, controle: true });
const debit = (amount, nom) => ({ side: 'debit', amount, cashflow_subcategory: { name: nom } });

describe('reconcilePrimes · rattachement et conversion', () => {
  it('rattache par libelle normalise et convertit le TTC en HT', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(3600, 'Primes ASSOCIES 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes).toHaveLength(1);
    expect(r.lignes[0].declareRembourseHT).toBe(3000);
    expect(r.lignes[0].reelTTC).toBe(3600);
    expect(r.lignes[0].reelHT).toBe(3000);
    expect(r.lignes[0].ecart).toBe(0);
    expect(r.lignes[0].statut).toBe('ok');
    expect(r.lignes[0].nbTransactions).toBe(1);
  });

  it('agrege plusieurs decaissements sur une meme ligne', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(1200, 'Primes associes 2025'), debit(2400, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].nbTransactions).toBe(2);
    expect(r.lignes[0].reelHT).toBe(3000);
  });

  it('ne rattache PAS deux libelles proches mais distincts', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(3600, 'Primes associees 2025'), debit(1200, 'Primes associes 2026')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].nbTransactions).toBe(0);
    expect(r.lignes[0].statut).toBe('sans_reel');
  });

  it('accepte un taux de TVA surcharge', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [debit(1100, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
      tauxTva: 0.10,
    });
    expect(r.lignes[0].reelHT).toBe(1000);
  });

  it('ignore les lignes de dette qui ne sont pas des primes', () => {
    const r = reconcilePrimes({
      dettes: [dette('Avance remboursable BPI', 58800, 40000), dette('Primes associes 2025', 10000, 10000)],
      transactions: [],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes.map(l => l.label)).toEqual(['Primes associes 2025']);
  });
});

describe('reconcilePrimes · statuts et seuil', () => {
  // Declare rembourse = 3000 HT. Le reel HT varie autour, tolerance par defaut = 1 euro.
  const cas = (reelTTC) => reconcilePrimes({
    dettes: [dette('Primes associes 2025', 10000, 7000)],
    transactions: [debit(reelTTC, 'Primes associes 2025')],
    primesSubcats: SUBCATS,
  }).lignes[0];

  it('ok quand l ecart est juste SOUS le seuil', () => {
    expect(cas(3601.2).ecart).toBe(1);      // 3001 HT - 3000
    expect(cas(3601.2).statut).toBe('ok');
  });

  it('sous_declare quand l ecart depasse le seuil vers le haut', () => {
    const l = cas(3603.6);                   // 3003 HT
    expect(l.ecart).toBe(3);
    expect(l.statut).toBe('sous_declare');
  });

  it('ok quand l ecart negatif est juste SOUS le seuil', () => {
    expect(cas(3598.8).ecart).toBe(-1);      // 2999 HT
    expect(cas(3598.8).statut).toBe('ok');
  });

  it('sur_declare quand l ecart depasse le seuil vers le bas', () => {
    const l = cas(3596.4);                   // 2997 HT
    expect(l.ecart).toBe(-3);
    expect(l.statut).toBe('sur_declare');
  });

  it('sans_reel prime sur sur_declare quand aucune transaction n est rattachee', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].statut).toBe('sans_reel');
    expect(r.lignes[0].ecart).toBe(-3000);
  });

  it('rapproche aussi les lignes dont la case de controle est decochee', () => {
    const r = reconcilePrimes({
      dettes: [{ label: 'Primes associes 2025', montantInitial: 10000, restant: 7000, controle: false }],
      transactions: [debit(3600, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes).toHaveLength(1);
    expect(r.lignes[0].statut).toBe('ok');
  });
});

describe('reconcilePrimes · totaux', () => {
  it('les totaux sont la somme exacte des valeurs de ligne deja arrondies', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000), dette('Primes associes 2026', 5000, 5000)],
      transactions: [debit(3603.6, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    const sommeEcarts = r.lignes.reduce((s, l) => s + l.ecart, 0);
    expect(r.totaux.ecart).toBe(sommeEcarts);
    expect(r.totaux.declareRembourseHT).toBe(3000);
    expect(r.totaux.reelHT).toBe(3003);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npx jest utils/primesReconciliation.test.js`
Expected: FAIL, `reconcilePrimes is not a function`

- [ ] **Step 3: Écrire l'implémentation minimale**

Ajouter dans `utils/primesReconciliation.js`, avant `module.exports` :

```js
// Rapprochement principal. Entrees :
//   dettes        : [{ label, montantInitial, restant, controle }] issues de parseDettes (server.js)
//   transactions  : transactions Qonto brutes, tous comptes, deja bornees a la fenetre de lecture
//   primesSubcats : liste normalisee des sous-categories de primes (defaut PRIMES_SUBCATS)
//   tauxTva       : taux de TVA des factures de primes (defaut PRIMES_TVA_TAUX)
//   tolerance     : seuil d'ecart en euros (defaut PRIMES_ECART_TOLERANCE)
//
// Politique d'arrondi (spec section 4.1) : tous les montants sont arrondis a l'euro AVANT le
// calcul du statut, pour qu'un badge ne puisse jamais annoncer "ecart de 0 EUR" tout en etant en
// alerte. Les totaux somment les valeurs de ligne deja arrondies, donc l'invariant est exact.
function reconcilePrimes({
  dettes,
  transactions,
  primesSubcats = PRIMES_SUBCATS,
  tauxTva = PRIMES_TVA_TAUX,
  tolerance = PRIMES_ECART_TOLERANCE,
} = {}) {
  const parSousCat = agregerDebitsParSousCategorie(transactions);
  const lignes = [];

  for (const d of dettes || []) {
    if (!estLignePrimes(d && d.label)) continue;
    const cle = normalizeLabel(d.label);
    const agg = parSousCat.get(cle) || { montant: 0, nb: 0 };

    const declareRembourseHT = Math.round((Number(d.montantInitial) || 0) - (Number(d.restant) || 0));
    const reelTTC = Math.round(agg.montant);
    const reelHT = Math.round(agg.montant / (1 + tauxTva));
    const ecart = reelHT - declareRembourseHT;

    // `sans_reel` prime sur les autres statuts : une ligne sans aucune transaction rattachee
    // n'est jamais qualifiee de `sur_declare`, les deux cas appelant des actions differentes
    // (creer la sous-categorie Qonto, ou chercher le virement manquant).
    let statut;
    if (agg.nb === 0) statut = 'sans_reel';
    else if (Math.abs(ecart) <= tolerance) statut = 'ok';
    else if (ecart > 0) statut = 'sous_declare';
    else statut = 'sur_declare';

    lignes.push({
      label: d.label,
      montantInitial: Math.round(Number(d.montantInitial) || 0),
      restant: Math.round(Number(d.restant) || 0),
      declareRembourseHT,
      reelTTC,
      reelHT,
      nbTransactions: agg.nb,
      ecart,
      statut,
      couvertParExclusion: (primesSubcats || []).includes(cle),
    });
  }

  const totaux = lignes.reduce((acc, l) => ({
    declareRembourseHT: acc.declareRembourseHT + l.declareRembourseHT,
    reelHT: acc.reelHT + l.reelHT,
    ecart: acc.ecart + l.ecart,
  }), { declareRembourseHT: 0, reelHT: 0, ecart: 0 });

  return { lignes, totaux, alertes: [] };
}
```

Ajouter `reconcilePrimes` à `module.exports`.

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npx jest utils/primesReconciliation.test.js`
Expected: PASS, tous les tests des Tasks 1 et 2

- [ ] **Step 5: Commit**

```bash
git add utils/primesReconciliation.js utils/primesReconciliation.test.js
git commit -m "feat(pilot) reconciliation primes : rattachement par sous-categorie homonyme, conversion TTC vers HT, 4 statuts"
```

---

### Task 3: Module pur · alertes structurelles

**Files:**
- Modify: `utils/primesReconciliation.js`
- Test: `utils/primesReconciliation.test.js`

**Interfaces:**
- Consomme : `reconcilePrimes` (Task 2).
- Produit : `reconcilePrimes(...).alertes` désormais peuplé, chaque entrée valant `{ type, label, montant, message }` avec `type` dans `'sous_categorie_non_exclue' | 'reel_orphelin'`.

Ces deux alertes sont **séparées** des statuts de ligne : un écart de montant ne crée jamais d'alerte, et une alerte ne change jamais un statut (spec §4.1).

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `utils/primesReconciliation.test.js` :

```js
describe('reconcilePrimes · alertes structurelles', () => {
  it('alerte quand une ligne de primes n est pas couverte par la liste d exclusion', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2027', 4000, 4000)],
      transactions: [],
      primesSubcats: SUBCATS, // 2027 absent
    });
    expect(r.lignes[0].couvertParExclusion).toBe(false);
    const a = r.alertes.find(x => x.type === 'sous_categorie_non_exclue');
    expect(a).toBeDefined();
    expect(a.label).toBe('Primes associes 2027');
    expect(a.message).toMatch(/double compte/i);
    // Une alerte structurelle ne doit modifier AUCUN statut de ligne (spec section 4.1).
    expect(r.lignes[0].statut).toBe('sans_reel');
  });

  it('n alerte pas quand la ligne est bien couverte', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].couvertParExclusion).toBe(true);
    expect(r.alertes.filter(a => a.type === 'sous_categorie_non_exclue')).toHaveLength(0);
  });

  it('alerte sur des debits de primes sans ligne de dette homonyme', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [debit(1200, 'Primes associes 2026')],
      primesSubcats: SUBCATS,
    });
    const a = r.alertes.find(x => x.type === 'reel_orphelin');
    expect(a).toBeDefined();
    expect(a.montant).toBe(1200);
  });

  it('n alerte pas orphelin pour une sous-categorie hors perimetre primes', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 10000)],
      transactions: [debit(900, 'Fournitures de bureau')],
      primesSubcats: SUBCATS,
    });
    expect(r.alertes.filter(a => a.type === 'reel_orphelin')).toHaveLength(0);
  });

  it('un ecart de montant ne cree aucune alerte', () => {
    const r = reconcilePrimes({
      dettes: [dette('Primes associes 2025', 10000, 7000)],
      transactions: [debit(9999, 'Primes associes 2025')],
      primesSubcats: SUBCATS,
    });
    expect(r.lignes[0].statut).toBe('sous_declare');
    expect(r.alertes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npx jest utils/primesReconciliation.test.js -t "alertes structurelles"`
Expected: FAIL, `r.alertes.find(...)` renvoie `undefined` (le tableau est vide)

- [ ] **Step 3: Écrire l'implémentation minimale**

Dans `reconcilePrimes`, remplacer `return { lignes, totaux, alertes: [] };` par :

```js
  // --- Alertes STRUCTURELLES, distinctes des statuts de ligne ---
  // Elles ne portent pas sur des montants qui divergent, mais sur un cablage incoherent entre le
  // Sheet, Qonto et la liste d'exclusion. Un ecart de montant ne cree jamais d'alerte ici.
  const alertes = [];

  // 1. Ligne de primes absente de la liste d'exclusion : ses debits Qonto retournent dans le reel
  // des charges, alors qu'ils y sont deja par le calcul de prime => double compte silencieux au
  // compte de resultat. C'est le piege ouvert par le nommage libre des sous-categories.
  for (const l of lignes) {
    if (l.couvertParExclusion) continue;
    alertes.push({
      type: 'sous_categorie_non_exclue',
      label: l.label,
      montant: 0,
      message: 'Ajouter « ' + l.label + ' » a PRIMES_QONTO_SUBCATS puis redemarrer le serveur : '
        + 'sans cela ces virements sont comptes en double dans les charges.',
    });
  }

  // 2. Symetrique : des debits classes dans une sous-categorie de primes CONNUE, mais qu'aucune
  // ligne de dette ne reclame. Typiquement un millesime paye sans ligne au carnet, ou une faute
  // de frappe sur le libelle d'un des deux cotes.
  const clesLignes = new Set(lignes.map(l => normalizeLabel(l.label)));
  for (const [cle, agg] of parSousCat.entries()) {
    if (!(primesSubcats || []).includes(cle)) continue;
    if (clesLignes.has(cle)) continue;
    alertes.push({
      type: 'reel_orphelin',
      label: cle,
      montant: Math.round(agg.montant),
      message: agg.nb + ' virement(s) de primes (' + Math.round(agg.montant) + ' EUR TTC) sans ligne '
        + 'de dette correspondante dans le carnet : verifier le libelle des deux cotes.',
    });
  }

  return { lignes, totaux, alertes };
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npx jest utils/primesReconciliation.test.js`
Expected: PASS, tous les tests des Tasks 1 à 3

- [ ] **Step 5: Commit**

```bash
git add utils/primesReconciliation.js utils/primesReconciliation.test.js
git commit -m "feat(pilot) reconciliation primes : alertes structurelles (sous-categorie non exclue, reel orphelin)"
```

---

### Task 4: Module pur · fenêtre de lecture Qonto

**Files:**
- Modify: `utils/primesReconciliation.js`
- Test: `utils/primesReconciliation.test.js`

**Interfaces:**
- Consomme : `estLignePrimes` (Task 1).
- Produit : `fenetreReconciliation(dettes, nowIso)` retournant `{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }`, consommé par le serveur en Task 5.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `utils/primesReconciliation.test.js` :

```js
const { fenetreReconciliation } = require('./primesReconciliation');

describe('fenetreReconciliation', () => {
  it('part du 1er janvier du plus ancien millesime trouve dans les libelles', () => {
    const f = fenetreReconciliation(
      [dette('Primes associes 2026', 0, 0), dette('Primes associes 2025', 0, 0)],
      '2026-08-31T10:00:00.000Z'
    );
    expect(f).toEqual({ from: '2025-01-01', to: '2026-08-31' });
  });

  it('ignore les millesimes des lignes qui ne sont pas des primes', () => {
    const f = fenetreReconciliation(
      [dette('Avance remboursable BPI 2021', 0, 0), dette('Primes associes 2026', 0, 0)],
      '2026-08-31T10:00:00.000Z'
    );
    expect(f.from).toBe('2026-01-01');
  });

  it('replie sur l annee courante si aucun millesime n est detectable', () => {
    const f = fenetreReconciliation([dette('Primes associes', 0, 0)], '2026-08-31T10:00:00.000Z');
    expect(f.from).toBe('2026-01-01');
  });

  it('replie sur l annee courante si aucune ligne de primes n existe', () => {
    const f = fenetreReconciliation([dette('Emprunt bancaire', 0, 0)], '2026-08-31T10:00:00.000Z');
    expect(f.from).toBe('2026-01-01');
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npx jest utils/primesReconciliation.test.js -t "fenetreReconciliation"`
Expected: FAIL, `fenetreReconciliation is not a function`

- [ ] **Step 3: Écrire l'implémentation minimale**

Ajouter dans `utils/primesReconciliation.js`, avant `module.exports` :

```js
// Fenetre de lecture Qonto : du 1er janvier du plus ancien millesime trouve dans les libelles des
// lignes de primes, jusqu'a aujourd'hui. Une prime millesimee N est decaissee en N+1 (voire plus
// tard si le calendrier derive), donc remonter au 1er janvier du millesime est large a dessein.
// Sans millesime detectable, repli sur le debut de l'annee courante.
function fenetreReconciliation(dettes, nowIso) {
  const annees = [];
  for (const d of dettes || []) {
    if (!estLignePrimes(d && d.label)) continue;
    const m = String(d.label).match(/\b(20\d{2})\b/);
    if (m) annees.push(Number(m[1]));
  }
  const anneeCourante = Number(String(nowIso).slice(0, 4));
  const debut = annees.length ? Math.min(...annees) : anneeCourante;
  return { from: debut + '-01-01', to: String(nowIso).slice(0, 10) };
}
```

Ajouter `fenetreReconciliation` à `module.exports`.

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `npx jest utils/primesReconciliation.test.js`
Expected: PASS, l'intégralité de la suite du module

- [ ] **Step 5: Commit**

```bash
git add utils/primesReconciliation.js utils/primesReconciliation.test.js
git commit -m "feat(pilot) reconciliation primes : fenetre de lecture Qonto derivee des millesimes du carnet"
```

---

### Task 5: Serveur · lecture Qonto multi-comptes et exposition sur `/api/tresorerie`

**Files:**
- Modify: `server.js` (require en tête de fichier ; nouvelle fonction près de `fetchAndParseDettes`, `server.js:4957` ; branchement dans `/api/tresorerie`, `server.js:6714` et réponse `server.js:6820-6830`)

**Interfaces:**
- Consomme : `reconcilePrimes` et `fenetreReconciliation` (Tasks 2-4), `fetchQontoTransactionsRange(iban, from, to)` (existant, `server.js:8379`), `qontoRequest` (existant), `fetchAndParseDettes()` (existant, `server.js:4957`).
- Produit : deux clés supplémentaires dans la réponse de `/api/tresorerie` : `reconciliationPrimes` (l'objet du module, ou `null`) et `reconciliationPrimesError` (message d'erreur, ou `null`).

Cette tâche n'ajoute pas de test unitaire : elle ne contient aucune logique, toute la logique testable ayant été isolée dans le module pur des Tasks 1 à 4. C'est le découpage déjà retenu pour `dealsNotionCoherence`. La vérification se fait par appel réel de l'endpoint.

- [ ] **Step 1: Ajouter le require**

Repérer le require existant de `chargesPerimetre` en tête de `server.js` et ajouter juste après :

```js
const primesReconciliation = require('./utils/primesReconciliation');
```

- [ ] **Step 2: Ajouter la lecture Qonto en cache**

Insérer juste après la fonction `fetchAndParseDettes` (`server.js:4957-4966`) :

```js
// --- Garde-fou : reconciliation "dette de primes" (Sheet) vs debits Qonto (reel) ---
// Lecture seule, ne corrige AUCUN montant : voir docs/superpowers/specs/2026-08-31-primes-reconciliation-dette-design.md
// Deux differences volontaires avec le calcul des charges (computeChargesHybride) :
//   - TOUS les comptes bancaires, pas seulement le compte principal : un virement de prime parti
//     d'un autre compte produirait sinon un faux "sur_declare". Coherent avec soldeTousComptes,
//     qui sert deja au KPI de tresorerie nette.
//   - Debits uniquement : filtre applique dans le module pur (agregerDebitsParSousCategorie).
let primesReconCache = null;
let primesReconCacheTime = 0;
const PRIMES_RECON_CACHE_TTL = 5 * 60 * 1000;

async function fetchPrimesReconciliation(dettesRes) {
  if (primesReconCache && (Date.now() - primesReconCacheTime) < PRIMES_RECON_CACHE_TTL) {
    return primesReconCache;
  }
  const dettes = (dettesRes && dettesRes.dettes) || [];
  const { from, to } = primesReconciliation.fenetreReconciliation(dettes, new Date().toISOString());

  const org = await qontoRequest('/v2/organization');
  const comptes = (org.organization && org.organization.bank_accounts) || [];
  const parCompte = await Promise.all(
    comptes.filter(c => c.iban).map(c => fetchQontoTransactionsRange(c.iban, from, to))
  );
  const transactions = parCompte.flat();

  const result = primesReconciliation.reconcilePrimes({ dettes, transactions });
  primesReconCache = result;
  primesReconCacheTime = Date.now();
  return result;
}
```

- [ ] **Step 3: Brancher dans `/api/tresorerie`**

Dans `/api/tresorerie`, juste avant le calcul de `tresorerieNetteDeDette` (`server.js:6819`), ajouter :

```js
    // Garde-fou lecture seule : n'influence NI totalDettes NI tresorerieNetteDeDette.
    // Une panne Qonto ne doit jamais casser la page tresorerie : on degrade en silence.
    let reconciliationPrimes = null;
    let reconciliationPrimesError = null;
    try {
      reconciliationPrimes = await fetchPrimesReconciliation(dettesRes);
    } catch (e) {
      reconciliationPrimesError = e.message;
      console.warn('[tresorerie] reconciliation primes indisponible : %s', e.message);
    }
```

Puis, dans l'objet `res.json({ ... })`, ajouter après la ligne `totalDettes:` (`server.js:6829`) :

```js
      reconciliationPrimes,
      reconciliationPrimesError,
```

- [ ] **Step 4: Vérifier que la suite de tests existante ne casse pas**

Run: `npx jest`
Expected: PASS, aucune régression (le module est nouveau, `server.js` n'est pas couvert par Jest)

- [ ] **Step 5: Vérifier l'endpoint sur le serveur réel**

Run: `npm start` dans un terminal, puis dans un autre :

```bash
curl -s localhost:3000/api/tresorerie | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(JSON.stringify(j.reconciliationPrimes,null,2));console.log('erreur:',j.reconciliationPrimesError)})"
```

Expected: un objet avec une entrée par ligne de primes du carnet, `reelTTC` non nul si des virements sont partis, et `reconciliationPrimesError` à `null`.

Vérifier aussi que `tresorerieNetteDeDette` et `totalDettes` sont **identiques** à leur valeur avant la modification : ce lot ne doit changer aucun chiffre.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(pilot) reconciliation primes : lecture Qonto tous comptes en cache, exposee sur /api/tresorerie"
```

---

### Task 6: Front · badge dans le carnet et bloc dans la modale

**Files:**
- Modify: `public/pilot.html` (`renderTresoDettes`, ligne 15489 ; `openNetteDetteModal`, ligne 15443)
- Modify: `dist/pilot.html` (report à l'identique)

**Interfaces:**
- Consomme : `tresoData.reconciliationPrimes` (Task 5), les helpers front existants `formatEuro` et `escapeHtml`, et les classes CSS `.cr-tva-badge` / `.cr-tva-badge.warn` déjà définies (`pilot.html:4336-4337`).

- [ ] **Step 1: Ajouter le helper de badge**

Dans `public/pilot.html`, insérer juste avant `function renderTresoDettes()` :

```js
    // Badge de reconciliation des primes (garde-fou lecture seule) : compare le remboursement
    // declare dans le Sheet aux virements Qonto reellement partis. N'affiche rien quand tout colle.
    function badgeReconciliationPrimes(label) {
      const recon = tresoData && tresoData.reconciliationPrimes;
      if (!recon || !recon.lignes) return '';
      const l = recon.lignes.find(x => x.label === label);
      if (!l || l.statut === 'ok') return '';
      const txt = {
        sous_declare: 'verse ' + formatEuro(l.ecart) + ' de plus que declare',
        sur_declare: 'declare ' + formatEuro(-l.ecart) + ' de plus que le reel Qonto',
        sans_reel: 'aucun virement rattache',
      }[l.statut];
      if (!txt) return '';
      const titre = 'Rapprochement Qonto (HT) : reel ' + formatEuro(l.reelHT)
        + ' vs declare rembourse ' + formatEuro(l.declareRembourseHT)
        + '. Un virement lance aujourd hui n apparait pas encore (Qonto ne renvoie que le regle).';
      return ' <span class="cr-tva-badge warn" title="' + escapeHtml(titre) + '">' + escapeHtml(txt) + '</span>';
    }
```

- [ ] **Step 2: Afficher le badge dans le tableau**

Dans `renderTresoDettes`, la cellule du libellé se construit ainsi :

```js
          + '<td style="padding:0.5rem 0.5rem 0.5rem 0">' + escapeHtml(d.label) + reelTxt + (compte ? '' : ' <span style="font-size:0.72rem;color:var(--text-secondary)">(hors photo)</span>') + '</td>'
```

La remplacer par :

```js
          + '<td style="padding:0.5rem 0.5rem 0.5rem 0">' + escapeHtml(d.label) + reelTxt + badgeReconciliationPrimes(d.label) + (compte ? '' : ' <span style="font-size:0.72rem;color:var(--text-secondary)">(hors photo)</span>') + '</td>'
```

- [ ] **Step 3: Ajouter le bloc dans la modale nette de dette**

Dans `openNetteDetteModal`, juste avant la ligne du total (celle qui contient `Trésorerie nette de dette</strong>`), insérer :

```js
      // Garde-fou primes : on explicite les trois montants pour que l'ecart soit lisible sans
      // avoir a ouvrir le Sheet. Ce bloc n'entre PAS dans le calcul ci-dessous.
      const recon = tresoData.reconciliationPrimes;
      const lignesAlerte = recon && recon.lignes ? recon.lignes.filter(l => l.statut !== 'ok') : [];
      if (lignesAlerte.length) {
        html += '<div style="margin-top:0.75rem;padding:0.6rem;border:1px solid var(--warning);border-radius:var(--radius-sm);font-size:0.8rem">';
        html += '<div style="font-weight:600;margin-bottom:0.35rem">Rapprochement des primes avec Qonto</div>';
        for (const l of lignesAlerte) {
          html += '<div style="color:var(--text-secondary);padding:0.15rem 0">'
            + escapeHtml(l.label) + ' : declare rembourse ' + formatEuro(l.declareRembourseHT)
            + ' HT, reel Qonto ' + formatEuro(l.reelHT) + ' HT, ecart ' + formatEuro(l.ecart) + '</div>';
        }
        for (const a of (recon.alertes || [])) {
          html += '<div style="color:var(--warning);padding:0.15rem 0">' + escapeHtml(a.message) + '</div>';
        }
        html += '<div style="color:var(--text-secondary);margin-top:0.35rem;font-style:italic">Ce controle ne modifie aucun montant ci-dessus.</div>';
        html += '</div>';
      }
```

- [ ] **Step 4: Reporter à l'identique dans `dist/pilot.html`**

Appliquer exactement les mêmes trois modifications dans `dist/pilot.html`, puis vérifier la parité :

```bash
diff <(grep -c "badgeReconciliationPrimes" public/pilot.html) <(grep -c "badgeReconciliationPrimes" dist/pilot.html)
```

Expected: aucune sortie (comptes identiques, valeur attendue : 2 occurrences dans chaque fichier)

- [ ] **Step 5: Vérifier dans le navigateur**

Lancer `npm start`, ouvrir la page Pilot, onglet Trésorerie. Vérifier :
- le carnet « Dettes & engagements fermes » affiche le badge sur la ligne de primes si un écart existe ;
- la modale « Trésorerie nette de dette » affiche le bloc de rapprochement ;
- le montant de la trésorerie nette est **inchangé** par rapport à avant le lot.

- [ ] **Step 6: Commit**

```bash
git add public/pilot.html dist/pilot.html
git commit -m "feat(pilot) reconciliation primes : badge au carnet de dettes et bloc de rapprochement en modale"
```

---

## Vérification finale du lot

- [ ] `npx jest` : suite complète au vert
- [ ] `tresorerieNetteDeDette` et `totalDettes` identiques à leur valeur d'avant le lot
- [ ] Les primes restent exclues du réel Qonto des charges (`primesExclues` inchangé dans la modale des charges)
- [ ] Mettre à jour la mémoire projet `gsheet-primes-writeback.md` avec le statut de ce lot et le lien vers la spec

## Reste à faire hors de ce lot

La table de matching prime par prime, et l'alimentation du paramètre `versements` de `computePrimePayments` qui allumerait enfin le statut `verse`, sont décrites en section 10 de la spec. Rien dans ce plan ne les contredit.
