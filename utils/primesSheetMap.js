'use strict';

// Index colonne 0-based -> lettre A1 (0->A, 25->Z, 26->AA).
function colToLetter(idx) {
  let n = idx, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Libelle d'en-tete -> cle 'YYYY-MM' (gere 'MM/YYYY', 'M/YYYY', 'YYYY-MM...'), sinon null.
function parseMonthHeader(v) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return m[2] + '-' + m[1].padStart(2, '0');
  m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return m[1] + '-' + m[2];
  return null;
}

// Decouvre la structure de la grille (tableau 2D de lignes du sheet).
// labelCol = index 0-based de la colonne des libelles (defaut 2 = colonne C).
// partnerNames (optionnel) = ne retenir comme sous-lignes que ces noms.
function discoverLayout(grid, opts = {}) {
  const labelCol = opts.labelCol != null ? opts.labelCol : 2;
  const partnerNames = opts.partnerNames || null;

  // 1) Ligne d'en-tete = celle qui contient le plus de cellules 'mois'.
  let headerRow = -1, monthCols = {}, best = 0;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const found = {};
    for (let c = 0; c < row.length; c++) {
      const mk = parseMonthHeader(row[c]);
      if (mk && found[mk] == null) found[mk] = c;
    }
    if (Object.keys(found).length > best) { best = Object.keys(found).length; headerRow = r; monthCols = found; }
  }
  if (headerRow < 0 || best === 0) throw new Error('Ligne d\'en-tete des mois introuvable');

  // 2) Categorie .Primes dans la colonne des libelles.
  let primesRow = -1;
  for (let r = 0; r < grid.length; r++) {
    const label = String((grid[r] || [])[labelCol] || '').trim();
    if (/^\.\s*primes\b/i.test(label)) { primesRow = r; break; }
  }
  if (primesRow < 0) throw new Error('Categorie .Primes introuvable');

  // 3) Sous-lignes = lignes suivantes sans prefixe de categorie ('.'/'cm.') jusqu'a la prochaine.
  const partnerRows = {};
  for (let r = primesRow + 1; r < grid.length; r++) {
    const label = String((grid[r] || [])[labelCol] || '').trim();
    if (!label) continue;
    if (/^(\.|cm\.)/i.test(label)) break;
    if (partnerNames && !partnerNames.includes(label)) continue;
    if (partnerRows[label] == null) partnerRows[label] = r;
  }
  return { headerRow, primesRow, monthCols, partnerRows };
}

// Throw si un participant attendu n'a pas de ligne (garde-fou : ne rien ecrire au mauvais endroit).
function assertPartners(layout, expected) {
  const missing = (expected || []).filter(p => layout.partnerRows[p] == null);
  if (missing.length) throw new Error('Associe(s) introuvable(s) dans .Primes : ' + missing.join(', '));
}

// Clef plancher 'YYYY-01' du DEBUT DE L'EXERCICE de nowIso (pas le mois courant). Pourquoi : le
// plancher de charge (floorChargeKey, cf kpiCompute.js) glisse de trimestre en trimestre ; si on
// figeait au mois courant, la cellule du trimestre precedent garderait sa valeur obsolete (jamais
// remise a 0) pendant que la meme charge est reecrite au trimestre suivant, d'ou un double compte.
// Derive l'annee de la meme facon que l'appelant (server.js::syncPrimesToSheet) : ne change rien au
// comportement, rend seulement la derivation testable independamment de server.js.
function primesFloorKey(nowIso) {
  const currentYear = new Date(nowIso).getFullYear();
  return currentYear + '-01';
}

// Construit les ecritures. Pour chaque associe (ligne connue) et chaque mois present dans la grille
// avec mk >= floorKey, ecrit la valeur de byPartnerMonth ou 0 (remise a zero des primes obsoletes).
// floorKey = DEBUT DE L'EXERCICE COURANT ('YYYY-01'), pas le mois courant. Pourquoi : le plancher de
// charge (floorChargeKey, cf kpiCompute.js) glisse d'un trimestre a l'autre ; si on figeait au mois
// courant, la cellule du trimestre precedent (qui portait la charge avant le glissement) ne serait
// plus jamais reecrite et garderait sa vieille valeur, doublant la charge comptee par CR_Prev a
// chaque changement de trimestre. En figeant au debut de l'exercice, TOUS les mois de l'exercice
// courant sont reecrits (valeur ou 0) a chaque run ; seuls les exercices anterieurs restent figes
// (decembre N-1 protege au passage d'annee). Retourne { updates: [{ range, value }] }.
function buildUpdates(layout, byPartnerMonth, tabName, floorKey) {
  const updates = [];
  for (const [partner, rowIdx] of Object.entries(layout.partnerRows)) {
    for (const [mk, colIdx] of Object.entries(layout.monthCols)) {
      if (mk < floorKey) continue; // figement : on ne touche pas les exercices anterieurs
      const src = byPartnerMonth[partner] || {};
      const value = Math.round(src[mk] || 0);
      updates.push({ range: tabName + '!' + colToLetter(colIdx) + (rowIdx + 1), value });
    }
  }
  return { updates };
}

// Arrondit un dict { cle: float } en entiers, en preservant le total = round(somme).
// Methode du plus grand reste (largest remainder) : evite l'ecart d'arrondi cellule par cellule,
// pour que le total par associe colle a l'euro a ce que Pilot affiche.
function roundPreservingSum(values) {
  const entries = Object.entries(values || {});
  if (!entries.length) return {};
  const target = Math.round(entries.reduce((s, [, v]) => s + (v || 0), 0));
  const parts = entries.map(([k, v]) => { const f = Math.floor(v || 0); return { k, base: f, frac: (v || 0) - f }; });
  let rest = target - parts.reduce((s, p) => s + p.base, 0);
  parts.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < parts.length && rest > 0; i++, rest--) parts[i].base += 1;
  const out = {};
  for (const p of parts) out[p.k] = p.base;
  return out;
}

// Arrondit `entries` (typiquement detailCharge, une entree par ligne/deal, chacune avec { partner,
// montant }) en entiers, en preservant la somme PAR ASSOCIE (entries[i].partner) plutot que la somme
// globale : chaque associe est arrondi independamment via roundPreservingSum, pour que la somme des
// lignes d'un associe dans le tableau "Par deal" (endpoint /api/primes/avancement) tombe EXACTEMENT sur
// son total affiche dans "Par associe" (meme methode d'arrondi des deux cotes). Fonction PURE : retourne
// un NOUVEAU tableau (memes entrees, `montant` remplace par sa version arrondie), dans le meme ordre que
// `entries`, sans modifier `entries`.
function roundEntriesPreservingSumByPartner(entries) {
  const list = entries || [];
  const floatsByPartner = {};
  list.forEach((e, i) => {
    (floatsByPartner[e.partner] = floatsByPartner[e.partner] || {})[i] = e.montant;
  });
  const roundedByIndex = {};
  for (const floats of Object.values(floatsByPartner)) {
    Object.assign(roundedByIndex, roundPreservingSum(floats));
  }
  return list.map((e, i) => ({ ...e, montant: roundedByIndex[i] }));
}

module.exports = { colToLetter, parseMonthHeader, discoverLayout, assertPartners, buildUpdates, roundPreservingSum, primesFloorKey, roundEntriesPreservingSumByPartner };
