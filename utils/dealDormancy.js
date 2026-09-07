'use strict';

// Dormance d'un deal (« en sommeil »).
//
// MIROIR EXACT de la logique côté client (public/pilot.html : computeDealCriticality + isDealDormant).
// Objectif : le pipeline pondéré calculé côté serveur (Cockpit, Trésorerie, projections) exclut les
// mêmes deals que la carte « Commercial », qui est la seule formule de référence. Toute modification
// ici doit être répercutée dans public/pilot.html (et inversement), sinon les cartes divergeront.
//
// Un deal est « en sommeil » quand son dernier TRAITEMENT remonte à au moins DORMANT_DAYS jours, SAUF si :
//   - un RDV est planifié dans le futur, ou
//   - une tâche non terminée a une échéance future, ou
//   - le deal a été créé il y a moins de DORMANT_GRACE_DAYS jours (délai de grâce).
// Dernier traitement = max(dernière relance, dernière note, reveille_at) ; à défaut, la date de création.
//
// reveille_at (migration 45) : sortir un deal du bac « À relancer » à la main est un ARBITRAGE, pas un
// contact client. Ce n'est donc pas une relance, mais ça remet bien le compteur de sommeil à zéro : sans
// ça, la carte retombe en sommeil au premier recalcul et le geste de l'utilisateur reste sans effet.
// Oublier ce champ ici sort du pipeline pondéré un deal que la carte « Commercial » y compte.

const DORMANT_DAYS = 90;        // seuil de sommeil (jours). Identique au client.
const DORMANT_GRACE_DAYS = 7;   // délai de grâce après création. Identique au client (CRITICAL_GRACE_DAYS).
const DAY_MS = 24 * 3600 * 1000;

// deal : { createdate }  ·  meta : { next_meeting_at, tasks, relances, notes, reveille_at } (peut être null/undefined)
// now  : timestamp de référence (injectable pour les tests ; Date.now() par défaut).
function isDealDormant(deal, meta, now = Date.now()) {
  meta = meta || {};

  // RDV futur planifié -> jamais en sommeil.
  const nextMeeting = meta.next_meeting_at ? new Date(meta.next_meeting_at).getTime() : 0;
  if (nextMeeting > now) return false;

  // Tâche à faire avec échéance future -> jamais en sommeil.
  const tasks = Array.isArray(meta.tasks) ? meta.tasks : [];
  if (tasks.some(t => t && t.status !== 'done' && t.due_at && new Date(t.due_at).getTime() > now)) return false;

  // Deal créé récemment (délai de grâce) -> pas encore jugé sur son inactivité.
  const created = (deal && deal.createdate) ? new Date(deal.createdate).getTime() : 0;
  if (created > 0 && (now - created) < DORMANT_GRACE_DAYS * DAY_MS) return false;

  // Dernier traitement = max(dernière relance, dernière note, réveil manuel) ; sinon date de création.
  const relances = Array.isArray(meta.relances) ? meta.relances : [];
  const notes = Array.isArray(meta.notes) ? meta.notes : [];
  const reveil = meta.reveille_at ? new Date(meta.reveille_at).getTime() : 0;
  const touchDates = [
    ...relances.map(r => (r && r.at) ? new Date(r.at).getTime() : 0),
    ...notes.map(n => (n && n.at) ? new Date(n.at).getTime() : 0),
    reveil,
  ].filter(t => t > 0);
  const lastTouch = touchDates.length ? Math.max(...touchDates) : null;
  const refTime = lastTouch !== null ? lastTouch : (created > 0 ? created : null);
  if (refTime === null) return false;

  return Math.floor((now - refTime) / DAY_MS) >= DORMANT_DAYS;
}

module.exports = { isDealDormant, DORMANT_DAYS, DORMANT_GRACE_DAYS };
