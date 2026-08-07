/**
 * Script de recette (lecture seule) pour le chantier "charges du compte de resultat"
 * (perimetre PCG, conversion HT, vraie fin de mois).
 *
 * Verifie, pour /api/charges-hybride et /api/previsionnel-charges, l'invariant qui a servi de fil
 * rouge a tout le chantier : le total renvoye doit egaler la somme de sa propre serie mensuelle
 * (comparaison.N), a une tolerance d'arrondi de 1 EUR/mois pres (cf spec section 3). Affiche aussi
 * les totaux 2025/2026, l'indicateur tvaExacte et les compteurs d'exclusion (primes, hors
 * exploitation) pour une lecture rapide sans ouvrir le dashboard.
 *
 * Usage : node scripts/recette-charges.js
 * Prerequis : le serveur (npm start) doit tourner en local sur le PORT cible (defaut 3000), avec le
 * code a recetter deja en place (PAS de redemarrage effectue par ce script). GET uniquement, aucune
 * ecriture, sans effet de bord sur les donnees.
 *
 * Code de sortie : 0 si tous les invariants passent, 1 sinon (ou en cas d'erreur reseau/HTTP).
 */
'use strict';

const BASE_URL = process.env.RECETTE_BASE_URL || 'http://localhost:3000';
const ANNEES = [2025, 2026];
// Tolerance d'arrondi : 1 EUR par mois de la serie (cf spec "±1 €/mois d'arrondi").
const TOLERANCE_PAR_MOIS = 1;

async function getJSON(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function sommeSerie(comparaison) {
  if (!comparaison || !Array.isArray(comparaison.N)) return null;
  return comparaison.N.reduce((a, b) => a + (Number(b) || 0), 0);
}

// Verifie l'invariant total = somme(comparaison.N) a la tolerance pres. Retourne { ok, ecart, nbMois }.
function verifieInvariant(total, comparaison) {
  const somme = sommeSerie(comparaison);
  const nbMois = comparaison && Array.isArray(comparaison.mois) ? comparaison.mois.length : 0;
  if (somme === null) return { ok: false, ecart: null, nbMois, raison: 'pas de serie comparaison.N exploitable' };
  const ecart = Math.round((total - somme) * 100) / 100;
  const tolerance = Math.max(nbMois, 1) * TOLERANCE_PAR_MOIS;
  return { ok: Math.abs(ecart) <= tolerance, ecart, nbMois, tolerance };
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return Math.round(n).toLocaleString('fr-FR') + ' €';
}

async function recetteChargesHybride(annee, resultats) {
  const label = `/api/charges-hybride ${annee}`;
  try {
    const data = await getJSON(`/api/charges-hybride?start=${annee}-01-01&end=${annee}-12-31`);
    const inv = verifieInvariant(data.totalCharges, data.comparaison);
    resultats.push({ label, ok: inv.ok, detail: inv });

    console.log(`\n${label}`);
    console.log(`  totalCharges        : ${fmt(data.totalCharges)}`);
    console.log(`  invariant (total = somme serie, tol. ${inv.tolerance ?? 'n/a'} €) : ${inv.ok ? 'OK' : 'CASSE'} (ecart ${fmt(inv.ecart)})`);
    if (data.tvaExacte) {
      const { montantCouvert, montantTotal } = data.tvaExacte;
      const pct = montantTotal > 0 ? Math.round((100 * montantCouvert) / montantTotal) : 0;
      console.log(`  tvaExacte           : ${fmt(montantCouvert)} / ${fmt(montantTotal)} (${pct} %)`);
    }
    if (data.primesExclues) {
      console.log(`  primesExclues       : ${fmt(data.primesExclues.montant)} (${data.primesExclues.nb} tx)`);
    }
    if (data.horsExploitationExclues) {
      console.log(`  horsExploitationExclues : ${fmt(data.horsExploitationExclues.montant)} (${data.horsExploitationExclues.nb} tx)`);
    }
  } catch (err) {
    resultats.push({ label, ok: false, detail: { raison: err.message } });
    console.log(`\n${label}`);
    console.log(`  ERREUR : ${err.message}`);
  }
}

async function recettePrevisionnelCharges(annee, resultats) {
  const label = `/api/previsionnel-charges ${annee}`;
  try {
    const data = await getJSON(`/api/previsionnel-charges?start=${annee}-01&end=${annee}-12`);
    const inv = verifieInvariant(data.totalCharges, data.comparaison);
    resultats.push({ label, ok: inv.ok, detail: inv });

    console.log(`\n${label}`);
    console.log(`  totalCharges        : ${fmt(data.totalCharges)}`);
    console.log(`  moyenneMensuelle    : ${fmt(data.moyenneMensuelle)}`);
    console.log(`  invariant (total = somme serie, tol. ${inv.tolerance ?? 'n/a'} €) : ${inv.ok ? 'OK' : 'CASSE'} (ecart ${fmt(inv.ecart)})`);
  } catch (err) {
    resultats.push({ label, ok: false, detail: { raison: err.message } });
    console.log(`\n${label}`);
    console.log(`  ERREUR : ${err.message}`);
  }
}

async function main() {
  console.log(`Recette charges (perimetre PCG + TVA HT) contre ${BASE_URL}`);
  console.log('Lecture seule (GET) : aucune donnee modifiee.');

  const resultats = [];
  for (const annee of ANNEES) {
    await recetteChargesHybride(annee, resultats);
    await recettePrevisionnelCharges(annee, resultats);
  }

  const casses = resultats.filter(r => !r.ok);
  console.log('\n--- Resume ---');
  for (const r of resultats) {
    console.log(`  ${r.ok ? 'OK   ' : 'CASSE'} ${r.label}`);
  }

  if (casses.length > 0) {
    console.log(`\n${casses.length} invariant(s) casse(s) sur ${resultats.length}.`);
    process.exit(1);
  }
  console.log(`\nTous les invariants (${resultats.length}) sont verifies.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Echec du script de recette :', err.message);
  process.exit(1);
});
