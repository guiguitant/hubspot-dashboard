'use strict';

// États : voir spec 2026-06-26-kpi-partners-design.md §2.
const SIGNE_EXCLUDED_STATES = ['Annulé'];          // signé = tout sauf ça
const OPERE_STATES = ['En cours', 'Terminé'];      // opéré = ces états
const TYPES = ['newsale', 'upsale', 'opere'];

// Année (number) depuis un ISO timestamp ('2026-03-01T...' → 2026), sinon null.
function yearOf(iso) {
  return iso ? Number(String(iso).slice(0, 4)) : null;
}

// Année (number) d'une date de facture ('2025-12-15' ou ISO) ou d'une string d'année ('2026'), sinon null.
function yearOfDate(d) {
  return d ? Number(String(d).slice(0, 4)) : null;
}

// CA signé d'une mission rattaché à `year` (source : Notion).
// Une mission = acompte + solde, chacun rattaché à l'année d'émission de SA facture :
//   - acompte = montantAcompte, daté par dateFactureAcompte ; si non émise → année du champ "Année final".
//   - solde   = ca - montantAcompte, daté par dateFactureFinale ; si non émise → année du champ "Année final".
// Une mission facturée à cheval contribue donc à deux années. Sans date ni "Année final" → 0 (non rattachable).
function signedAmountForYear(m, year) {
  const ca = Number(m.ca) || 0;
  const acompte = Number(m.montantAcompte) || 0;
  const solde = Math.max(0, ca - acompte);
  const anneeFinal = m.anneeFinal ? Number(m.anneeFinal) : null;
  const acompteYear = m.dateFactureAcompte ? yearOfDate(m.dateFactureAcompte) : anneeFinal;
  const soldeYear   = m.dateFactureFinale ? yearOfDate(m.dateFactureFinale) : anneeFinal;
  let total = 0;
  if (acompteYear === year) total += acompte;
  if (soldeYear === year)   total += solde;
  return total;
}

// Répartit `ca` entre `partners` selon `overrides` ({partner: pct}) si non vide,
// sinon à parts égales. Retourne { partner: montant }.
function splitAmount(ca, partners, overrides) {
  const out = {};
  if (!partners || partners.length === 0) return out;
  const hasOverride = overrides && Object.keys(overrides).length > 0;
  if (hasOverride) {
    const totalPct = partners.reduce((s, p) => s + (Number(overrides[p]) || 0), 0);
    for (const p of partners) {
      const pct = Number(overrides[p]) || 0;
      out[p] = totalPct > 0 ? ca * (pct / totalPct) : ca / partners.length;
    }
  } else {
    const share = ca / partners.length;
    for (const p of partners) out[p] = share;
  }
  return out;
}

// Map d'affichage des pourcentages pour le panneau réglages (défaut égal ou override).
function displaySplit(partners, overrides) {
  const out = {};
  if (!partners || partners.length === 0) return out;
  const hasOverride = overrides && Object.keys(overrides).length > 0;
  if (hasOverride) {
    for (const p of partners) out[p] = Number(overrides[p]) || 0;
  } else {
    const eq = Math.round((100 / partners.length) * 100) / 100;
    for (const p of partners) out[p] = eq;
  }
  return out;
}

function computeKpi({ missions, objectives, splits, year }) {
  // Index des overrides : splitIndex[mission_id][axis] = { partner: pct }
  const splitIndex = {};
  for (const s of splits || []) {
    splitIndex[s.mission_id] = splitIndex[s.mission_id] || {};
    splitIndex[s.mission_id][s.axis] = splitIndex[s.mission_id][s.axis] || {};
    splitIndex[s.mission_id][s.axis][s.partner] = Number(s.pct) || 0;
  }

  // Accumulateur des montants réalisés par partner/type.
  const acc = {};
  const add = (partner, type, amount) => {
    acc[partner] = acc[partner] || { newsale: 0, upsale: 0, opere: 0 };
    acc[partner][type] += amount;
  };
  // Détail des missions contribuant à chaque (partner, type) — pour le pop-up au clic sur une barre.
  const detailAcc = {}; // detailAcc[partner][type] = [{ id, nom, client, montant }]
  const allDetail = { newsale: [], upsale: [], opere: [] }; // détail "All" (CA plein par mission)
  const addDetail = (partner, type, m, montant) => {
    detailAcc[partner] = detailAcc[partner] || { newsale: [], upsale: [], opere: [] };
    detailAcc[partner][type].push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(montant) });
  };

  const unclassified = [];
  const missionsForSplit = [];

  for (const m of missions || []) {
    const ca = Number(m.ca) || 0;
    // CA signé (source Notion) rattaché à `year` : acompte/solde répartis par date d'émission de facture,
    // repli sur "Année final" si non facturé. 0 si l'état est "Annulé" (exclu du signé).
    const caSigne = SIGNE_EXCLUDED_STATES.includes(m.etat) ? 0 : signedAmountForYear(m, year);
    // Opéré : critère d'année inchangé (date de création de la ligne Notion) + CA total de la mission.
    const isOpereYear = yearOf(m.dateCreation) === year && OPERE_STATES.includes(m.etat);

    // --- Signé (commercial) ---
    if (caSigne > 0) {
      let type = null;
      if (m.typeCa === 'Newsale') type = 'newsale';
      else if (m.typeCa === 'Upsale') type = 'upsale';

      if (type) {
        const shares = splitAmount(caSigne, m.partnerCommercial, (splitIndex[m.id] || {}).commercial);
        for (const [p, amt] of Object.entries(shares)) { add(p, type, amt); addDetail(p, type, m, amt); }
        allDetail[type].push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(caSigne) });
      } else {
        unclassified.push({ id: m.id, nom: m.nom, client: m.client, ca: Math.round(caSigne) });
      }
    }

    // --- Opéré (opérationnel) : En cours / Terminé, daté par la création ---
    if (isOpereYear) {
      const shares = splitAmount(ca, m.partnerOperationnel, (splitIndex[m.id] || {}).operationnel);
      for (const [p, amt] of Object.entries(shares)) { add(p, 'opere', amt); addDetail(p, 'opere', m, amt); }
      allDetail.opere.push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(ca) });
    }

    // --- missionsForSplit : missions à 2+ partners contribuant à l'année (signé ou opéré) ---
    if (caSigne > 0 || isOpereYear) {
      const com = m.partnerCommercial || [];
      const ope = m.partnerOperationnel || [];
      if (com.length >= 2 || ope.length >= 2) {
        missionsForSplit.push({
          id: m.id, nom: m.nom, ca,
          commercial: com, operationnel: ope,
          splitCommercial: displaySplit(com, (splitIndex[m.id] || {}).commercial),
          splitOperationnel: displaySplit(ope, (splitIndex[m.id] || {}).operationnel),
        });
      }
    }
  }

  // Objectifs indexés par partner/type (année filtrée).
  const objIndex = {};
  for (const o of objectives || []) {
    if (o.year !== year) continue;
    objIndex[o.partner] = objIndex[o.partner] || {};
    objIndex[o.partner][o.type] = Number(o.montant) || 0;
  }

  // Liste des partners = union (réalisé) ∪ (objectifs).
  const names = new Set([...Object.keys(acc), ...Object.keys(objIndex)]);
  const partners = [];
  const allReal = { newsale: 0, upsale: 0, opere: 0 };
  const allObj = { newsale: 0, upsale: 0, opere: 0 };

  for (const name of [...names].sort()) {
    const real = acc[name] || { newsale: 0, upsale: 0, opere: 0 };
    const obj = objIndex[name] || {};
    const details = detailAcc[name] || { newsale: [], upsale: [], opere: [] };
    for (const type of TYPES) details[type].sort((a, b) => b.montant - a.montant);
    const row = { partner: name, details };
    for (const type of TYPES) {
      const realise = Math.round(real[type] || 0);
      const objectif = Math.round(obj[type] || 0);
      row[type] = { objectif, realise, tx: objectif > 0 ? realise / objectif : null };
      allReal[type] += realise;
      allObj[type] += objectif;
    }
    partners.push(row);
  }

  const all = {};
  for (const type of TYPES) {
    all[type] = {
      objectif: allObj[type], realise: allReal[type],
      tx: allObj[type] > 0 ? allReal[type] / allObj[type] : null,
    };
  }

  for (const type of TYPES) allDetail[type].sort((a, b) => b.montant - a.montant);

  return { year, partners, all, unclassified, missionsForSplit, allDetails: allDetail };
}

module.exports = { computeKpi, yearOf, yearOfDate, signedAmountForYear, splitAmount, displaySplit, OPERE_STATES, SIGNE_EXCLUDED_STATES };
