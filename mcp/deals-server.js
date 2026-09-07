#!/usr/bin/env node
/**
 * Serveur MCP "deals" — expose la donnée commerciale HubSpot à Claude Desktop.
 *
 * Autonome : ne dépend QUE de HUBSPOT_API_KEY (lue dans le .env du projet).
 * Ne touche pas server.js. Les helpers HubSpot ci-dessous reproduisent
 * volontairement la logique de server.js:283-356 (auth EU/PAT) pour rester
 * indépendant du backend — il fonctionne que le dashboard tourne ou non.
 *
 * Transport : stdio (à brancher dans claude_desktop_config.json).
 */

const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');
// Dormance des deals : RÈGLE UNIQUE, partagée avec server.js et miroir de la carte « Commercial »
// de Pilot. Ne jamais la réécrire ici : elle doit rester définie à un seul endroit.
const { isDealDormant } = require('../utils/dealDormancy');
// Version de CE serveur et comparaison de versions. Voir utils/mcpVersion.js :
// c'est là qu'on incrémente le numéro à chaque modification.
const { MCP_SERVER_VERSION, compareVersions } = require('../utils/mcpVersion');

// Aucun appel HubSpot ne doit pouvoir bloquer indéfiniment : sans ce délai, une socket qui
// reste ouverte sans jamais répondre fige l'outil MCP pour toujours (l'appelant n'a aucun moyen
// de savoir que rien n'arrivera). 30 s, puis erreur explicite.
const HTTP_TIMEOUT_MS = 30 * 1000;

// --- Config HubSpot (miroir de server.js) ---
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
if (!HUBSPOT_API_KEY) {
  console.error('[mcp-deals] HUBSPOT_API_KEY manquante dans .env');
  process.exit(1);
}

// --- Supabase : source des tags deals (table deal_metadata, cf server.js:687) ---
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const IS_EU = HUBSPOT_API_KEY.includes('eu1');
const HUBSPOT_HOST = IS_EU ? 'api-eu1.hubapi.com' : 'api.hubapi.com';
const IS_PAT = HUBSPOT_API_KEY.startsWith('pat-');

// Stages du pipeline "default" suivis dans le kanban (miroir de server.js:507).
// `forecast: false` -> stage hors projection : c'est le bac où Pilot range les deals « gelés ».
//
// Les PROBABILITÉS NE SONT PAS ICI, volontairement. Elles vivent dans les réglages de Pilot
// (table kpi_prime_config, ligne 'pipeline_ponderation'), écrits par l'écran de pondération de
// l'interface, et sont lues à chaud par loadStageProbabilities(). Un pourcentage réécrit ici
// recréerait un forecast silencieusement faux dès que quelqu'un change le barème dans Pilot.
const KANBAN_STAGES = [
  { id: 'qualifiedtobuy', label: 'RDV Qualif' },
  { id: 'presentationscheduled', label: 'RDV Propale' },
  { id: 'decisionmakerboughtin', label: 'Négociation' },
  { id: 'contractsent', label: 'Contrat envoyé' },
  { id: '2077692138', label: 'À relancer plus tard', forecast: false },
];

// Label de stage -> id HubSpot (miroir de server.js:572). Inclut les clôtures.
const STAGE_ID_MAP = {
  'RDV Qualif': 'qualifiedtobuy',
  'RDV Propale': 'presentationscheduled',
  'Négociation': 'decisionmakerboughtin',
  'Contrat envoyé': 'contractsent',
  'À relancer plus tard': '2077692138',
  'closedwon': 'closedwon',
  'closedlost': 'closedlost',
};
const ALLOWED_ASSIGNEES = ['Guillaume', 'Vincent', 'Nathan'];
const TASK_TYPES = ['call', 'email', 'proposal', 'meeting', 'contract', 'custom'];

// --- Helpers HTTP HubSpot ---
function addAuth(options, urlPath) {
  if (IS_PAT) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${HUBSPOT_API_KEY}`;
    return urlPath;
  }
  const separator = urlPath.includes('?') ? '&' : '?';
  return urlPath + separator + 'hapikey=' + HUBSPOT_API_KEY;
}

function hubspotSearch(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let reqPath = '/crm/v3/objects/deals/search';
    const options = {
      hostname: HUBSPOT_HOST,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    reqPath = addAuth(options, reqPath);
    options.path = reqPath;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Réponse HubSpot invalide')); }
        } else {
          reject(new Error(`HubSpot Search ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('HubSpot Search : délai de 30 s dépassé')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Écriture HubSpot (miroir de server.js:358).
function hubspotWrite(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let reqPath = endpoint;
    const options = {
      hostname: HUBSPOT_HOST,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    reqPath = addAuth(options, reqPath);
    options.path = reqPath;
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        } else {
          reject(new Error(`HubSpot ${method} ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`HubSpot ${method} : délai de 30 s dépassé`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Lit une colonne de deal_metadata (null si absente).
async function readMeta(dealId, col) {
  if (!supabase) throw new Error('Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const { data, error } = await supabase.from('deal_metadata').select(col).eq('deal_id', String(dealId)).maybeSingle();
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data;
}

// Upsert dans deal_metadata (onConflict deal_id), avec updated_at automatique.
async function upsertMeta(update) {
  if (!supabase) throw new Error('Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  const { error } = await supabase
    .from('deal_metadata')
    .upsert({ ...update, updated_at: new Date().toISOString() }, { onConflict: 'deal_id' });
  if (error) throw new Error(`Supabase: ${error.message}`);
  invalidateMetaCache(); // sinon une lecture juste après l'écriture renverrait l'ancienne valeur
}

// =====================================================================
//  Barème de pondération : SOURCE UNIQUE = les réglages de Pilot
// =====================================================================
// Même ligne que celle qu'écrit l'écran de pondération de l'interface
// (server.js, POST /api/pipeline-ponderation -> kpi_prime_config / 'pipeline_ponderation').
// Cache 60 s : une lecture par appel MCP serait inutile, et une valeur figée au démarrage
// du serveur serait fausse dès que quelqu'un modifie le barème en cours de journée.
const PONDERATION_CONFIG_ID = 'pipeline_ponderation';
const PROBA_CACHE_TTL = 60 * 1000;
let probaCache = null;
let probaCacheTime = 0;

// Renvoie { ok, probabilities, reason } où probabilities est { label -> % } pour les seuls
// stages de projection. ok=false dès que le barème est injoignable OU incomplet : dans ce cas
// l'appelant DOIT renvoyer weighted_forecast: null. Jamais de repli sur des valeurs codées en
// dur : un pipe pondéré faux ne se voit pas, un pipe pondéré absent se voit.
async function loadStageProbabilities() {
  const now = Date.now();
  if (probaCache && now - probaCacheTime < PROBA_CACHE_TTL) return probaCache;
  try {
    if (!supabase) throw new Error('Supabase non configuré');
    const { data, error } = await supabase
      .from('kpi_prime_config').select('config').eq('id', PONDERATION_CONFIG_ID).maybeSingle();
    if (error) throw new Error(error.message);
    const saved = data && data.config && data.config.probabilities;
    if (!saved || typeof saved !== 'object') throw new Error('barème absent des réglages Pilot');
    const probabilities = {};
    const missing = [];
    for (const stage of KANBAN_STAGES) {
      if (stage.forecast === false) continue; // stage hors projection : pas de % à exposer
      const n = Number(saved[stage.id]);
      if (!Number.isFinite(n)) { missing.push(stage.label); continue; }
      probabilities[stage.label] = Math.max(0, Math.min(100, Math.round(n)));
    }
    if (missing.length) throw new Error(`barème incomplet, stages sans % : ${missing.join(', ')}`);
    // Seul un succès est mis en cache : après un incident, le barème revient dès l'appel suivant.
    probaCache = { ok: true, probabilities, reason: null };
    probaCacheTime = now;
    return probaCache;
  } catch (e) {
    console.error('[mcp-deals] barème de pondération illisible :', e.message);
    return { ok: false, probabilities: {}, reason: e.message };
  }
}

// =====================================================================
//  Garde-fou d'obsolescence
// =====================================================================
// Une copie périmée de ce serveur ne se plaint pas : elle répond des chiffres faux
// avec assurance, et personne ne le voit. On publie donc la version minimale requise
// dans la même table de config que le barème (kpi_prime_config, ligne 'mcp_version',
// `config.min_version`), canal auquel CHAQUE installation a déjà accès. Aucune
// migration. Toute réponse d'un serveur trop ancien porte alors un avertissement.
//
// Limite assumée : ce garde-fou ne protège que l'avenir. Les copies installées AVANT
// son introduction ne savent pas se plaindre ; seule une redistribution les corrige.
const MIN_VERSION_CONFIG_ID = 'mcp_version';
const MIN_VERSION_CACHE_TTL = 5 * 60 * 1000; // change très rarement
let minVersionCache = null;
let minVersionCacheTime = 0;

// Version minimale publiée, ou null si injoignable. En cas de panne on ne crie PAS
// au loup : un faux avertissement d'obsolescence serait vite ignoré, et un
// avertissement ignoré ne protège plus de rien.
async function loadMinVersion() {
  const now = Date.now();
  if (minVersionCache && now - minVersionCacheTime < MIN_VERSION_CACHE_TTL) return minVersionCache;
  try {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('kpi_prime_config').select('config').eq('id', MIN_VERSION_CONFIG_ID).maybeSingle();
    if (error) throw new Error(error.message);
    const min = data && data.config && data.config.min_version;
    if (!min) return null;
    minVersionCache = { min_version: String(min), message: (data.config.message || null) };
    minVersionCacheTime = now;
    return minVersionCache;
  } catch (e) {
    console.error('[mcp-deals] version minimale illisible (aucun avertissement émis) :', e.message);
    return null;
  }
}

// Bloc `_mcp` joint à chaque réponse : la version qui tourne, et l'alerte si elle est trop vieille.
async function versionStamp() {
  const stamp = { server_version: MCP_SERVER_VERSION };
  const min = await loadMinVersion();
  if (min && compareVersions(MCP_SERVER_VERSION, min.min_version) < 0) {
    stamp.outdated = true;
    stamp.min_version = min.min_version;
    // Formulé à destination du modèle qui lit la réponse : il doit le dire à l'utilisateur.
    stamp.warning =
      `SERVEUR MCP OBSOLÈTE : version ${MCP_SERVER_VERSION} installée sur ce poste, ` +
      `${min.min_version} requise. Les chiffres ci-dessous peuvent être FAUX. ` +
      `PRÉVIENS L'UTILISATEUR AVANT DE RÉPONDRE et dis-lui de demander le kit à jour à Nathan ` +
      `(remplacer le dossier kit-releaf-deals, puis relancer Claude Desktop).`;
    if (min.message) stamp.note = min.message;
  }
  return stamp;
}

// Récupère tous les résultats d'une recherche en suivant la pagination.
// Deux garde-fous : un curseur qui n'avance pas et un nombre de pages plafonné. Sans eux,
// une réponse HubSpot dégénérée (même `after` renvoyé en boucle) fait tourner l'outil à l'infini.
const SEARCH_MAX_PAGES = 100; // 100 pages x 100 résultats = 10 000, la limite de l'API search
async function searchAll(body) {
  const all = [];
  let after;
  let pages = 0;
  while (true) {
    const b = after ? { ...body, after } : body;
    const result = await hubspotSearch(b);
    if (result.results) all.push(...result.results);
    const next = result.paging && result.paging.next && result.paging.next.after;
    if (!next) break;
    if (next === after) {
      console.error('[mcp-deals] pagination HubSpot bloquée (curseur identique), arrêt.');
      break;
    }
    if (++pages >= SEARCH_MAX_PAGES) {
      console.error('[mcp-deals] pagination HubSpot : plafond de pages atteint, arrêt.');
      break;
    }
    after = next;
  }
  return all;
}

// --- Tags (Supabase deal_metadata) ---
// Charge une Map deal_id(string) -> string[] de tags. Tolère tags en JSON string ou array.
async function loadTagsByDeal() {
  const map = new Map();
  if (!supabase) return map;
  const { data, error } = await supabase.from('deal_metadata').select('deal_id, tags');
  if (error) throw new Error(`Supabase deal_metadata: ${error.message}`);
  for (const row of data || []) {
    let t = row.tags;
    if (t == null) continue;
    if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = [t]; } }
    if (!Array.isArray(t)) t = [t];
    map.set(String(row.deal_id), t.map((x) => String(x)));
  }
  return map;
}

// Un deal porte-t-il le tag demandé ? (insensible à la casse)
function hasTag(tags, wanted) {
  if (!wanted) return true;
  const w = wanted.toLowerCase();
  return (tags || []).some((t) => t.toLowerCase() === w);
}

// --- Utilitaires ---
const fmtEUR = (n) => `${Math.round(n).toLocaleString('fr-FR')} €`;

// Convertit 'YYYY-MM-DD' (ou ISO) en epoch ms. endOfDay=true → 23:59:59.999.
function toEpochMs(dateStr, endOfDay = false) {
  const d = new Date(dateStr.length <= 10 ? `${dateStr}T00:00:00.000Z` : dateStr);
  if (isNaN(d.getTime())) throw new Error(`Date invalide: ${dateStr}`);
  if (endOfDay && dateStr.length <= 10) d.setUTCHours(23, 59, 59, 999);
  return String(d.getTime());
}

// Normalise une valeur Supabase (JSON string ou array) en tableau.
function asArray(v) {
  if (v == null) return [];
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return [v]; } }
  return Array.isArray(v) ? v : [v];
}

// Charge TOUTE la metadata deal en Map deal_id(string) -> row.
// `notes` et `reveille_at` sont indispensables au calcul de dormance (dernier traitement =
// max(relance, note, réveil manuel)) : sans eux, des deals seraient déclarés en sommeil à tort
// et disparaîtraient du pipe pondéré. `wake_up_at` porte la date de retour d'un deal gelé.
//
// Une seule requête groupée, mise en cache 30 s : get_daily_briefing appelle trois collecteurs
// qui ont tous besoin de la même table. Le cache est jeté à chaque écriture (upsertMeta), donc
// une lecture qui suit une écriture voit toujours la valeur fraîche.
const META_CACHE_TTL = 30 * 1000;
let metaCache = null;
let metaCacheTime = 0;
function invalidateMetaCache() { metaCache = null; metaCacheTime = 0; }

async function loadMetaByDeal() {
  if (metaCache && Date.now() - metaCacheTime < META_CACHE_TTL) return metaCache;
  const map = new Map();
  if (!supabase) return map;
  const { data, error } = await supabase
    .from('deal_metadata')
    .select('deal_id, tags, tasks, relances, notes, assignee, next_meeting_at, wake_up_at, reveille_at');
  if (error) throw new Error(`Supabase deal_metadata: ${error.message}`);
  for (const row of data || []) map.set(String(row.deal_id), row);
  metaCache = map;
  metaCacheTime = Date.now();
  return map;
}

// Extrait de la ligne Supabase les seuls champs que lit isDealDormant, normalisés.
// (les colonnes JSON peuvent revenir en chaîne ou en tableau selon l'historique d'écriture)
function dormancyMeta(m) {
  return {
    next_meeting_at: m ? m.next_meeting_at : null,
    tasks: asArray(m && m.tasks),
    relances: asArray(m && m.relances),
    notes: asArray(m && m.notes),
    reveille_at: m ? m.reveille_at : null,
  };
}

// Récupère nom/stage/montant/clôture d'une liste d'IDs deals via batch read HubSpot
// (chunks de 100). Renvoie Map id(string) -> { name, amount, stage, closed }.
async function fetchDealInfos(ids) {
  const infos = new Map();
  const uniq = [...new Set(ids.map(String))];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    if (!chunk.length) continue;
    const res = await hubspotWrite('POST', '/crm/v3/objects/deals/batch/read', {
      properties: ['dealname', 'amount', 'dealstage', 'hs_is_closed'],
      inputs: chunk.map((id) => ({ id })),
    });
    for (const d of res.results || []) {
      const stageInfo = KANBAN_STAGES.find((s) => s.id === d.properties?.dealstage);
      infos.set(String(d.id), {
        name: d.properties?.dealname || 'Sans nom',
        amount: parseFloat(d.properties?.amount) || 0,
        stage: stageInfo ? stageInfo.label : (d.properties?.dealstage || null),
        closed: d.properties?.hs_is_closed === 'true',
      });
    }
  }
  return infos;
}

// --- Logique partagée (réutilisée par get_tasks / get_overdue_deals / get_daily_briefing) ---

// Collecte les tâches de tous les deals, aplaties et enrichies du nom de deal.
async function collectTasks({ status = 'todo', overdue_only = false, assignee, type, open_only = false } = {}) {
  const meta = await loadMetaByDeal();
  const now = Date.now();
  // Le filtre assigné s'applique AVANT fetchDealInfos : inutile d'aller chercher chez HubSpot
  // le détail de deals qu'on va jeter juste après. Sur un briefing filtré par personne, cela
  // divise par trois le volume interrogé.
  const idsWithTasks = [];
  for (const [dealId, m] of meta) {
    if (assignee && (m.assignee || '').toLowerCase() !== assignee.toLowerCase()) continue;
    if (asArray(m.tasks).length) idsWithTasks.push(dealId);
  }
  const infos = await fetchDealInfos(idsWithTasks);

  const rows = [];
  for (const [dealId, m] of meta) {
    const dealAssignee = m.assignee || null;
    if (assignee && (dealAssignee || '').toLowerCase() !== assignee.toLowerCase()) continue;
    const info = infos.get(String(dealId)) || {};
    if (open_only && info.closed === true) continue; // ignore les tâches sur deals clôturés
    for (const t of asArray(m.tasks)) {
      const isDone = t.status === 'done' || !!t.done_at;
      if (status === 'todo' && isDone) continue;
      if (status === 'done' && !isDone) continue;
      if (type && t.type !== type) continue;
      const dueMs = t.due_at ? new Date(t.due_at).getTime() : null;
      const overdue = !isDone && dueMs != null && !isNaN(dueMs) && dueMs < now;
      if (overdue_only && !overdue) continue;
      rows.push({
        deal_id: String(dealId),
        deal_name: info.name || null,
        deal_stage: info.stage || null,
        deal_closed: info.closed ?? null,
        assignee: dealAssignee,
        type: t.type,
        label: t.label || '',
        due_at: t.due_at || null,
        status: isDone ? 'done' : 'todo',
        overdue,
        days_overdue: overdue ? Math.floor((now - dueMs) / 86400000) : 0,
      });
    }
  }
  // retards d'abord, puis échéance croissante, sans échéance en dernier
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const da = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    return da - db;
  });
  return { rows, overdue_count: rows.filter((r) => r.overdue).length };
}

// Collecte les deals OUVERTS en retard : closedate dépassée et/ou next_meeting_at passé.
async function collectOverdueDeals({ assignee, stage } = {}) {
  const now = Date.now();
  const filters = [
    { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
    { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
  ];
  if (stage) {
    const s = KANBAN_STAGES.find((x) => x.label.toLowerCase() === stage.toLowerCase());
    if (s) filters.push({ propertyName: 'dealstage', operator: 'EQ', value: s.id });
  }
  const [deals, meta] = await Promise.all([
    searchAll({
      filterGroups: [{ filters }],
      properties: ['dealname', 'amount', 'dealstage', 'closedate', 'createdate'],
      limit: 100,
    }),
    loadMetaByDeal(),
  ]);

  const rows = [];
  for (const d of deals) {
    const m = meta.get(String(d.id)) || {};
    const dealAssignee = m.assignee || null;
    if (assignee && (dealAssignee || '').toLowerCase() !== assignee.toLowerCase()) continue;
    const stageInfo = KANBAN_STAGES.find((s) => s.id === d.properties.dealstage);
    const closeMs = d.properties.closedate ? new Date(d.properties.closedate).getTime() : null;
    const meetingMs = m.next_meeting_at ? new Date(m.next_meeting_at).getTime() : null;
    const reasons = [];
    if (closeMs != null && !isNaN(closeMs) && closeMs < now) reasons.push('closedate_passée');
    if (meetingMs != null && !isNaN(meetingMs) && meetingMs < now) reasons.push('rdv_passé');
    if (!reasons.length) continue;
    const relances = asArray(m.relances);
    const lastRelance = relances.length ? relances[relances.length - 1] : null;
    const overdueRef = Math.min(...[closeMs, meetingMs].filter((x) => x != null && !isNaN(x) && x < now));
    rows.push({
      id: String(d.id),
      name: d.properties.dealname || 'Sans nom',
      amount: parseFloat(d.properties.amount) || 0,
      stage: stageInfo ? stageInfo.label : d.properties.dealstage,
      assignee: dealAssignee,
      closedate: d.properties.closedate || null,
      next_meeting_at: m.next_meeting_at || null,
      reasons,
      days_overdue: Math.floor((now - overdueRef) / 86400000),
      tags: asArray(m.tags).map(String),
      last_relance: lastRelance ? { at: lastRelance.at, type: lastRelance.type, note: lastRelance.note } : null,
    });
  }
  rows.sort((a, b) => b.days_overdue - a.days_overdue);
  return { rows, total_amount: rows.reduce((s, r) => s + r.amount, 0) };
}

// Collecte les prochains RDV (next_meeting_at) dans une fenêtre de N jours.
async function collectUpcomingMeetings({ assignee, days = 7 } = {}) {
  const meta = await loadMetaByDeal();
  const now = Date.now();
  const horizon = now + days * 86400000;
  const picked = [];
  for (const [dealId, m] of meta) {
    if (!m.next_meeting_at) continue;
    const t = new Date(m.next_meeting_at).getTime();
    if (isNaN(t) || t < now || t > horizon) continue;
    if (assignee && (m.assignee || '').toLowerCase() !== assignee.toLowerCase()) continue;
    picked.push({ deal_id: String(dealId), assignee: m.assignee || null, next_meeting_at: m.next_meeting_at });
  }
  const infos = await fetchDealInfos(picked.map((p) => p.deal_id));
  return picked
    .map((p) => ({ ...p, deal_name: (infos.get(p.deal_id) || {}).name || null, stage: (infos.get(p.deal_id) || {}).stage || null }))
    .sort((a, b) => new Date(a.next_meeting_at).getTime() - new Date(b.next_meeting_at).getTime());
}

// =====================================================================
//  Serveur MCP
// =====================================================================
const server = new McpServer({ name: 'releaf-deals', version: MCP_SERVER_VERSION });

// On enveloppe registerTool UNE fois plutôt que d'estampiller douze handlers à la main :
// tout outil ajouté plus tard hérite du garde-fou sans que personne ait à y penser.
// La réponse n'est touchée que si c'est un objet JSON ; sinon elle passe telle quelle.
const _registerTool = server.registerTool.bind(server);
server.registerTool = (name, spec, handler) =>
  _registerTool(name, spec, async (...args) => {
    const result = await handler(...args);
    try {
      const first = result && result.content && result.content[0];
      if (!first || first.type !== 'text') return result;
      let payload;
      try { payload = JSON.parse(first.text); } catch { return result; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return result;
      payload._mcp = await versionStamp();
      const content = [...result.content];
      content[0] = { ...first, text: JSON.stringify(payload, null, 2) };
      return { ...result, content };
    } catch (e) {
      console.error('[mcp-deals] estampillage de version impossible :', e.message);
      return result; // jamais au prix de la réponse elle-même
    }
  });

// --- Outil 1 : pipeline des deals ouverts (qualitatif) ---
server.registerTool(
  'get_pipeline',
  {
    title: 'Pipeline des deals ouverts',
    description:
      "Renvoie tous les deals OUVERTS du pipeline 'default', groupés par stage, avec montant, dates, " +
      "description, tags (EPD, Bilan carbone, Web app, ACV…), ASSIGNÉ et état du deal. " +
      "À utiliser pour les questions qualitatives : quels deals relancer, lesquels sont à risque, " +
      "où en est le pipeline, répartition par offre/tag ou par personne. Filtrer par tag avec 'tag'. " +
      "Les descriptions ne sont PAS renvoyées par défaut : passer include_descriptions=true uniquement " +
      "quand la question porte sur le contenu d'un deal, pas pour un état du pipe ou un forecast. " +
      "PÉRIMÈTRE : 'weighted_forecast' ne compte QUE les deals actifs, c'est-à-dire ni gelés " +
      "(stage 'À relancer plus tard') ni en sommeil (90 j sans relance ni note). C'est exactement " +
      "le périmètre de la carte « Commercial » de Pilot : utiliser 'active_count' et 'active_amount' " +
      "pour un chiffre comparable à l'interface, PAS 'open_deals' / 'total_amount' qui comptent tout. " +
      "Chaque deal porte 'dormant', 'frozen' et 'counts_in_forecast' : ne pas redériver ces règles. " +
      "PROBABILITÉS : lues dans les réglages de Pilot et renvoyées dans 'stage_probabilities' ; " +
      "les afficher depuis ce champ, ne jamais les recopier ailleurs. Si 'weighted_forecast' vaut null " +
      "avec un 'warning', le barème est injoignable : NE PAS calculer de pipe pondéré soi-même, " +
      "signaler que l'indicateur est indisponible.",
    inputSchema: {
      tag: z.string().optional().describe("Ne garder que les deals portant ce tag, ex 'EPD' (optionnel, insensible à la casse)"),
      include_descriptions: z.boolean().optional().describe(
        "Inclure le texte libre de description de chaque deal. Défaut : NON, car il double le poids de la " +
        "réponse sans servir au pilotage. Ne l'activer que pour une lecture qualitative (« où en est ce deal, " +
        "qu'est-ce qui bloque ? »). Pour un état du pipe, un forecast, une répartition par personne ou par " +
        "offre, laisser à false : montants, étapes, assigné et états suffisent."),
    },
  },
  async ({ tag, include_descriptions = false }) => {
    const [deals, metaByDeal, proba] = await Promise.all([
      searchAll({
        filterGroups: [{
          filters: [
            { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
            { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          ],
        }],
        properties: ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'description'],
        limit: 100,
      }),
      loadMetaByDeal(),
      loadStageProbabilities(),
    ]);

    const now = Date.now();
    const byStage = {};
    const byTag = {};
    let weightedForecast = 0;
    let totalAmount = 0;
    let kept = 0;
    let activeCount = 0, activeAmount = 0;
    let dormantCount = 0, dormantAmount = 0;
    let frozenCount = 0, frozenAmount = 0;
    for (const stage of KANBAN_STAGES) byStage[stage.label] = { count: 0, amount: 0, dormant_count: 0, deals: [] };

    for (const d of deals) {
      const stage = KANBAN_STAGES.find((s) => s.id === d.properties.dealstage);
      if (!stage) continue;
      const m = metaByDeal.get(String(d.id)) || {};
      const tags = asArray(m.tags).map(String);
      if (!hasTag(tags, tag)) continue;
      const amount = parseFloat(d.properties.amount) || 0;
      const createdate = d.properties.createdate || null;

      // Trois états, exactement comme la carte « Commercial » de Pilot :
      //  - gelé   : rangé dans « À relancer plus tard » (geste manuel), hors projection ;
      //  - dormant : 90 j sans relance ni note, sauf RDV futur / tâche à échéance / deal récent ;
      //  - actif   : le reste, seul à entrer dans weighted_forecast.
      // Un deal gelé n'est jamais dit « dormant » : c'est déjà une sortie volontaire du pipe actif.
      const frozen = stage.forecast === false;
      const dormant = !frozen && isDealDormant({ createdate }, dormancyMeta(m), now);
      const countsInForecast = !frozen && !dormant;
      // Probabilité nulle pour un gelé, null quand le barème de Pilot est injoignable :
      // on n'invente jamais un pourcentage.
      const probability = frozen ? 0 : (proba.ok ? proba.probabilities[stage.label] : null);

      kept++;
      byStage[stage.label].count++;
      byStage[stage.label].amount += amount;
      if (dormant) byStage[stage.label].dormant_count++;
      byStage[stage.label].deals.push({
        id: d.id,
        name: d.properties.dealname || 'Sans nom',
        amount,
        assignee: m.assignee || null,
        tags,
        dormant,
        frozen,
        counts_in_forecast: countsInForecast,
        probability,
        weighted: countsInForecast && probability != null ? Math.round(amount * probability / 100) : 0,
        createdate,
        closedate: d.properties.closedate || null,
        wake_up_at: m.wake_up_at || null,
        next_meeting_at: m.next_meeting_at || null,
        // Le texte libre pèse à lui seul la moitié de la réponse : il n'est joint que sur demande.
        ...(include_descriptions ? { description: d.properties.description || '' } : {}),
      });
      for (const tg of tags) {
        if (!byTag[tg]) byTag[tg] = { count: 0, amount: 0 };
        byTag[tg].count++;
        byTag[tg].amount += amount;
      }
      totalAmount += amount;
      if (frozen) { frozenCount++; frozenAmount += amount; }
      else if (dormant) { dormantCount++; dormantAmount += amount; }
      else {
        activeCount++; activeAmount += amount;
        if (probability != null) weightedForecast += amount * (probability / 100);
      }
    }

    const summary = {
      filter_tag: tag || null,
      // Sans ce drapeau, un lecteur pourrait croire que les deals n'ont pas de description.
      descriptions_included: !!include_descriptions,
      open_deals: kept,
      total_amount: totalAmount,
      total_amount_label: fmtEUR(totalAmount),
      // Le périmètre de projection : actif = ni gelé, ni en sommeil. C'est CE compte
      // et CE montant qui correspondent à la carte « Commercial » de Pilot.
      active_count: activeCount,
      active_amount: activeAmount,
      active_amount_label: fmtEUR(activeAmount),
      dormant_count: dormantCount,
      dormant_amount: dormantAmount,
      dormant_amount_label: fmtEUR(dormantAmount),
      frozen_count: frozenCount,
      frozen_amount: frozenAmount,
      frozen_amount_label: fmtEUR(frozenAmount),
      weighted_forecast: proba.ok ? Math.round(weightedForecast) : null,
      weighted_forecast_label: proba.ok ? fmtEUR(weightedForecast) : null,
      stage_probabilities: proba.ok ? proba.probabilities : null,
      stage_probabilities_source: 'Réglages Pilot (écran de pondération)',
      forecast_excludes: ['À relancer plus tard', 'deals en sommeil'],
      by_stage: Object.fromEntries(
        KANBAN_STAGES.map((s) => [s.label, {
          count: byStage[s.label].count,
          amount: byStage[s.label].amount,
          dormant_count: byStage[s.label].dormant_count,
          probability: s.forecast === false ? 0 : (proba.ok ? proba.probabilities[s.label] : null),
        }])
      ),
      by_tag: byTag,
    };
    if (!proba.ok) {
      summary.warning = 'stage probabilities unavailable';
      summary.warning_detail = proba.reason;
    }

    return { content: [{ type: 'text', text: JSON.stringify({ summary, pipeline: byStage }, null, 2) }] };
  }
);

// --- Outil 2 : analytics des deals clôturés sur une période (chiffré) ---
server.registerTool(
  'get_deals_analytics',
  {
    title: 'Analytics deals clôturés (période)',
    description:
      "Analytics chiffré des deals CLÔTURÉS (gagnés + perdus) du pipeline 'default' sur une période, " +
      "filtrés par date de clôture (closedate). Renvoie : nb et montant gagnés/perdus, taux de conversion, " +
      "panier moyen gagné, ventilation par tag, et un bloc 'tag_coverage'. " +
      "Exemple : Q1 2026 → from='2026-01-01', to='2026-03-31'. Filtrer une offre avec 'tag' (ex 'EPD'). " +
      "IMPORTANT : les tags (EPD, Bilan carbone…) sont peu présents sur l'historique clôturé. " +
      "Si tag_coverage.closed_with_tag est faible par rapport à closed_deals, PRÉVIENS l'utilisateur " +
      "que l'analyse par tag sur le clôturé est partielle et donc indicative, pas exhaustive.",
    inputSchema: {
      from: z.string().describe("Début de période, format YYYY-MM-DD (sur closedate)"),
      to: z.string().describe("Fin de période incluse, format YYYY-MM-DD (sur closedate)"),
      tag: z.string().optional().describe("Ne garder que les deals portant ce tag, ex 'EPD' (optionnel)"),
    },
  },
  async ({ from, to, tag }) => {
    const [deals, metaByDeal] = await Promise.all([
      searchAll({
        filterGroups: [{
          filters: [
            { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
            { propertyName: 'hs_is_closed', operator: 'EQ', value: 'true' },
            { propertyName: 'closedate', operator: 'BETWEEN', value: toEpochMs(from), highValue: toEpochMs(to, true) },
          ],
        }],
        properties: ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'hs_is_closed_won'],
        limit: 100,
      }),
      loadMetaByDeal(), // et non loadTagsByDeal : on a besoin de l'assigné, pas seulement des tags
    ]);

    let won = { count: 0, amount: 0, deals: [] };
    let lost = { count: 0, amount: 0, deals: [] };
    const byTag = {};
    let closedWithTag = 0;
    let closedTotalInPeriod = 0;

    const byAssignee = {};
    for (const d of deals) {
      const m = metaByDeal.get(String(d.id)) || {};
      const tags = asArray(m.tags).map(String);
      const assignee = m.assignee || null; // null explicite : « non assigné » est une information
      closedTotalInPeriod++;
      if (tags.length) closedWithTag++;
      if (!hasTag(tags, tag)) continue;
      const amount = parseFloat(d.properties.amount) || 0;
      const isWon = d.properties.hs_is_closed_won === 'true' || d.properties.dealstage === 'closedwon';
      const bucket = isWon ? won : lost;
      bucket.count++;
      bucket.amount += amount;
      bucket.deals.push({ id: d.id, name: d.properties.dealname || 'Sans nom', amount, assignee, tags, closedate: d.properties.closedate || null });
      const key = assignee || 'Non assigné';
      if (!byAssignee[key]) byAssignee[key] = { won_count: 0, won_amount: 0, lost_count: 0, lost_amount: 0 };
      if (isWon) { byAssignee[key].won_count++; byAssignee[key].won_amount += amount; }
      else { byAssignee[key].lost_count++; byAssignee[key].lost_amount += amount; }
      for (const tg of tags) {
        if (!byTag[tg]) byTag[tg] = { won_count: 0, won_amount: 0, lost_count: 0, lost_amount: 0 };
        if (isWon) { byTag[tg].won_count++; byTag[tg].won_amount += amount; }
        else { byTag[tg].lost_count++; byTag[tg].lost_amount += amount; }
      }
    }

    const totalClosed = won.count + lost.count;
    const totalAmount = won.amount + lost.amount;
    const convCount = totalClosed ? won.count / totalClosed : 0;
    const convAmount = totalAmount ? won.amount / totalAmount : 0;
    const avgWon = won.count ? won.amount / won.count : 0;

    const analytics = {
      period: { from, to },
      filter_tag: tag || null,
      closed_deals: totalClosed,
      won: { count: won.count, amount: won.amount, amount_label: fmtEUR(won.amount) },
      lost: { count: lost.count, amount: lost.amount, amount_label: fmtEUR(lost.amount) },
      conversion_rate_count: `${(convCount * 100).toFixed(1)}%`,
      conversion_rate_amount: `${(convAmount * 100).toFixed(1)}%`,
      avg_won_deal: Math.round(avgWon),
      avg_won_deal_label: fmtEUR(avgWon),
      by_tag: byTag,
      by_assignee: byAssignee,
      tag_coverage: {
        closed_in_period: closedTotalInPeriod,
        closed_with_tag: closedWithTag,
        note: closedWithTag < closedTotalInPeriod
          ? "Tous les deals clôturés ne sont pas taggés : l'analyse PAR TAG sur le clôturé est partielle/indicative."
          : 'Tous les deals clôturés de la période sont taggés.',
      },
      won_deals: won.deals,
      lost_deals: lost.deals,
    };

    return { content: [{ type: 'text', text: JSON.stringify(analytics, null, 2) }] };
  }
);

// --- Outil 3 : liste filtrable de deals ---
server.registerTool(
  'list_deals',
  {
    title: 'Liste filtrable de deals',
    description:
      "Liste de deals du pipeline 'default' filtrable par statut (open/closed/all), période (sur closedate " +
      "pour closed, sur createdate pour open) et stage. Utile pour explorer une sous-population avant analyse.",
    inputSchema: {
      status: z.enum(['open', 'closed', 'all']).default('open').describe("Statut des deals"),
      from: z.string().optional().describe("Début de période YYYY-MM-DD (optionnel)"),
      to: z.string().optional().describe("Fin de période YYYY-MM-DD incluse (optionnel)"),
      stage: z.string().optional().describe("Label de stage exact, ex 'Négociation' (optionnel, deals ouverts)"),
      tag: z.string().optional().describe("Ne garder que les deals portant ce tag, ex 'EPD' (optionnel)"),
    },
  },
  async ({ status = 'open', from, to, stage, tag }) => {
    const filters = [{ propertyName: 'pipeline', operator: 'EQ', value: 'default' }];
    if (status === 'open') filters.push({ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' });
    if (status === 'closed') filters.push({ propertyName: 'hs_is_closed', operator: 'EQ', value: 'true' });

    const dateProp = status === 'closed' ? 'closedate' : 'createdate';
    if (from && to) {
      filters.push({ propertyName: dateProp, operator: 'BETWEEN', value: toEpochMs(from), highValue: toEpochMs(to, true) });
    } else if (from) {
      filters.push({ propertyName: dateProp, operator: 'GTE', value: toEpochMs(from) });
    } else if (to) {
      filters.push({ propertyName: dateProp, operator: 'LTE', value: toEpochMs(to, true) });
    }
    if (stage) {
      const s = KANBAN_STAGES.find((x) => x.label.toLowerCase() === stage.toLowerCase());
      if (s) filters.push({ propertyName: 'dealstage', operator: 'EQ', value: s.id });
    }

    const [deals, tagsByDeal] = await Promise.all([
      searchAll({
        filterGroups: [{ filters }],
        properties: ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'hs_is_closed_won', 'description'],
        limit: 100,
      }),
      loadTagsByDeal(),
    ]);

    const rows = deals
      .map((d) => {
        const stageInfo = KANBAN_STAGES.find((s) => s.id === d.properties.dealstage);
        return {
          id: d.id,
          name: d.properties.dealname || 'Sans nom',
          amount: parseFloat(d.properties.amount) || 0,
          stage: stageInfo ? stageInfo.label : d.properties.dealstage,
          won: d.properties.hs_is_closed_won === 'true' ? true : (d.properties.hs_is_closed_won === 'false' ? false : null),
          tags: tagsByDeal.get(String(d.id)) || [],
          createdate: d.properties.createdate || null,
          closedate: d.properties.closedate || null,
        };
      })
      .filter((r) => hasTag(r.tags, tag));

    return { content: [{ type: 'text', text: JSON.stringify({ count: rows.length, filter_tag: tag || null, deals: rows }, null, 2) }] };
  }
);

// --- Outil 4 : tâches des deals (retard / à venir) ---
server.registerTool(
  'get_tasks',
  {
    title: 'Tâches des deals (retard, à venir)',
    description:
      "Liste les tâches attachées aux deals (stockées dans Supabase). Répond à « quelles tâches suis-je en retard ? ». " +
      "Une tâche est EN RETARD (overdue=true) si elle n'est pas faite ET que son échéance (due_at) est passée. " +
      "Les tâches sans échéance ne sont jamais overdue. Triées : retards d'abord, puis échéance croissante. " +
      "Filtrer par statut (todo/done/all), retard seul, assigné du deal (Guillaume/Vincent/Nathan) et type.",
    inputSchema: {
      status: z.enum(['todo', 'done', 'all']).default('todo').describe('Statut des tâches (défaut: todo)'),
      overdue_only: z.boolean().optional().describe('Ne garder que les tâches en retard'),
      assignee: z.string().optional().describe('Filtrer par assigné du deal : Guillaume | Vincent | Nathan'),
      type: z.string().optional().describe('Filtrer par type : call, email, proposal, meeting, contract, custom'),
      open_only: z.boolean().optional().describe('Ignorer les tâches sur des deals déjà clôturés (défaut: false)'),
    },
  },
  async ({ status = 'todo', overdue_only, assignee, type, open_only }) => {
    const { rows, overdue_count } = await collectTasks({ status, overdue_only, assignee, type, open_only });
    return { content: [{ type: 'text', text: JSON.stringify({
      count: rows.length,
      overdue_count,
      filters: { status, overdue_only: !!overdue_only, assignee: assignee || null, type: type || null },
      tasks: rows,
    }, null, 2) }] };
  }
);

// --- Outil 5 : deals ouverts en retard ---
server.registerTool(
  'get_overdue_deals',
  {
    title: 'Deals en retard (closedate / RDV passés)',
    description:
      "Deals OUVERTS du pipeline 'default' qui « traînent » : soit leur date de clôture prévue (closedate) est " +
      "déjà passée, soit leur prochain RDV (next_meeting_at, Supabase) est passé. Répond à « quels deals suis-je " +
      "en retard ? ». Chaque deal indique la/les raison(s), les jours de retard, l'assigné, les tags et la dernière " +
      "relance connue. Trié par retard décroissant. Filtrable par assigné et stage.",
    inputSchema: {
      assignee: z.string().optional().describe('Filtrer par assigné : Guillaume | Vincent | Nathan'),
      stage: z.string().optional().describe("Label de stage exact, ex 'Négociation'"),
    },
  },
  async ({ assignee, stage }) => {
    const { rows, total_amount } = await collectOverdueDeals({ assignee, stage });
    return { content: [{ type: 'text', text: JSON.stringify({
      count: rows.length,
      total_amount,
      total_amount_label: fmtEUR(total_amount),
      filters: { assignee: assignee || null, stage: stage || null },
      deals: rows,
    }, null, 2) }] };
  }
);

// --- Outil 6 : briefing commercial du jour (vue de pilotage en 1 appel) ---
// Budget de temps EXPLICITE : cet outil alimente le briefing de 9 h 30, il ne doit jamais
// laisser l'appelant sans réponse. Chaque collecteur court contre le budget ; celui qui
// dépasse rend une section vide et le briefing part avec truncated: true. Un briefing
// partiel et honnête vaut mieux qu'un appel qui ne rend pas la main.
const BRIEFING_BUDGET_MS = 20 * 1000;

// Course entre un collecteur et le budget restant. La promesse perdue continue en arrière-plan
// (on ne peut pas l'annuler) mais on ne l'attend plus. `incidents` collecte ce qui a manqué,
// pour que la réponse dise QUELLE section est incomplète et pourquoi.
function withBudget(promise, ms, fallback, label, incidents) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      incidents.push(`${label} : budget de ${Math.round(ms / 1000)} s dépassé`);
      resolve(fallback);
    }, ms);
    if (timer.unref) timer.unref(); // ne pas maintenir le process en vie pour ce minuteur
  });
  return Promise.race([
    promise.catch((e) => { incidents.push(`${label} : ${e.message}`); return fallback; }),
    guard,
  ]).then((v) => { clearTimeout(timer); return v; });
}

server.registerTool(
  'get_daily_briefing',
  {
    title: 'Briefing commercial du jour',
    description:
      "Vue de pilotage quotidienne en UN appel, idéale pour démarrer la journée : tâches en retard, tâches dues " +
      "aujourd'hui, deals en retard (closedate/RDV passés) et prochains RDV à venir (fenêtre paramétrable, défaut 7 j). " +
      "Filtrable par assigné. Répond en moins de 20 s : au-delà, il renvoie ce qui est prêt avec truncated: true " +
      "et 'truncated_reasons' qui nomme la section manquante. Le champ 'timings_ms' donne le temps de chaque étape.",
    inputSchema: {
      assignee: z.string().optional().describe('Filtrer par assigné : Guillaume | Vincent | Nathan'),
      upcoming_days: z.number().optional().describe('Fenêtre des RDV à venir, en jours (défaut 7)'),
    },
  },
  async ({ assignee, upcoming_days = 7 }) => {
    const started = Date.now();
    const incidents = [];
    const timings = {};
    // Instrumentation permanente : la prochaine fois qu'une étape ralentit, elle se désigne
    // toute seule dans la réponse au lieu de se deviner.
    const timed = (label, promise) => {
      const s0 = Date.now();
      return promise.then((r) => { timings[label] = Date.now() - s0; return r; });
    };

    const [tasksRes, overdueRes, meetings] = await Promise.all([
      withBudget(timed('tasks', collectTasks({ status: 'todo', assignee, open_only: true })),
        BRIEFING_BUDGET_MS, { rows: [], overdue_count: 0 }, 'tâches', incidents),
      withBudget(timed('overdue_deals', collectOverdueDeals({ assignee })),
        BRIEFING_BUDGET_MS, { rows: [], total_amount: 0 }, 'deals en retard', incidents),
      withBudget(timed('upcoming_meetings', collectUpcomingMeetings({ assignee, days: upcoming_days })),
        BRIEFING_BUDGET_MS, [], 'RDV à venir', incidents),
    ]);
    timings.total = Date.now() - started;

    const endToday = new Date();
    endToday.setHours(23, 59, 59, 999);
    const endTodayMs = endToday.getTime();
    const overdueTasks = tasksRes.rows.filter((t) => t.overdue);
    const dueTodayTasks = tasksRes.rows.filter(
      (t) => !t.overdue && t.due_at && new Date(t.due_at).getTime() <= endTodayMs
    );

    return { content: [{ type: 'text', text: JSON.stringify({
      generated_at: new Date().toISOString(),
      assignee: assignee || null,
      truncated: incidents.length > 0,
      truncated_reasons: incidents,
      timings_ms: timings,
      headline: {
        overdue_tasks: overdueTasks.length,
        due_today_tasks: dueTodayTasks.length,
        overdue_deals: overdueRes.rows.length,
        overdue_deals_amount_label: fmtEUR(overdueRes.total_amount),
        upcoming_meetings: meetings.length,
      },
      overdue_tasks: overdueTasks,
      due_today_tasks: dueTodayTasks,
      overdue_deals: overdueRes.rows,
      upcoming_meetings: meetings,
    }, null, 2) }] };
  }
);

// =====================================================================
//  Outils d'ÉCRITURE
//  Claude Desktop demande une confirmation manuelle avant chaque appel.
//  Validations de correction conservées (miroir server.js) ; pas de
//  garde-fou supplémentaire (choix utilisateur).
// =====================================================================

const STAGE_LABELS = Object.keys(STAGE_ID_MAP); // labels + closedwon/closedlost

// --- Créer un deal (HubSpot) ---
server.registerTool(
  'create_deal',
  {
    title: 'Créer un deal (HubSpot)',
    description:
      "Crée un nouveau deal dans le pipeline 'default' de HubSpot. ⚠️ Écrit dans le CRM réel. " +
      "Le stage doit être un label connu : " + STAGE_LABELS.join(', ') + ". " +
      "Optionnel : poser des tags (stockés dans Supabase) à la création.",
    inputSchema: {
      name: z.string().describe('Nom du deal (dealname)'),
      stage: z.string().describe("Stage, ex 'RDV Qualif' (label) — un de : " + STAGE_LABELS.join(', ')),
      amount: z.number().optional().describe('Montant en € (optionnel)'),
      closedate: z.string().optional().describe('Date de clôture prévue YYYY-MM-DD (optionnel)'),
      tags: z.array(z.string()).optional().describe("Tags à poser, ex ['EPD'] (optionnel)"),
    },
  },
  async ({ name, stage, amount, closedate, tags }) => {
    const stageId = STAGE_ID_MAP[stage];
    if (!stageId) throw new Error(`Stage invalide: "${stage}". Valeurs: ${STAGE_LABELS.join(', ')}`);
    const properties = { dealname: name, dealstage: stageId, pipeline: 'default' };
    if (amount != null) properties.amount = String(amount);
    if (closedate) properties.closedate = closedate;

    const result = await hubspotWrite('POST', '/crm/v3/objects/deals', { properties });
    let tagNote = null;
    if (tags && tags.length && result.id) {
      await upsertMeta({ deal_id: String(result.id), tags });
      tagNote = tags;
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: result.id, name, stage, amount: amount ?? null, tags: tagNote }, null, 2) }] };
  }
);

// --- Modifier un deal (HubSpot) ---
server.registerTool(
  'update_deal',
  {
    title: 'Modifier un deal (HubSpot)',
    description:
      "Modifie un deal existant (montant, stage, date de clôture, description). ⚠️ Écrit dans le CRM réel. " +
      "Pour clôturer un deal, préférer l'outil close_deal. Au moins un champ doit être fourni.",
    inputSchema: {
      id: z.string().describe('ID HubSpot du deal'),
      amount: z.number().optional().describe('Nouveau montant en €'),
      stage: z.string().optional().describe('Nouveau stage (label) — un de : ' + STAGE_LABELS.join(', ')),
      closedate: z.string().optional().describe('Nouvelle date de clôture YYYY-MM-DD'),
      description: z.string().optional().describe('Nouvelle description'),
    },
  },
  async ({ id, amount, stage, closedate, description }) => {
    const properties = {};
    if (amount != null) properties.amount = String(amount);
    if (closedate !== undefined) properties.closedate = closedate;
    if (description !== undefined) properties.description = description;
    if (stage !== undefined) {
      const stageId = STAGE_ID_MAP[stage];
      if (!stageId) throw new Error(`Stage invalide: "${stage}". Valeurs: ${STAGE_LABELS.join(', ')}`);
      properties.dealstage = stageId;
    }
    if (!Object.keys(properties).length) throw new Error('Rien à modifier : fournir au moins un champ.');
    await hubspotWrite('PATCH', `/crm/v3/objects/deals/${id}`, { properties });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, updated: properties }, null, 2) }] };
  }
);

// --- Clôturer un deal gagné/perdu (HubSpot) — action sensible ---
server.registerTool(
  'close_deal',
  {
    title: 'Clôturer un deal gagné/perdu (HubSpot)',
    description:
      "⚠️⚠️ Passe un deal en CLÔTURÉ gagné (closedwon) ou perdu (closedlost) dans HubSpot. " +
      "Action sensible et difficilement réversible : vérifier l'ID et l'issue avant de confirmer.",
    inputSchema: {
      id: z.string().describe('ID HubSpot du deal à clôturer'),
      outcome: z.enum(['won', 'lost']).describe("Issue : 'won' (gagné) ou 'lost' (perdu)"),
      closedate: z.string().optional().describe('Date de clôture YYYY-MM-DD (défaut: aujourd\'hui)'),
    },
  },
  async ({ id, outcome, closedate }) => {
    const properties = { dealstage: outcome === 'won' ? 'closedwon' : 'closedlost' };
    if (closedate) properties.closedate = closedate;
    await hubspotWrite('PATCH', `/crm/v3/objects/deals/${id}`, { properties });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, outcome, stage: properties.dealstage }, null, 2) }] };
  }
);

// --- Poser/remplacer les tags d'un deal (Supabase) ---
server.registerTool(
  'set_deal_tags',
  {
    title: 'Définir les tags d\'un deal',
    description:
      "Remplace la liste de tags d'un deal (Supabase, réversible). Tags usuels : EPD, Bilan carbone, Web app, ACV. " +
      "Pour AJOUTER un tag, lire d'abord les tags actuels (list_deals/get_pipeline) puis renvoyer la liste complète.",
    inputSchema: {
      id: z.string().describe('ID du deal'),
      tags: z.array(z.string()).describe("Liste COMPLÈTE des tags à enregistrer, ex ['EPD','Bilan carbone']"),
    },
  },
  async ({ id, tags }) => {
    await upsertMeta({ deal_id: String(id), tags });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, tags }, null, 2) }] };
  }
);

// --- Ajouter une note (Supabase, append-only) ---
server.registerTool(
  'add_deal_note',
  {
    title: 'Ajouter une note à un deal',
    description: "Ajoute une note append-only à un deal (Supabase, réversible).",
    inputSchema: {
      id: z.string().describe('ID du deal'),
      text: z.string().describe('Texte de la note'),
    },
  },
  async ({ id, text }) => {
    const clean = (text || '').trim();
    if (!clean) throw new Error('texte obligatoire');
    const existing = await readMeta(id, 'notes');
    const notes = Array.isArray(existing?.notes) ? existing.notes : [];
    const entry = { at: new Date().toISOString(), text: clean };
    notes.push(entry);
    await upsertMeta({ deal_id: String(id), notes });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, note: entry }, null, 2) }] };
  }
);

// --- Logger une relance (Supabase) ---
server.registerTool(
  'log_relance',
  {
    title: 'Logger une relance',
    description: "Enregistre une relance (email ou téléphone) avec note obligatoire (Supabase, réversible).",
    inputSchema: {
      id: z.string().describe('ID du deal'),
      type: z.enum(['email', 'phone']).describe("Canal : 'email' ou 'phone'"),
      note: z.string().describe('Note de relance (obligatoire)'),
    },
  },
  async ({ id, type, note }) => {
    const clean = (note || '').trim();
    if (!clean) throw new Error('note obligatoire');
    const existing = await readMeta(id, 'relances');
    const relances = Array.isArray(existing?.relances) ? existing.relances : [];
    const entry = { type, at: new Date().toISOString(), note: clean };
    relances.push(entry);
    await upsertMeta({ deal_id: String(id), relances });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, relance: entry }, null, 2) }] };
  }
);

// --- Ajouter une tâche (Supabase) ---
server.registerTool(
  'add_deal_task',
  {
    title: 'Ajouter une tâche à un deal',
    description: "Ajoute une tâche à la file d'un deal (Supabase, réversible). Types: " + TASK_TYPES.join(', ') + '.',
    inputSchema: {
      id: z.string().describe('ID du deal'),
      type: z.enum(['call', 'email', 'proposal', 'meeting', 'contract', 'custom']).describe('Type de tâche'),
      label: z.string().optional().describe('Libellé de la tâche (optionnel)'),
      due_at: z.string().optional().describe('Échéance ISO/YYYY-MM-DD (optionnel)'),
    },
  },
  async ({ id, type, label, due_at }) => {
    let dueIso = null;
    if (due_at) {
      const d = new Date(due_at);
      if (isNaN(d.getTime())) throw new Error('due_at invalide');
      dueIso = d.toISOString();
    }
    const existing = await readMeta(id, 'tasks');
    const tasks = Array.isArray(existing?.tasks) ? existing.tasks : [];
    const task = {
      id: `${Date.now().toString(36)}${Math.floor(0).toString(36)}${tasks.length}`,
      type, label: (label || '').trim(), due_at: dueIso,
      status: 'todo', created_at: new Date().toISOString(), done_at: null,
    };
    tasks.push(task);
    await upsertMeta({ deal_id: String(id), tasks });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, task }, null, 2) }] };
  }
);

// --- Assigner un deal / prochain RDV (Supabase) ---
server.registerTool(
  'assign_deal',
  {
    title: 'Assigner un deal / définir le prochain RDV',
    description: "Assigne un deal (Guillaume, Vincent, Nathan, ou null pour désassigner) et/ou fixe le prochain RDV (Supabase, réversible).",
    inputSchema: {
      id: z.string().describe('ID du deal'),
      assignee: z.string().nullable().optional().describe("Guillaume | Vincent | Nathan | null (désassigner)"),
      next_meeting_at: z.string().nullable().optional().describe("Prochain RDV ISO/YYYY-MM-DD, ou null pour effacer"),
    },
  },
  async ({ id, assignee, next_meeting_at }) => {
    const update = { deal_id: String(id) };
    if (assignee !== undefined) {
      if (assignee === null || assignee === '') update.assignee = null;
      else if (ALLOWED_ASSIGNEES.includes(assignee)) update.assignee = assignee;
      else throw new Error(`assignee invalide. Valeurs: ${ALLOWED_ASSIGNEES.join(', ')} ou null`);
    }
    if (next_meeting_at !== undefined) {
      if (next_meeting_at === null || next_meeting_at === '') update.next_meeting_at = null;
      else {
        const d = new Date(next_meeting_at);
        if (isNaN(d.getTime())) throw new Error('next_meeting_at invalide');
        update.next_meeting_at = d.toISOString();
      }
    }
    if (Object.keys(update).length === 1) throw new Error('Fournir assignee et/ou next_meeting_at.');
    await upsertMeta(update);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id, assignee: update.assignee, next_meeting_at: update.next_meeting_at }, null, 2) }] };
  }
);

// --- Démarrage ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp-deals] serveur prêt (stdio)');
}

// Le transport stdio ne démarre QUE si le fichier est lancé directement (`node mcp/deals-server.js`).
// Chargé via require(), il expose ses fonctions internes sans ouvrir de transport : c'est ce qui
// permet de mesurer et de tester la logique de collecte hors Claude Desktop.
if (require.main === module) {
  main().catch((e) => {
    console.error('[mcp-deals] erreur fatale:', e);
    process.exit(1);
  });
}

module.exports = {
  MCP_SERVER_VERSION,
  compareVersions,
  versionStamp,
  KANBAN_STAGES,
  loadStageProbabilities,
  invalidateMetaCache,
  dormancyMeta,
  loadMetaByDeal,
  loadTagsByDeal,
  collectTasks,
  collectOverdueDeals,
  collectUpcomingMeetings,
  fetchDealInfos,
  searchAll,
};
