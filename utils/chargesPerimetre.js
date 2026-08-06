'use strict';

// Helpers purs de perimetre pour le calcul des charges du compte de resultat :
// normalisation des libelles, exclusions PCG (plan comptable general) hors exploitation,
// et fin de mois reelle (remplace la borne fixe au 28 utilisee jusqu'ici pour le bucketing).
//
// Module pur, sans effet de bord (hormis la lecture de process.env.PRIMES_QONTO_SUBCATS
// au chargement, voir plus bas). Consomme par server.js (Taches 2-6).

// Normalise un libelle : minuscules, accents retires, espaces compactes. '' si null/undefined.
// La regex cible U+0300 a U+036F, la plage Unicode des diacritiques combinants (accents, cedilles...)
// qui apparaissent une fois la chaine decomposee par normalize('NFD') (ex: 'é' -> 'e' + U+0301).
// Forme explicite volontaire (echappement \u, plutot que les caracteres litteraux) : plus sure
// vis-a-vis de l'encodage du fichier source (evite tout risque d'alteration silencieuse par un
// editeur/outil qui ne preserverait pas des caracteres combinants invisibles a l'identique).
function normalizeLabel(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Fabrique de la liste des sous-categories Qonto des virements de primes d'associes, a partir
// d'une chaine brute separee par des virgules (ex: valeur de process.env.PRIMES_QONTO_SUBCATS).
// Exportee separement de PRIMES_SUBCATS pour rester testable sans manipuler process.env : les
// tests appellent buildPrimesSubcats(raw) directement avec differentes valeurs. Le module.exports
// calcule aussi PRIMES_SUBCATS une seule fois au chargement (comportement reel en prod), et
// isPrimeSubcategory accepte une liste optionnelle en second parametre pour les tests cibles.
function buildPrimesSubcats(raw) {
  return String(raw || 'Primes associées,Primes commerciales')
    .split(',').map(normalizeLabel).filter(Boolean);
}

// Sous-categories Qonto des virements de primes d'associes (liste normalisee, surchargee par env
// PRIMES_QONTO_SUBCATS, valeurs separees par des virgules). Comparaison insensible accents/casse.
const PRIMES_SUBCATS = buildPrimesSubcats(process.env.PRIMES_QONTO_SUBCATS);

// list : liste optionnelle pour surcharger PRIMES_SUBCATS dans les tests (defaut : liste du module).
function isPrimeSubcategory(sousCat, list = PRIMES_SUBCATS) {
  return list.includes(normalizeLabel(sousCat));
}

// Sous-categories hors exploitation (PCG) : TVA reversee = compte de tiers, jamais une charge ;
// IS = charge hors exploitation, deja recalculee par computeIS (double compte sinon).
// Le prelevement a la source RESTE en charges : on n'exclut jamais la categorie entiere.
const HORS_EXPLOITATION = ['paiements de la tva', 'impot sur les societes'].map(normalizeLabel);
function isHorsExploitation(cat, sousCat) { return HORS_EXPLOITATION.includes(normalizeLabel(sousCat)); }

// Fin de mois REELLE d'une cle 'YYYY-MM', en heure locale (meme referentiel que le bucketing
// des transactions) : new Date(y, m, 0) = dernier jour du mois m. Remplace la borne fixe au 28.
function monthEndDate(ymKey) {
  const [y, m] = String(ymKey).split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59, 999);
}

module.exports = {
  normalizeLabel,
  isPrimeSubcategory,
  isHorsExploitation,
  monthEndDate,
  PRIMES_SUBCATS,
  HORS_EXPLOITATION,
  buildPrimesSubcats,
};
