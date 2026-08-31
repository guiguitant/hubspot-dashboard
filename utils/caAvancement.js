'use strict';

// CA a l'avancement (FAE/PCA) : voir docs/superpowers/specs/2026-08-31-ca-avancement-design.md
//
// Principe comptable : pour une prestation a cheval sur deux exercices, le CA d'un exercice ne
// depend pas des dates de facturation mais du pourcentage d'avancement au 31/12. L'ecart entre le
// facture et l'avancement est une facture a etablir (FAE, realise non facture) ou un produit
// constate d'avance (PCA, facture non realise).
//
// Module PUR : aucune I/O, aucune dependance. Toute la lecture Supabase est dans server.js.

// Premier exercice ou l'avancement s'applique. Les exercices anterieurs sont figes par la liasse
// fiscale (doctrine "exercice clos" du lot liasse) : on ne rejoue jamais leur CA.
const PREMIER_EXERCICE_AVANCEMENT = 2026;

// Tolerance de l'invariant vie-entiere, en euros (arrondis a l'euro sur chaque exercice).
const TOLERANCE_INVARIANT = 1;

// Avancement (%) d'une mission au 31/12/exercice, avec REPORT EN AVANT : on prend la ligne de
// l'exercice le plus recent <= exercice. 0 si aucune. Le report est ce qui fait qu'une mission
// terminee a 100 % en 2025 et facturee en 2026 apporte 0 de CA 2026 sans aucune saisie 2026.
function pctFin(lignesMission, exercice) {
  let meilleur = null;
  for (const l of lignesMission || []) {
    const ex = Number(l.exercice);
    if (!Number.isFinite(ex) || ex > exercice) continue;
    if (meilleur === null || ex > Number(meilleur.exercice)) meilleur = l;
  }
  return meilleur ? (Number(meilleur.pct) || 0) : 0;
}

// CA a l'avancement d'une mission pour un exercice : ca x (avancement fin N - avancement fin N-1).
// Peut etre negatif si l'avancement a ete revu a la baisse : c'est une correction volontaire.
function caAvancementMission(mission, lignesMission, exercice) {
  const ca = Number(mission && mission.ca) || 0;
  const delta = pctFin(lignesMission, exercice) - pctFin(lignesMission, exercice - 1);
  return Math.round((ca * delta) / 100);
}

// Regroupe les lignes plates (telles que stockees) par mission_id.
function grouperParMission(lignes) {
  const parMission = new Map();
  for (const l of lignes || []) {
    const id = l && l.mission_id != null ? String(l.mission_id) : null;
    if (!id) continue;
    if (!parMission.has(id)) parMission.set(id, []);
    parMission.get(id).push(l);
  }
  return parMission;
}

// Etats exclus du CA : aligne sur SIGNE_EXCLUDED_STATES de utils/kpiCompute.js. Une mission annulee
// n'est jamais remplacee, meme si elle porte des lignes d'avancement (saisie devenue caduque).
const ETATS_EXCLUS = ['Annulé'];

// Calcule le remplacement a appliquer pour un exercice.
// Retourne { actif, parMission: Map<missionId, caAvancement>, suivies: [detail lisible] }.
// actif = false (et parMission vide) si les lignes sont absentes (table Supabase non creee :
// degradation douce) ou si l'exercice est anterieur a PREMIER_EXERCICE_AVANCEMENT.
function computeAvancement(missions, lignes, exercice) {
  const vide = { actif: false, parMission: new Map(), suivies: [] };
  if (!lignes || !lignes.length) return vide;
  if (!Number.isFinite(Number(exercice)) || Number(exercice) < PREMIER_EXERCICE_AVANCEMENT) return vide;

  const ex = Number(exercice);
  const lignesParMission = grouperParMission(lignes);
  const parMission = new Map();
  const suivies = [];

  for (const m of missions || []) {
    const id = m && m.id != null ? String(m.id) : null;
    if (!id || !lignesParMission.has(id)) continue;      // mission non suivie : comportement inchange
    if (ETATS_EXCLUS.includes(m.etat)) continue;          // annulee : hors CA de bout en bout
    const lignesMission = lignesParMission.get(id);
    const montant = caAvancementMission(m, lignesMission, ex);
    parMission.set(id, montant);
    suivies.push({
      missionId: id,
      nom: m.nom || '',
      ca: Number(m.ca) || 0,
      pctPrecedent: pctFin(lignesMission, ex - 1),
      pctCourant: pctFin(lignesMission, ex),
      caAvancement: montant,
    });
  }

  return { actif: suivies.length > 0, parMission, suivies };
}

// Applique le remplacement a un total deja calcule : on retire ce que chaque mission suivie
// apportait a CETTE base, on ajoute son CA a l'avancement. contributionsBase = Map<missionId,
// montant apporte a la base>. Chaque consommateur fournit SA base (les deux definitions existantes
// du CA ne rattachent pas pareil : un delta global unique serait faux pour l'une des deux).
function ajusterTotal(base, contributionsBase, parMission) {
  let total = Number(base) || 0;
  for (const [id, montant] of parMission || new Map()) {
    const contribution = (contributionsBase && contributionsBase.get(id)) || 0;
    total = total - contribution + montant;
  }
  return Math.round(total);
}

// Invariant vie-entiere : pour une mission arrivee a 100 %, la somme de ses CA a l'avancement sur
// tous les exercices ou elle a une ligne doit valoir son ca (telescopage). Verifie que l'avancement
// DEPLACE du CA entre exercices sans en creer ni en detruire. Missions non terminees : hors scope.
function verifierInvariantAvancement(missions, lignes) {
  const anomalies = [];
  const lignesParMission = grouperParMission(lignes);
  for (const m of missions || []) {
    const id = m && m.id != null ? String(m.id) : null;
    if (!id || !lignesParMission.has(id)) continue;
    if (ETATS_EXCLUS.includes(m.etat)) continue;
    const lignesMission = lignesParMission.get(id);
    const exercices = lignesMission.map(l => Number(l.exercice)).filter(Number.isFinite);
    if (!exercices.length) continue;
    const dernier = Math.max(...exercices);
    if (pctFin(lignesMission, dernier) !== 100) continue; // invariant valable a 100 % seulement
    const premier = Math.min(...exercices);
    let somme = 0;
    for (let ex = premier; ex <= dernier; ex++) somme += caAvancementMission(m, lignesMission, ex);
    const attendu = Number(m.ca) || 0;
    const ecart = somme - attendu;
    if (Math.abs(ecart) > TOLERANCE_INVARIANT) {
      anomalies.push({ missionId: id, nom: m.nom || '', attendu, obtenu: somme, ecart });
    }
  }
  return anomalies;
}

// Exercice le plus ancien saisissable : 2025 est l'ANCRE (avancement au 31/12/2025 des missions du
// fichier de cut-off transmis a l'expert-comptable), meme si aucun CA 2025 n'est jamais ajuste.
const EXERCICE_ANCRE = 2025;

// Validation d'une saisie, hors HTTP pour rester testable. L'annee courante est fournie par
// l'appelant (parametre anneeCourante) : le module ne lit jamais l'horloge.
function validerSaisieAvancement(saisie, anneeCourante) {
  const s = saisie || {};
  const id = s.missionId != null ? String(s.missionId).trim() : '';
  if (!id) return { ok: false, message: 'missionId requis' };
  const ex = Number(s.exercice);
  if (!Number.isInteger(ex) || ex < EXERCICE_ANCRE || ex > Number(anneeCourante) + 1) {
    return { ok: false, message: `exercice hors bornes (${EXERCICE_ANCRE} a ${Number(anneeCourante) + 1})` };
  }
  const pct = Number(s.pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, message: 'pct doit etre compris entre 0 et 100' };
  return { ok: true };
}

// Un exercice est fige des qu'AU MOINS UNE de ses lignes porte un fige_le non nul (some, pas
// every) : un exercice clos doit se lire comme clos meme si une ligne parasite non figee existe
// pour ce meme exercice. Le garde d'ecriture de POST/DELETE /api/avancement s'appuie desormais sur
// cette meme fonction avant toute recherche de ligne : une fois l'exercice figé via some(), plus
// aucune nouvelle ligne non figee ne peut y apparaitre, donc le cas "parasite" ne peut plus se
// creer a partir d'ici ; some() protege le passe (donnees deja en base) plutot que le futur seul.
function exerciceFige(lignes, exercice) {
  return (lignes || []).some(l => l && Number(l.exercice) === Number(exercice) && !!l.fige_le);
}

// Ce qu'une mission suivie apporte a la base "factures emises datees dans l'annee" (celle du CR).
// Sert a retirer exactement sa contribution avant d'ajouter son CA a l'avancement. On compare des
// annees sur la chaine de date (slice) et non des objets Date, pour rester insensible au fuseau.
function contributionsDepuisVolets(missions, missionIds, exercice) {
  const contributions = new Map();
  const ex = Number(exercice);
  const anneeDe = (d) => (d ? Number(String(d).slice(0, 4)) : null);
  for (const m of missions || []) {
    const id = m && m.id != null ? String(m.id) : null;
    if (!id || !missionIds || !missionIds.has(id)) continue;
    const ca = Number(m.ca) || 0;
    const acompte = Number(m.montantAcompte) || 0;
    const solde = Math.max(0, ca - acompte);
    let total = 0;
    if (acompte > 0 && anneeDe(m.dateFactureAcompte) === ex) total += acompte;
    if (solde > 0 && anneeDe(m.dateFactureFinale) === ex) total += solde;
    contributions.set(id, Math.round(total));
  }
  return contributions;
}

module.exports = {
  PREMIER_EXERCICE_AVANCEMENT,
  TOLERANCE_INVARIANT,
  EXERCICE_ANCRE,
  pctFin,
  caAvancementMission,
  computeAvancement,
  ajusterTotal,
  verifierInvariantAvancement,
  validerSaisieAvancement,
  exerciceFige,
  contributionsDepuisVolets,
};
