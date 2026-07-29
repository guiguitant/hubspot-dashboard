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

// Total « CA <année> HT » (source Notion) : somme, sur toutes les missions non « Annulé »,
// du CA rattaché à `year` (facturé ou non, via signedAmountForYear). C'est LE chiffre partagé
// par le Cockpit, l'onglet Analytics et le KPI, pour qu'ils affichent tous la même valeur.
// Inclut les missions sans type_ca (elles font partie du CA de l'année même si non classées).
function totalCaAnnee(missions, year) {
  let total = 0;
  for (const m of missions || []) {
    if (SIGNE_EXCLUDED_STATES.includes(m.etat)) continue;
    total += signedAmountForYear(m, year);
  }
  return Math.round(total);
}

// Trimestre (1-4) d'une date ISO / 'YYYY-MM-DD', sinon null. Slicing (pas de parsing Date) pour
// rester insensible au fuseau horaire.
function quarterOfDate(d) {
  if (!d) return null;
  const mois = Number(String(d).slice(5, 7));
  if (!mois || mois < 1 || mois > 12) return null;
  return Math.ceil(mois / 3);
}

// Date de signature d'une mission : le champ "Date de signature" s'il est renseigné, sinon la date
// de création de la ligne Notion (proxy, en attendant le backfill des vraies dates).
function signatureDate(m) {
  return m.dateSignature || m.dateCreation || null;
}

// CA signé (source Notion) ventilé par trimestre pour `year`, DATÉ À LA SIGNATURE.
// Base des primes commerciales trimestrielles (étage 1). Différent de signedAmountForYear (qui date à
// la facture) : une mission est signée en un seul événement, donc son CA ENTIER tombe dans le trimestre
// de signature (pas de découpage acompte/solde).
//   - byPartner[p] = { new:[q1..q4], repeat:[q1..q4] } : CA classé (Newsale/Upsale) réparti par %.
//   - quarterTotals[q] : CA signé TOTAL du trimestre (toutes missions non « Annulé », classées ou non),
//     base du seuil de rentabilité collectif (le portillon trimestriel).
function signedByQuarter(missions, year, splits) {
  const splitIndex = {};
  for (const s of splits || []) {
    if (!s || s.axis !== 'commercial') continue;
    (splitIndex[s.mission_id] = splitIndex[s.mission_id] || {})[s.partner] = Number(s.pct) || 0;
  }
  const byPartner = {};
  const detailByPartner = {};                 // [p][q] = [{ id, nom, client, montant, pct, type }] : traçabilité prime -> deals
  const quarterTotals = [0, 0, 0, 0];
  const unattributed = [];                     // { id, nom, client, ca, quarter, reason } : signé mais non rattaché à un partner
  const ensure = (p) => {
    if (!byPartner[p]) { byPartner[p] = { new: [0, 0, 0, 0], repeat: [0, 0, 0, 0] }; detailByPartner[p] = [[], [], [], []]; }
    return byPartner[p];
  };

  for (const m of missions || []) {
    if (SIGNE_EXCLUDED_STATES.includes(m.etat)) continue;
    const ca = Number(m.ca) || 0;
    if (ca <= 0) continue;
    const sig = signatureDate(m);
    if (yearOfDate(sig) !== year) continue;
    const q = quarterOfDate(sig);
    if (!q) continue;
    quarterTotals[q - 1] += ca;

    let type = null;
    if (m.typeCa === 'Newsale') type = 'new';
    else if (m.typeCa === 'Upsale') type = 'repeat';
    const partners = m.partnerCommercial || [];
    // Non attribué : sans partner, ou sans type (Newsale/Upsale). Compté dans quarterTotals mais chez aucun partner.
    // C'est LA fuite d'attribution : le contrôle de couverture (front) s'appuie là-dessus.
    if (!partners.length || !type) {
      unattributed.push({ id: m.id, nom: m.nom, client: m.client, ca: Math.round(ca), quarter: q, reason: !partners.length ? 'sans partner' : 'sans type' });
      continue;
    }
    const shares = splitAmount(ca, partners, splitIndex[m.id]);
    for (const [p, amt] of Object.entries(shares)) {
      ensure(p)[type][q - 1] += amt;
      detailByPartner[p][q - 1].push({ id: m.id, nom: m.nom, client: m.client, montant: Math.round(amt), pct: ca > 0 ? Math.round(amt / ca * 100) : 0, type });
    }
  }

  for (const p of Object.keys(byPartner)) {
    byPartner[p].new = byPartner[p].new.map((v) => Math.round(v));
    byPartner[p].repeat = byPartner[p].repeat.map((v) => Math.round(v));
  }
  return {
    partners: Object.keys(byPartner).sort(),
    byPartner,
    detailByPartner,
    quarterTotals: quarterTotals.map((v) => Math.round(v)),
    total: Math.round(quarterTotals.reduce((s, v) => s + v, 0)),
    unattributed: {
      total: Math.round(unattributed.reduce((s, x) => s + x.ca, 0)),
      missions: unattributed,
    },
  };
}

// Candidats au clawback (reprise) : missions « Annulé » signées sur un trimestre DÉJÀ PAYÉ
// (quarter <= paidThroughQuarter), qui ont donc potentiellement généré une prime déjà versée.
// Retourne le détail par partner (montant = part après split) ; le taux/la prime sont appliqués côté
// front (qui a la config). Montant indicatif : on ignore si l'annulation est antérieure ou postérieure
// au paiement (pas de date d'annulation fiable), d'où la vérification manuelle.
function clawbackCandidates(missions, year, splits, paidThroughQuarter) {
  const splitIndex = {};
  for (const s of splits || []) {
    if (!s || s.axis !== 'commercial') continue;
    (splitIndex[s.mission_id] = splitIndex[s.mission_id] || {})[s.partner] = Number(s.pct) || 0;
  }
  const out = [];
  for (const m of missions || []) {
    if (m.etat !== 'Annulé') continue;
    const ca = Number(m.ca) || 0;
    if (ca <= 0) continue;
    if (yearOfDate(signatureDate(m)) !== year) continue;
    const q = quarterOfDate(signatureDate(m));
    if (!q || q > (paidThroughQuarter || 0)) continue; // pas encore payé -> pas un clawback
    let type = null;
    if (m.typeCa === 'Newsale') type = 'new';
    else if (m.typeCa === 'Upsale') type = 'repeat';
    const partners = m.partnerCommercial || [];
    if (!type || !partners.length) continue; // n'aurait pas généré de prime perso
    const shares = splitAmount(ca, partners, splitIndex[m.id]);
    for (const [p, amt] of Object.entries(shares)) {
      out.push({ id: m.id, nom: m.nom, client: m.client, quarter: q, partner: p, montant: Math.round(amt), type });
    }
  }
  return out;
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
    // CA signé (source Notion) daté À LA SIGNATURE, comme signedByQuarter et la prime individuelle :
    // le CA ENTIER de la mission tombe sur son année de signature (pas de découpage acompte/solde, qui
    // relève de la facturation). 0 si l'état est "Annulé" (exclu du signé). Le total FACTURÉ de l'année
    // reste, lui, calculé à la date de facture via caAnnee/signedAmountForYear (base de la prime collective).
    const caSigne = (SIGNE_EXCLUDED_STATES.includes(m.etat) || yearOfDate(signatureDate(m)) !== year) ? 0 : ca;
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

  return { year, partners, all, unclassified, missionsForSplit, allDetails: allDetail, caAnnee: totalCaAnnee(missions, year) };
}

module.exports = { computeKpi, yearOf, yearOfDate, signedAmountForYear, totalCaAnnee, signedByQuarter, clawbackCandidates, quarterOfDate, signatureDate, splitAmount, displaySplit, OPERE_STATES, SIGNE_EXCLUDED_STATES };
