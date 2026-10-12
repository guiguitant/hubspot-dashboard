'use strict';
// Pont Canopy ↔ Pilot (routes /api/releaf-deals). Fonctions pures, testées.
// Contexte : spec « brique 3 » de Canopy (docs/specs/brique-3-lien-deals-pilot.md
// dans le dépôt canopy). Canopy relie ses leads aux deals par leur numéro ; il
// doit pouvoir lire tout le pipeline, savoir si un deal existe encore, et créer
// sans jamais produire de doublon quand il réessaie.

// Valeurs acceptées par deal_metadata.assignee (même liste que l'écran Pilot).
const ASSIGNEES = ['Guillaume', 'Vincent', 'Nathan'];

// Une clé externe identifie UNE création voulue par Canopy (sa réservation).
const CLE_EXTERNE_MAX = 200;

// Forme minimale d'une adresse : une partie locale, un @, un domaine avec un
// point. Volontairement simple : on refuse les fautes de frappe évidentes
// (« jean.perin », « jean@perin »), pas les adresses exotiques mais valides.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

/**
 * Email du contact d'un deal, normalisé (espaces retirés, minuscules), ou null
 * s'il est absent ou mal formé. Spec Canopy « Consolider », étape 9 : plus
 * aucun deal sans contact, l'email est gardé par Pilot dans
 * deal_metadata.contact_email (HubSpot n'est qu'une copie, souvent refusée).
 */
function normEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > EMAIL_MAX || !EMAIL_RE.test(e)) return null;
  return e;
}

/** En prod, `tags` est parfois une chaîne JSON plutôt qu'un TEXT[]. */
function normTags(raw) {
  let t = raw;
  if (typeof t === 'string') {
    try { t = JSON.parse(t); } catch { t = [t]; }
  }
  return Array.isArray(t) ? t : (t ? [t] : []);
}

/** « Prospection » et « prospection » sont le même tag. */
function hasTag(tags, tag) {
  const cible = String(tag).toLowerCase();
  return normTags(tags).some((x) => String(x).toLowerCase() === cible);
}

/**
 * Statut de chaque id demandé, à partir de deux lectures HubSpot batch/read :
 * les deals actifs, puis la corbeille (`archived=true`) pour les ids restants.
 *  - existe    : le deal est là, sous cet id ;
 *  - fusionne  : l'id a été absorbé par une fusion, `dealId` est le deal conservé
 *                (HubSpot liste les ids absorbés dans `hs_merged_object_ids`) ;
 *  - corbeille : supprimé, encore restaurable dans HubSpot ;
 *  - inconnu   : supprimé définitivement, ou jamais existé.
 */
function statutsDeals(ids, actifs, corbeille) {
  const parId = new Map();
  const parFusion = new Map();
  for (const d of actifs || []) {
    parId.set(String(d.id), d);
    const fusionnes = String(d.properties?.hs_merged_object_ids || '').split(';').filter(Boolean);
    for (const m of fusionnes) parFusion.set(m, d);
  }
  const enCorbeille = new Set((corbeille || []).map((d) => String(d.id)));
  return ids.map((brut) => {
    const id = String(brut);
    if (parId.has(id)) return { id, statut: 'existe', dealId: id };
    if (parFusion.has(id)) return { id, statut: 'fusionne', dealId: String(parFusion.get(id).id) };
    if (enCorbeille.has(id)) return { id, statut: 'corbeille', dealId: null };
    return { id, statut: 'inconnu', dealId: null };
  });
}

/** Contrôle d'une demande de création. Rend { erreur } ou la demande normalisée. */
function validerCreation(body, stageIdMap) {
  const { name, stage, contactEmail, contactName, company, tags, assignee, cle_externe } = body || {};
  if (!name || !stage) return { erreur: 'name et stage requis' };
  const stageId = stageIdMap[stage];
  if (!stageId) return { erreur: `stage inconnu: ${stage}` };
  const email = normEmail(contactEmail);
  if (!email) return { erreur: contactEmail ? `contactEmail invalide: ${contactEmail}` : 'contactEmail requis' };
  if (tags !== undefined && !Array.isArray(tags)) return { erreur: 'tags doit être un tableau' };
  if (assignee != null && assignee !== '' && !ASSIGNEES.includes(assignee)) {
    return { erreur: `assignee invalide: ${assignee}` };
  }
  let cleExterne = null;
  if (cle_externe != null && cle_externe !== '') {
    cleExterne = String(cle_externe).trim();
    if (!cleExterne || cleExterne.length > CLE_EXTERNE_MAX) return { erreur: 'cle_externe invalide' };
  }
  return {
    name: String(name).trim(),
    stageId,
    contactEmail: email,
    contactName: contactName || null,
    company: company || null,
    tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()) : [],
    assignee: assignee || null,
    cleExterne,
  };
}

/**
 * Une erreur de `hubspotWrite` qui porte un code HTTP prouve que HubSpot a
 * répondu (donc refusé) : rien n'a été créé, la réservation peut être libérée.
 * Une coupure réseau ne prouve rien (le deal a pu être créé) : la réservation
 * reste « en cours » et bloque tout nouvel essai jusqu'à vérification humaine.
 */
function echecCertainHubspot(err) {
  return /^HubSpot [A-Z]+ \d{3}:/.test(String(err?.message || ''));
}

/** Vue d'un deal, commune à la liste par tag et au pipeline complet. */
function vueDeal(dealId, p, meta, stageLabel, stageProb) {
  const relances = Array.isArray(meta?.relances) ? meta.relances : [];
  const tasks = Array.isArray(meta?.tasks) ? meta.tasks : [];
  const lastRelance = relances.length ? relances[relances.length - 1] : null;
  return {
    dealId: String(dealId),
    name: p.dealname || '',
    stageId: p.dealstage || null,
    stage: stageLabel[p.dealstage] || p.dealstage || '',
    probability: stageProb[p.dealstage] ?? null,
    amount: p.amount ? parseFloat(p.amount) : null,
    isClosed: p.hs_is_closed === 'true',
    isWon: p.hs_is_closed_won === 'true',
    createdAt: p.createdate || null,
    closeDate: p.closedate || null,
    updatedAt: p.hs_lastmodifieddate || null,
    mergedIds: String(p.hs_merged_object_ids || '').split(';').filter(Boolean),
    lastRelanceAt: lastRelance?.at || null,
    relanceCount: relances.length,
    nextMeetingAt: meta?.next_meeting_at || null,
    openTasks: tasks.filter((t) => t.status !== 'done').length,
    tags: normTags(meta?.tags),
    assignee: meta?.assignee || null,
    contactEmail: meta?.contact_email || null,
  };
}

/**
 * Contrôle d'une écriture du contact sur un deal existant
 * (POST /api/releaf-deals/deals/:id/contact). `remplacer` doit être explicite
 * pour écraser un email différent déjà posé : sans lui, la route rend 409 avec
 * l'email en place, et c'est à un humain de trancher.
 */
function validerContact(body) {
  const { contactEmail, contactName, company, remplacer } = body || {};
  const email = normEmail(contactEmail);
  if (!email) return { erreur: contactEmail ? `contactEmail invalide: ${contactEmail}` : 'contactEmail requis' };
  return {
    contactEmail: email,
    contactName: contactName || null,
    company: company || null,
    remplacer: remplacer === true,
  };
}

/**
 * Rejoue `fn` quand HubSpot répond 429 (limite de requêtes par seconde du
 * compte, partagée avec les écrans de Pilot). Constaté le 09/10 : la lecture du
 * pipeline par Canopy (4 recherches à la suite) tombait sur « secondly limit ».
 * Toute autre erreur repart telle quelle.
 */
async function avecReprise429(fn, { essais = 3, attenteMs = 1100, attendre } = {}) {
  const pause = attendre || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= essais || !/^HubSpot [A-Za-z ]*429:/.test(String(e?.message || ''))) throw e;
      await pause(attenteMs * i);
    }
  }
}

module.exports = {
  ASSIGNEES,
  avecReprise429,
  normEmail,
  normTags,
  hasTag,
  statutsDeals,
  validerCreation,
  validerContact,
  echecCertainHubspot,
  vueDeal,
};
