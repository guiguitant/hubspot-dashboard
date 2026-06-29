'use strict';

// Synthèse de facturation par année, alignée sur la page Facturation du dashboard
// (buildInvoiceLines + applyKpiFilter dans public/pilot.html).
// Chaque mission produit jusqu'à 2 lignes (Acompte, Solde) ; le statut découle du
// champ Notion "Facturation" et peut être surchargé via facture_overrides.
//
// Pour la base de l'objectif collectif (étage 2 des primes) :
//   facture   = lignes déjà émises et datées dans l'année (date de facture dans `year`)
//   aFacturer = lignes en attente d'émission (statut "A envoyer" / "En attente", non datées)
//   total     = facture + aFacturer  (le CA à facturer de l'exercice)

const MIN_MONTANT = 5; // seuil cohérent avec la logique TRE (one-shot)
const PENDING = new Set(['A envoyer', 'En attente']);

function normFact(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function yearOfDate(d) {
  if (!d) return null;
  const y = new Date(d).getFullYear();
  return isNaN(y) ? null : y;
}

// Statut dérivé d'une ligne (même logique que buildInvoiceLines côté front).
function derivedStatus(type, nf) {
  if (type === 'Acompte') {
    if (nf.includes('acompte a envoyer')) return 'A envoyer';
    if (nf.includes('acompte envoye')) return 'Envoye';
    return 'Paye';
  }
  // Solde
  if (nf.includes('acompte a envoyer') || nf.includes('acompte envoye')) return 'En attente';
  if (nf.includes('acompte paye') || nf.includes('solde a envoyer')) return 'A envoyer';
  if (nf.includes('solde envoye')) return 'Envoye';
  return 'Paye';
}

function computeBillingForYear(missions, overrides, year) {
  const ovMap = {};
  for (const o of overrides || []) {
    if (o && o.mission && o.type) ovMap[o.mission + '||' + o.type] = o;
  }

  let facture = 0, aFacturer = 0;

  for (const m of missions || []) {
    const nf = normFact(m.facturation);
    const items = [];
    if ((m.montantAcompte || 0) >= MIN_MONTANT) items.push({ type: 'Acompte', montant: m.montantAcompte, date: m.dateFactureAcompte });
    if ((m.montantFinal || 0) >= MIN_MONTANT) items.push({ type: 'Solde', montant: m.montantFinal, date: m.dateFactureFinale });

    for (const it of items) {
      const ov = ovMap[m.nom + '||' + it.type];
      const status = (ov && ov.status) || derivedStatus(it.type, nf);
      if (it.date) {
        // Ligne émise : ne compte que si datée dans l'année demandée.
        if (yearOfDate(it.date) === year) facture += it.montant;
      } else if (PENDING.has(status)) {
        // Pas encore émise mais à facturer → pipeline de facturation de l'exercice.
        aFacturer += it.montant;
      }
    }
  }

  return {
    facture: Math.round(facture),
    aFacturer: Math.round(aFacturer),
    total: Math.round(facture + aFacturer),
  };
}

module.exports = { computeBillingForYear, normFact, derivedStatus };
