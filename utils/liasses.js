'use strict';

// Liasses fiscales des exercices CLOS (spec docs/superpowers/specs/2026-08-15-liasse-exercice-clos-design.md).
//
// Quand un exercice est clos et sa liasse deposee, le compte de resultat de Pilot affiche les chiffres
// OFFICIELS la ou ils font foi (zone fiscale) et PROUVE sa fiabilite la ou il garde sa methode (zone de
// pilotage, comparable a methode constante entre exercices). Une liasse ne modifie JAMAIS un calcul :
// c'est un affichage et une reconciliation.
//
// Module PUR au sens du projet : il lit des fichiers JSON versionnes (data/liasses/NNNN.json, saisis a
// la main une fois par an depuis la liasse du cabinet), sans reseau ni base. Il ne CORRIGE jamais un
// chiffre : une liasse incoherente est servie telle quelle, avec ses anomalies exposees. Le silence
// serait le pire des comportements ici : ces chiffres sont ceux qui font foi.

const fs = require('fs');
const path = require('path');

// Tolerance des controles de coherence, en euros. La liasse elle-meme arrondit chaque rubrique a
// l'euro : 420 733 − 346 794 = 73 939 alors que la liasse 2025 declare 73 940 de resultat
// d'exploitation. 2 € absorbent ces arrondis sans laisser passer une faute de saisie.
const TOLERANCE_EUROS = 2;

// Champs qui doivent etre presents ET numeriques : ceux qui sont affiches (zone fiscale ancree) ou
// compares (modale de reconciliation). Les rubriques purement informatives (dontDotationsAmortissements,
// dontAutresCharges, resultatFiscal, autresProduits) ne sont pas requises : leur absence ne casse
// aucun ecran.
const CHAMPS_REQUIS = [
  'productionVendue',
  'subventionsExploitation',
  'totalProduitsExploitation',
  'chargesExploitation',
  'productionImmobilisee',
  'resultatExploitation',
  'impotSurBenefices',
  'cir',
  'resultatNet',
];

// Un fichier de liasse porte l'annee de l'exercice dans son nom : 2025.json. Tout le reste du dossier
// (README de saisie, brouillons, sous-dossiers) est ignore sans bruit.
const NOM_FICHIER = /^(\d{4})\.json$/;

// Lit tous les exercices clos d'un dossier. TOLERANT par construction : le compte de resultat doit
// s'afficher meme si le dossier n'existe pas (deploiement sans liasse) ou si un fichier a ete casse
// pendant sa saisie. Retourne { [exercice]: liasse } ; jamais d'exception, jamais d'entree partielle.
function chargerLiasses(dossier) {
  const liasses = {};
  if (!dossier) return liasses;
  let fichiers;
  try {
    fichiers = fs.readdirSync(dossier);
  } catch (e) {
    // Dossier absent : cas NORMAL (aucun exercice clos saisi), pas une anomalie a signaler.
    return liasses;
  }
  for (const nom of fichiers) {
    const m = NOM_FICHIER.exec(nom);
    if (!m) continue;
    const anneeFichier = Number(m[1]);
    let brut;
    try {
      brut = fs.readFileSync(path.join(dossier, nom), 'utf8');
    } catch (e) {
      console.warn('[liasse] fichier illisible, ignore : %s (%s)', nom, e.message);
      continue;
    }
    let contenu;
    try {
      contenu = JSON.parse(brut);
    } catch (e) {
      console.warn('[liasse] JSON invalide, fichier ignore : %s (%s)', nom, e.message);
      continue;
    }
    if (!contenu || typeof contenu !== 'object' || Array.isArray(contenu)) {
      console.warn('[liasse] contenu inattendu (objet attendu), fichier ignore : %s', nom);
      continue;
    }
    // Cle = l'exercice declare dans le fichier, avec repli sur l'annee du nom. Un desaccord entre les
    // deux est signale : c'est typiquement un copier-coller de l'annee precedente, donc des chiffres
    // qui seraient affiches sous la mauvaise annee.
    const exerciceDeclare = Number(contenu.exercice);
    let exercice = anneeFichier;
    if (Number.isFinite(exerciceDeclare) && exerciceDeclare > 0) {
      if (exerciceDeclare !== anneeFichier) {
        console.warn('[liasse] exercice declare (%d) different du nom de fichier (%s) : cle %d retenue',
          exerciceDeclare, nom, exerciceDeclare);
      }
      exercice = exerciceDeclare;
    }
    liasses[exercice] = contenu;
  }
  return liasses;
}

// Gardes d'integrite de la SAISIE (pas de la comptabilite du cabinet : ses chiffres font foi). Retourne
// un tableau d'anomalies, vide quand tout va bien. Chaque anomalie porte un `code` (stable, pour les
// tests et un futur filtrage) et un `message` francais directement affichable.
function verifierLiasse(liasse) {
  if (!liasse || typeof liasse !== 'object') {
    return [{ code: 'liasseIllisible', message: 'Liasse absente ou illisible.' }];
  }
  const c = liasse.chiffres;
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    return [{ code: 'chiffresManquants', message: 'Bloc « chiffres » absent de la liasse saisie.' }];
  }

  const anomalies = [];
  const estNombre = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const champ of CHAMPS_REQUIS) {
    if (!estNombre(c[champ])) {
      anomalies.push({
        code: 'champManquant',
        champ,
        message: 'Champ « ' + champ + ' » manquant ou non numerique dans la liasse saisie.',
      });
    }
  }

  // Controles de coherence : evalues seulement si leurs deux operandes sont exploitables, sinon on
  // signalerait deux fois la meme faute de saisie (champ manquant + incoherence induite).
  const ecart = (a, b) => Math.round((a - b) * 100) / 100;
  if (estNombre(c.totalProduitsExploitation) && estNombre(c.chargesExploitation) && estNombre(c.resultatExploitation)) {
    const attendu = c.totalProduitsExploitation - c.chargesExploitation;
    const delta = ecart(c.resultatExploitation, attendu);
    if (Math.abs(delta) > TOLERANCE_EUROS) {
      anomalies.push({
        code: 'coherenceResultatExploitation',
        ecart: delta,
        message: 'Produits d\'exploitation moins charges d\'exploitation donne ' + attendu
          + ' € alors que la liasse declare un resultat d\'exploitation de ' + c.resultatExploitation
          + ' € (ecart de ' + delta + ' €) : verifier la saisie.',
      });
    }
  }
  if (estNombre(c.resultatExploitation) && estNombre(c.impotSurBenefices) && estNombre(c.resultatNet)) {
    const attendu = c.resultatExploitation - c.impotSurBenefices;
    const delta = ecart(c.resultatNet, attendu);
    if (Math.abs(delta) > TOLERANCE_EUROS) {
      anomalies.push({
        code: 'coherenceResultatNet',
        ecart: delta,
        message: 'Resultat d\'exploitation moins impot sur les benefices donne ' + attendu
          + ' € alors que la liasse declare un resultat net de ' + c.resultatNet
          + ' € (ecart de ' + delta + ' €) : verifier la saisie.',
      });
    }
  }
  return anomalies;
}

module.exports = { chargerLiasses, verifierLiasse, CHAMPS_REQUIS, TOLERANCE_EUROS };
