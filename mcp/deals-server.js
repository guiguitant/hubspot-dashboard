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

// Stages du pipeline "default" suivis dans le kanban (miroir de server.js:467)
const KANBAN_STAGES = [
  { id: 'qualifiedtobuy', label: 'RDV Qualif', probability: 30 },
  { id: 'presentationscheduled', label: 'RDV Propale', probability: 50 },
  { id: 'decisionmakerboughtin', label: 'Négociation', probability: 60 },
  { id: 'contractsent', label: 'Contrat envoyé', probability: 80 },
  { id: '2077692138', label: 'À relancer plus tard', probability: 20, forecast: false },
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
}

// Récupère tous les résultats d'une recherche en suivant la pagination.
async function searchAll(body) {
  const all = [];
  let after;
  while (true) {
    const b = after ? { ...body, after } : body;
    const result = await hubspotSearch(b);
    if (result.results) all.push(...result.results);
    if (result.paging && result.paging.next && result.paging.next.after) {
      after = result.paging.next.after;
    } else break;
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

// =====================================================================
//  Serveur MCP
// =====================================================================
const server = new McpServer({ name: 'releaf-deals', version: '1.0.0' });

// --- Outil 1 : pipeline des deals ouverts (qualitatif) ---
server.registerTool(
  'get_pipeline',
  {
    title: 'Pipeline des deals ouverts',
    description:
      "Renvoie tous les deals OUVERTS du pipeline 'default', groupés par stage, " +
      "avec montant, dates, description ET tags (EPD, Bilan carbone, Web app, ACV…). " +
      "À utiliser pour les questions qualitatives : quels deals relancer, lesquels sont à risque, " +
      "où en est le pipeline, répartition par offre/tag. Forecast pondéré inclus. " +
      "Filtrer par tag avec l'argument 'tag' (ex 'EPD').",
    inputSchema: {
      tag: z.string().optional().describe("Ne garder que les deals portant ce tag, ex 'EPD' (optionnel, insensible à la casse)"),
    },
  },
  async ({ tag }) => {
    const [deals, tagsByDeal] = await Promise.all([
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
      loadTagsByDeal(),
    ]);

    const byStage = {};
    const byTag = {};
    let weightedForecast = 0;
    let totalAmount = 0;
    let kept = 0;
    for (const stage of KANBAN_STAGES) byStage[stage.label] = { count: 0, amount: 0, deals: [] };

    for (const d of deals) {
      const stage = KANBAN_STAGES.find((s) => s.id === d.properties.dealstage);
      if (!stage) continue;
      const tags = tagsByDeal.get(String(d.id)) || [];
      if (!hasTag(tags, tag)) continue;
      const amount = parseFloat(d.properties.amount) || 0;
      kept++;
      byStage[stage.label].count++;
      byStage[stage.label].amount += amount;
      byStage[stage.label].deals.push({
        id: d.id,
        name: d.properties.dealname || 'Sans nom',
        amount,
        tags,
        createdate: d.properties.createdate || null,
        closedate: d.properties.closedate || null,
        description: d.properties.description || '',
      });
      for (const tg of tags) {
        if (!byTag[tg]) byTag[tg] = { count: 0, amount: 0 };
        byTag[tg].count++;
        byTag[tg].amount += amount;
      }
      totalAmount += amount;
      if (stage.forecast !== false) weightedForecast += amount * (stage.probability / 100);
    }

    const summary = {
      filter_tag: tag || null,
      open_deals: kept,
      total_amount: totalAmount,
      total_amount_label: fmtEUR(totalAmount),
      weighted_forecast: Math.round(weightedForecast),
      weighted_forecast_label: fmtEUR(weightedForecast),
      by_stage: Object.fromEntries(
        KANBAN_STAGES.map((s) => [s.label, { count: byStage[s.label].count, amount: byStage[s.label].amount }])
      ),
      by_tag: byTag,
    };

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
    const [deals, tagsByDeal] = await Promise.all([
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
      loadTagsByDeal(),
    ]);

    let won = { count: 0, amount: 0, deals: [] };
    let lost = { count: 0, amount: 0, deals: [] };
    const byTag = {};
    let closedWithTag = 0;
    let closedTotalInPeriod = 0;

    for (const d of deals) {
      const tags = tagsByDeal.get(String(d.id)) || [];
      closedTotalInPeriod++;
      if (tags.length) closedWithTag++;
      if (!hasTag(tags, tag)) continue;
      const amount = parseFloat(d.properties.amount) || 0;
      const isWon = d.properties.hs_is_closed_won === 'true' || d.properties.dealstage === 'closedwon';
      const bucket = isWon ? won : lost;
      bucket.count++;
      bucket.amount += amount;
      bucket.deals.push({ id: d.id, name: d.properties.dealname || 'Sans nom', amount, tags, closedate: d.properties.closedate || null });
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
main().catch((e) => {
  console.error('[mcp-deals] erreur fatale:', e);
  process.exit(1);
});
