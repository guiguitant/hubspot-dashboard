'use strict';

// Production immobilisee (compte 72 du PCG) : produit d'exploitation qui neutralise, l'annee de leur
// engagement, les charges portees a l'actif par le module Immobilisations. Sans lui le compte de
// resultat subit une double peine : la quote-part de salaire (ou la prestation) reste comptee en
// charge pleine ET la dotation aux amortissements s'y ajoute des la mise en service. Feature E,
// docs/superpowers/specs/2026-08-08-produits-et-suivis-design.md#E.
//
// Module PUR, sans effet de bord ni acces reseau : il recoit des donnees deja chargees par server.js
// (lignes des tables `immobilisations` et `immobilisation_postes`, cf migrations 32 a 40) et rend des
// montants. Deux mesures pour la meme annee :
//   - projete : le retenu ANNUEL complet, formule identique a `montantPosteRetenu` de server.js
//     (montant x quote-part x prorata temporel) -- c'est ce qui sera immobilise sur l'exercice ;
//   - factuel : la part de ce retenu deja ECOULEE a la fin du dernier mois clos (meme borne que le
//     reel des charges et des subventions), pour que la cascade factuelle du compte de resultat
//     reste comparable a des charges elles aussi arretees a cette borne.
//
// Attention (raison d'etre du "factuel") : compter le retenu annuel entier dans la cascade factuelle
// gonflerait le resultat d'un produit dont les charges correspondantes ne sont pas encore passees.

const MS_PAR_JOUR = 86400000;

// Nombre de jours entre deux dates. Math.round absorbe les decalages d'une heure dus au passage a
// l'heure d'ete et au fait que 'YYYY-MM-DD' se parse en UTC alors que new Date(y, m, d) est local :
// meme convention que _daysBetween dans server.js, dont ce module reproduit les formules.
function _daysBetween(a, b) { return Math.round((b - a) / MS_PAR_JOUR); }

// Annee d'imputation d'un poste. Repli identique a /api/immobilisations et sumCreditsForYear :
// un poste sans annee est rattache a l'annee de mise en service de son immobilisation.
// Renvoie null si elle est indeterminable (impossible avec le schema reel : date_mise_en_service est
// NOT NULL) ; le poste est alors ignore plutot que compte dans TOUTES les annees.
function _anneePoste(poste, immo) {
  const a = Number(poste.annee);
  if (a) return a;
  if (immo && immo.date_mise_en_service) {
    const d = new Date(immo.date_mise_en_service);
    if (!isNaN(d.getTime())) return d.getFullYear();
  }
  return null;
}

// Fenetre effective d'un poste sur son annee : [debut, fin[ (fin exclusive), ou null si vide.
// date_fin est INCLUSIVE cote base, d'ou le +1 jour. Sans dates : l'annee civile entiere.
function _fenetreAnnee(poste, annee) {
  const debutAnnee = new Date(annee, 0, 1);
  const finAnnee = new Date(annee + 1, 0, 1); // exclue
  let d = poste.date_debut ? new Date(poste.date_debut) : debutAnnee;
  let f = poste.date_fin ? new Date(new Date(poste.date_fin).getTime() + MS_PAR_JOUR) : finAnnee;
  // Repli INDEPENDANT par borne : une date invalide retombe sur le defaut de CETTE borne seule (comme
  // server.js/_prorataPoste, ou une comparaison avec une date NaN est toujours fausse et choisit deja
  // implicitement la borne d'annee cote a cote) -- une seule date corrompue ne doit pas ecraser l'autre,
  // valide.
  if (isNaN(d.getTime())) d = debutAnnee;
  if (isNaN(f.getTime())) f = finAnnee;
  const debut = d > debutAnnee ? d : debutAnnee;
  const fin = f < finAnnee ? f : finAnnee;
  return { debut, fin, joursAnnee: _daysBetween(debutAnnee, finAnnee) };
}

// Prorata temporel d'un poste : reproduction exacte de _prorataPoste (server.js).
//   prorata_temporel === false -> poste ponctuel (prestation facturee a des dates discretes) :
//   montant plein, aucun prorata calendaire.
function _prorataPoste(poste, annee) {
  if (poste.prorata_temporel === false) return 1;
  if (!poste.date_debut && !poste.date_fin) return 1;
  if (!annee) return 1;
  const { debut, fin, joursAnnee } = _fenetreAnnee(poste, annee);
  if (fin <= debut) return 0;
  return _daysBetween(debut, fin) / joursAnnee;
}

// Montant retenu d'un poste sur son annee : reproduction exacte de montantPosteRetenu (server.js).
// quote_part null/absente = 100 % (defaut de la colonne, migration 38).
function _montantRetenu(poste, annee) {
  const quote = (poste.quote_part != null ? Number(poste.quote_part) : 100) / 100;
  return (Number(poste.montant) || 0) * quote * _prorataPoste(poste, annee);
}

// Borne du reel : derniere date CLOSE (incluse) -> Date exclusive du lendemain, pour comparer avec
// les fenetres [debut, fin[. Accepte 'YYYY-MM-DD' (ou un ISO complet, tronque au jour). null/invalide
// -> null (aucun mois clos : rien n'est encore factuel).
function _borneReelle(realEndIso) {
  if (!realEndIso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(realEndIso));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1); // lendemain minuit local (exclu)
}

// Fraction ECOULEE du retenu d'un poste a la borne du reel, dans [0, 1].
function _fractionEcoulee(poste, annee, borne) {
  if (!borne) return 0;
  if (poste.prorata_temporel === false) {
    // Ponctuel : tout ou rien. Sans date de debut, la depense est consideree deja engagee (c'est
    // aussi ce que fait le projete, qui la compte en plein sur l'annee).
    if (!poste.date_debut) return 1;
    const d = new Date(poste.date_debut);
    if (isNaN(d.getTime())) return 1;
    return d < borne ? 1 : 0;
  }
  const { debut, fin } = _fenetreAnnee(poste, annee);
  if (fin <= debut) return 0;
  const coupe = fin < borne ? fin : borne;
  if (coupe <= debut) return 0;
  return _daysBetween(debut, coupe) / _daysBetween(debut, fin);
}

function _nomImmo(immo) {
  const n = (immo.libelle || immo.nom || immo.titre || '').toString().trim();
  return n || 'Immobilisation sans libelle';
}

/**
 * Production immobilisee d'un exercice.
 *
 * @param {Array} immos - lignes de la table `immobilisations` (toutes ; seules celles dont
 *   `traitement === 'immobilise'` produisent un montant : une immo passee en charge n'a rien a
 *   neutraliser, sa depense reste une charge pleine sans dotation en face).
 * @param {Object} postesByImmo - postes groupes par `immobilisation_id` (cf fetchPostesByImmo).
 * @param {number} year - exercice demande.
 * @param {string|null} realEndIso - derniere date close incluse ('YYYY-MM-DD', fin du dernier mois
 *   clos, MEME borne que le reel des charges/subventions). null = aucun mois clos -> factuel 0.
 * @returns {{projete:number, factuel:number, parImmo:Array<{nom:string,projete:number,factuel:number}>}}
 *   Arrondis a l'euro PAR IMMO, les totaux etant la somme de ces arrondis : l'invariant
 *   "total = somme des lignes" affiche par le compte de resultat est ainsi exact a l'euro.
 */
function computeProductionImmobilisee(immos, postesByImmo, year, realEndIso) {
  const y = Number(year);
  // Defense en profondeur du module PUR : si la borne du reel ne depasse pas le 1er janvier de l'annee
  // demandee, AUCUN jour de cet exercice n'est clos, donc rien n'est factuel -- y compris pour un poste
  // ponctuel dont la date de debut, elle, serait deja passee (cas d'un exercice futur dont les
  // prestations sont deja commandees : la charge appartient a l'exercice suivant, pas au reel de
  // celui-ci). Ce cas n'est PAS atteignable via l'appelant reel /api/ebe : une annee future y a deja
  // `real = null` (cf computeChargesHybride/hasReal), donc realEndIso = null et factuel = 0 avant meme
  // d'arriver ici. La garde protege un appel direct du module (tests, ou futur appelant qui fournirait
  // malgre tout une borne reelle pour un exercice futur).
  const borneBrute = _borneReelle(realEndIso);
  const borne = (borneBrute && borneBrute > new Date(y, 0, 1)) ? borneBrute : null;
  const parImmo = [];
  let projete = 0, factuel = 0;

  for (const immo of (immos || [])) {
    if (!immo || immo.traitement !== 'immobilise') continue;
    const postes = (postesByImmo && postesByImmo[immo.id]) || [];
    let p = 0, f = 0;
    for (const poste of postes) {
      const annee = _anneePoste(poste, immo);
      if (!annee || annee !== y) continue;
      const retenu = _montantRetenu(poste, annee);
      p += retenu;
      f += retenu * _fractionEcoulee(poste, annee, borne);
    }
    const pr = Math.round(p), fa = Math.round(f);
    if (pr === 0 && fa === 0) continue; // immo sans poste sur l'exercice : pas de ligne de detail
    parImmo.push({ nom: _nomImmo(immo), projete: pr, factuel: fa });
    projete += pr;
    factuel += fa;
  }

  // Ordre d'affichage stable et lisible : la plus grosse immo en premier, egalites tranchees par nom.
  parImmo.sort((a, b) => (b.projete - a.projete) || a.nom.localeCompare(b.nom));
  return { projete, factuel, parImmo };
}

module.exports = { computeProductionImmobilisee };
