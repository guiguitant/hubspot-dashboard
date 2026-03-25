require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const app = express();
const PORT = process.env.PORT || 3000;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;

if (!HUBSPOT_API_KEY) {
  console.error('HUBSPOT_API_KEY manquante. Définissez-la dans .env ou en variable d\'environnement.');
  process.exit(1);
}

// Detect EU tokens (contains "eu1" in the token)
const IS_EU = HUBSPOT_API_KEY.includes('eu1');
const HUBSPOT_HOST = IS_EU ? 'api-eu1.hubapi.com' : 'api.hubapi.com';

// Detect auth mode: pat-* tokens use Bearer, others use hapikey query param
const IS_PAT = HUBSPOT_API_KEY.startsWith('pat-');

console.log(`API HubSpot: https://${HUBSPOT_HOST} | Auth: ${IS_PAT ? 'Bearer token' : 'API key (hapikey)'}`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- HubSpot API helpers ---

function addAuth(options, urlPath) {
  if (IS_PAT) {
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${HUBSPOT_API_KEY}`;
    return urlPath;
  }
  // Legacy API key: append as query parameter
  const separator = urlPath.includes('?') ? '&' : '?';
  return urlPath + separator + 'hapikey=' + HUBSPOT_API_KEY;
}

function hubspotRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `https://${HUBSPOT_HOST}`);
    let reqPath = url.pathname + url.search;
    const options = {
      hostname: HUBSPOT_HOST,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    reqPath = addAuth(options, reqPath);
    options.path = reqPath;

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Réponse HubSpot invalide')); }
        } else {
          reject(new Error(`HubSpot API ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
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
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Réponse HubSpot invalide')); }
        } else {
          reject(new Error(`HubSpot Search API ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Fetch all closed-won deals with pagination ---
async function fetchClosedWonDeals() {
  const allDeals = [];
  let after = undefined;

  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'hs_is_closed_won',
              operator: 'EQ',
              value: 'true',
            },
          ],
        },
      ],
      properties: ['dealname', 'amount', 'closedate', 'dealstage', 'pipeline', 'hs_is_closed_won'],
      limit: 100,
    };
    if (after) body.after = after;

    const result = await hubspotSearch(body);
    if (result.results) allDeals.push(...result.results);

    if (result.paging && result.paging.next && result.paging.next.after) {
      after = result.paging.next.after;
    } else {
      break;
    }
  }

  return allDeals;
}

// --- Fetch open deals count ---
async function fetchOpenDealsCount() {
  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'hs_is_closed',
            operator: 'EQ',
            value: 'false',
          },
        ],
      },
    ],
    properties: ['dealname', 'amount'],
    limit: 1,
  };

  const result = await hubspotSearch(body);
  return result.total || 0;
}

// --- Fetch pipeline stages ---
async function fetchPipelineStages() {
  const data = await hubspotRequest('/crm/v3/pipelines/deals');
  const stages = {};
  if (data.results) {
    for (const pipeline of data.results) {
      if (pipeline.stages) {
        for (const stage of pipeline.stages) {
          stages[stage.id] = stage.label;
        }
      }
    }
  }
  return stages;
}

// --- Target pipeline stages for kanban ---
const KANBAN_STAGES = [
  { id: 'qualifiedtobuy', label: 'RDV Qualif', probability: 30 },
  { id: 'presentationscheduled', label: 'RDV Propale', probability: 50 },
  { id: 'decisionmakerboughtin', label: 'Négociation', probability: 60 },
  { id: 'contractsent', label: 'Contrat envoyé', probability: 80 },
];

// --- Fetch open deals for pipeline kanban ---
async function fetchOpenDeals() {
  const allDeals = [];
  let after = undefined;
  const stageIds = KANBAN_STAGES.map(s => s.id);

  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
            { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          ],
        },
      ],
      properties: ['dealname', 'amount', 'dealstage', 'closedate'],
      limit: 100,
    };
    if (after) body.after = after;

    const result = await hubspotSearch(body);
    if (result.results) allDeals.push(...result.results);

    if (result.paging && result.paging.next && result.paging.next.after) {
      after = result.paging.next.after;
    } else {
      break;
    }
  }

  // Group by stage, only keep target stages
  const pipelineDeals = {};
  for (const stage of KANBAN_STAGES) {
    pipelineDeals[stage.label] = [];
  }

  for (const deal of allDeals) {
    const stageId = deal.properties.dealstage;
    const stageInfo = KANBAN_STAGES.find(s => s.id === stageId);
    if (!stageInfo) continue;

    pipelineDeals[stageInfo.label].push({
      id: deal.id,
      name: deal.properties.dealname || 'Sans nom',
      amount: parseFloat(deal.properties.amount) || 0,
      probability: stageInfo.probability,
    });
  }

  return pipelineDeals;
}

// --- Aggregate revenue by month/year ---
function aggregateByMonth(deals) {
  const monthly = {};

  for (const deal of deals) {
    const amount = parseFloat(deal.properties.amount) || 0;
    const closeDate = deal.properties.closedate;
    if (!closeDate || amount === 0) continue;

    const date = new Date(closeDate);
    const year = date.getFullYear();
    const month = date.getMonth(); // 0-11

    const key = `${year}-${month}`;
    if (!monthly[key]) {
      monthly[key] = { year, month, total: 0, count: 0, deals: [] };
    }
    monthly[key].total += amount;
    monthly[key].count += 1;
    monthly[key].deals.push({
      name: deal.properties.dealname || 'Sans nom',
      amount,
    });
  }

  return monthly;
}

// --- Main dashboard endpoint ---
app.get('/api/dashboard', async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const previousYear = currentYear - 1;

    const [deals, openDealsCount, stages, pipelineDeals] = await Promise.all([
      fetchClosedWonDeals(),
      fetchOpenDealsCount(),
      fetchPipelineStages(),
      fetchOpenDeals(),
    ]);

    const monthly = aggregateByMonth(deals);

    // Hardcoded 2025 data (import HubSpot faussé)
    const hardcoded2025 = [0, 0, 109400, 53500, 24500, 69500, 29000, 0, 36000, 48900, 55000, 0];
    for (let m = 0; m < 12; m++) {
      const key = `2025-${m}`;
      monthly[key] = {
        year: 2025,
        month: m,
        total: hardcoded2025[m],
        count: 0,
        deals: [],
      };
    }

    // Build monthly arrays for a given year
    const buildYearData = (year) => {
      const months = [];
      for (let m = 0; m < 12; m++) {
        const key = `${year}-${m}`;
        months.push({
          month: m,
          label: new Date(year, m).toLocaleDateString('fr-FR', { month: 'long' }),
          total: monthly[key] ? Math.round(monthly[key].total * 100) / 100 : 0,
          count: monthly[key] ? monthly[key].count : 0,
          deals: monthly[key] ? monthly[key].deals : [],
        });
      }
      return months;
    };

    // Gather all available years
    const availableYears = [...new Set(Object.values(monthly).map((m) => m.year))].sort((a, b) => b - a);

    // Build data for all available years
    const yearlyData = {};
    for (const year of availableYears) {
      yearlyData[year] = buildYearData(year);
    }

    // Ensure current and previous year exist
    if (!yearlyData[currentYear]) yearlyData[currentYear] = buildYearData(currentYear);
    if (!yearlyData[previousYear]) yearlyData[previousYear] = buildYearData(previousYear);

    // Calculate KPIs for current year
    const currentYearData = yearlyData[currentYear];
    const previousYearData = yearlyData[previousYear];
    const currentMonth = new Date().getMonth();

    const caYTD = currentYearData.slice(0, currentMonth + 1).reduce((s, m) => s + m.total, 0);
    const caYTDPrev = previousYearData.slice(0, currentMonth + 1).reduce((s, m) => s + m.total, 0);
    const deltaVsN1 = caYTDPrev > 0 ? ((caYTD - caYTDPrev) / caYTDPrev) * 100 : (caYTD > 0 ? 100 : 0);

    const bestMonth = currentYearData.reduce(
      (best, m) => (m.total > best.total ? m : best),
      { total: 0, label: '-' }
    );

    res.json({
      currentYear,
      previousYear,
      availableYears,
      yearlyData,
      kpis: {
        caYTD: Math.round(caYTD * 100) / 100,
        deltaVsN1: Math.round(deltaVsN1 * 10) / 10,
        bestMonth: { label: bestMonth.label, total: Math.round(bestMonth.total * 100) / 100 },
        openDeals: openDealsCount,
      },
      stages,
      pipelineDeals,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur dashboard:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Notion API ---
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_MISSIONS_DB = process.env.NOTION_MISSIONS_DB;

if (!NOTION_API_KEY || !NOTION_MISSIONS_DB) {
  console.warn('⚠ NOTION_API_KEY ou NOTION_MISSIONS_DB manquante — les endpoints Notion ne fonctionneront pas.');
}

function notionRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, 'https://api.notion.com');
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Réponse Notion invalide')); }
        } else {
          reject(new Error(`Notion API ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// --- Google Sheets CSV ---
const GSHEET_PUBLISHED_ID = '2PACX-1vQVkfg9jVxUTYGkLCs5xgXRuowmXEMZ8h2TT0kDfhbpQQugS1lgB729gbXbWJ5uEBK6CZ3E0DWJ9ijM';
const CRPREV_GID = '1891894048';

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const follow = (targetUrl) => {
      const parsed = new URL(targetUrl);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      };
      const req = https.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => res.statusCode < 400 ? resolve(data) : reject(new Error(`CSV ${res.statusCode}`)));
      });
      req.on('error', reject);
      req.end();
    };
    follow(url);
  });
}

function parseCsvCRPrev(text) {
  const rows = [];
  let current = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { current.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        current.push(field); field = '';
        rows.push(current); current = [];
      } else field += ch;
    }
  }
  if (field || current.length) { current.push(field); rows.push(current); }
  return rows;
}

let crPrevCache = null;
let crPrevCacheTime = 0;
const CRPREV_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchAndParseCRPrev() {
  if (crPrevCache && (Date.now() - crPrevCacheTime) < CRPREV_CACHE_TTL) return crPrevCache;

  const url = `https://docs.google.com/spreadsheets/d/e/${GSHEET_PUBLISHED_ID}/pub?output=csv&gid=${CRPREV_GID}`;
  const csvText = await fetchCSV(url);
  const rows = parseCsvCRPrev(csvText);

  console.log('[CRPrev] Lignes parsées:', rows.length);
  console.log('[CRPrev] 5 premières lignes col0:', rows.slice(0, 5).map(r => JSON.stringify(r[0])));

  // Trouver la ligne contenant les mois (format MM/YYYY)
  let monthRowIdx = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const found = rows[i].some(cell => /^\d{2}\/\d{4}$/.test(cell.trim()));
    console.log(`[CRPrev] Ligne ${i}:`, rows[i].slice(0, 4).map(c => JSON.stringify(c)), '→ mois?', found);
    if (found) { monthRowIdx = i; break; }
  }
  if (monthRowIdx === -1) throw new Error('Structure CR_Prév non reconnue');

  const monthRow = rows[monthRowIdx];

  // Colonnes Budget (colonnes avec format MM/YYYY, les colonnes TVA sont entre elles)
  const budgetCols = [];
  for (let c = 0; c < monthRow.length; c++) {
    const cell = monthRow[c].trim();
    if (/^\d{2}\/\d{4}$/.test(cell)) {
      const [mm, yyyy] = cell.split('/');
      budgetCols.push({ index: c, key: `${yyyy}-${mm}` });
    }
  }

  // Lignes à ignorer (totaux, en-têtes, lignes CA)
  const SKIP_PATTERNS = [
    /^$/,
    /^compte de résultat/i,
    /^total chiffre d'affaires/i,
    /^total charges/i,
    /^résultat d'exploitation/i,
    /^chiffre d'affaires/i,
    /^enc\./i,                  // Enc. Acompte / Enc. Solde (CA)
    /^budget$/i,
    /^tva$/i,
    /^calcul de/i,
  ];
  const shouldSkip = (name) => SKIP_PATTERNS.some(p => p.test(name));

  // categories    : { "Frais de personnel": { "2025-01": 15000, ... } }  — totaux par catégorie mère
  // subCategories : { "Frais de personnel": { "Salaires nets": { "2025-01": 4810 } } }
  const categories    = {};
  const subCategories = {};
  let currentParent   = null;

  for (let r = monthRowIdx + 2; r < rows.length; r++) {
    const row = rows[r];
    const rawName = (row[2] || row[0] || '').trim();
    if (shouldSkip(rawName)) continue;

    if (rawName.toLowerCase().startsWith('cm.')) {
      // Catégorie mère — strip le préfixe pour l'affichage
      currentParent = rawName.slice(3).trim();
      if (!categories[currentParent])    categories[currentParent]    = {};
      if (!subCategories[currentParent]) subCategories[currentParent] = {};
      continue;
    }

    // Sous-catégorie
    const catName = rawName;
    if (!catName) continue;
    const parent = currentParent || catName; // fallback si pas de parent détecté

    for (const { index, key } of budgetCols) {
      const raw = (row[index] || '').trim().replace(/[€\s\u00A0]/g, '').replace(',', '.');
      const val = parseFloat(raw) || 0;
      if (val !== 0) {
        if (!categories[parent]) categories[parent] = {};
        categories[parent][key] = (categories[parent][key] || 0) + val;
        if (currentParent) {
          if (!subCategories[parent][catName]) subCategories[parent][catName] = {};
          subCategories[parent][catName][key] = (subCategories[parent][catName][key] || 0) + val;
        }
      }
    }
  }

  crPrevCache = { budgetCols, categories, subCategories };
  crPrevCacheTime = Date.now();
  return crPrevCache;
}

let notionMissionsCache = null;
let notionMissionsCacheTime = 0;
const NOTION_MISSIONS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchAllNotionMissions() {
  if (notionMissionsCache && (Date.now() - notionMissionsCacheTime) < NOTION_MISSIONS_CACHE_TTL) {
    return notionMissionsCache;
  }

  const allPages = [];
  let startCursor = undefined;

  while (true) {
    const body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;

    const result = await notionRequest(`/v1/databases/${NOTION_MISSIONS_DB}/query`, 'POST', body);
    if (result.results) allPages.push(...result.results);

    if (result.has_more && result.next_cursor) {
      startCursor = result.next_cursor;
    } else {
      break;
    }
  }

  const result = allPages.map(page => {
    const props = page.properties;
    return {
      id: page.id,
      nom: props['Nom du projet'] && props['Nom du projet'].title
        ? props['Nom du projet'].title.map(t => t.plain_text).join('') : 'Sans nom',
      client: props['Nom du client'] && props['Nom du client'].rich_text
        ? props['Nom du client'].rich_text.map(t => t.plain_text).join('') : '',
      ca: props['CA mission'] ? props['CA mission'].number || 0 : 0,
      etat: props['État'] && props['État'].status ? props['État'].status.name : 'Non défini',
      dates: props['Dates'] && props['Dates'].date ? props['Dates'].date : null,
      anneeFinal: props['Année final'] && props['Année final'].formula
        ? props['Année final'].formula.string || '' : '',
      facturation: props['Facturation'] && props['Facturation'].status
        ? props['Facturation'].status.name : 'Non défini',
      montantAcompte: props['Montant acompte'] && props['Montant acompte'].formula
        ? props['Montant acompte'].formula.number || 0 : 0,
      montantFinal: props['Montant final'] && props['Montant final'].formula
        ? props['Montant final'].formula.number || 0 : 0,
      resteAFacturer: props['Reste à facturer'] && props['Reste à facturer'].formula
        ? props['Reste à facturer'].formula.number || 0 : 0,
      dateFactureAcompte: props['émission facture acompte'] && props['émission facture acompte'].date
        ? props['émission facture acompte'].date.start : null,
      dateFactureFinale: props['émission facture finale'] && props['émission facture finale'].date
        ? props['émission facture finale'].date.start : null,
      jrsAcompteRetard: props['Nb_jrs_acompte_retard'] && props['Nb_jrs_acompte_retard'].formula
        ? props['Nb_jrs_acompte_retard'].formula.number || 0 : 0,
      jrsSoldeRetard: props['Nb_jrs_solde_retard'] && props['Nb_jrs_solde_retard'].formula
        ? props['Nb_jrs_solde_retard'].formula.number || 0 : 0,
      natureMission: props['Nature_mission'] && props['Nature_mission'].select
        ? props['Nature_mission'].select.name : 'Non défini',
      acquisition: props['Acquisition'] && props['Acquisition'].select
        ? props['Acquisition'].select.name : 'Non défini',
      typeCa: props['type_ca'] && props['type_ca'].select
        ? props['type_ca'].select.name : 'Non défini',
      subventionne: props['CA Subventionné ?'] && props['CA Subventionné ?'].formula
        ? props['CA Subventionné ?'].formula.string || 'Non' : 'Non',
    };
  });

  notionMissionsCache = result;
  notionMissionsCacheTime = Date.now();
  return notionMissionsCache;
}

// --- Fuzzy string matching ---
function normalize(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigramSimilarity(a, b) {
  const bigrams = (s) => {
    const set = [];
    for (let i = 0; i < s.length - 1; i++) set.push(s.slice(i, i + 2));
    return set;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return 0;
  let matches = 0;
  const used = new Set();
  for (const bg of ba) {
    const idx = bb.findIndex((x, i) => !used.has(i) && x === bg);
    if (idx >= 0) { matches++; used.add(idx); }
  }
  return (2 * matches) / (ba.length + bb.length);
}

function wordJaccard(a, b) {
  const wa = new Set(a.split(' ').filter(w => w.length > 1));
  const wb = new Set(b.split(' ').filter(w => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

function wordFuzzyMatch(a, b) {
  const wa = a.split(' ').filter(w => w.length > 1);
  const wb = b.split(' ').filter(w => w.length > 1);
  if (wa.length === 0 || wb.length === 0) return 0;
  let matched = 0;
  const used = new Set();
  for (const w1 of wa) {
    let bestSim = 0, bestIdx = -1;
    for (let j = 0; j < wb.length; j++) {
      if (used.has(j)) continue;
      const sim = bigramSimilarity(w1, wb[j]);
      if (sim > bestSim) { bestSim = sim; bestIdx = j; }
    }
    if (bestSim >= 0.6 && bestIdx >= 0) { matched++; used.add(bestIdx); }
  }
  return matched / Math.max(wa.length, wb.length);
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    return 0.8 + 0.2 * ratio;
  }

  const bigram = bigramSimilarity(na, nb);
  const jaccard = wordJaccard(na, nb);
  const fuzzyWord = wordFuzzyMatch(na, nb);

  return Math.max(bigram, jaccard, fuzzyWord * 0.95);
}

function combinedScore(hsName, hsAmount, notionNom, notionClient, notionCa) {
  const scoreNom = similarity(hsName, notionNom);
  const scoreClient = notionClient ? similarity(hsName, notionClient) : 0;
  const nameSim = Math.max(scoreNom, scoreClient * 0.9);

  let amountBonus = 0;
  if (hsAmount > 0 && notionCa > 0) {
    const amtRatio = Math.min(hsAmount, notionCa) / Math.max(hsAmount, notionCa);
    if (amtRatio > 0.95) amountBonus = 0.1;
    else if (amtRatio > 0.8) amountBonus = 0.05;
  }

  return { total: Math.min(nameSim + amountBonus, 1), nameSim };
}

// --- Fetch closed-won deals for a specific year ---
async function fetchClosedWonDealsForYear(year) {
  const allDeals = [];
  let after = undefined;

  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' },
            { propertyName: 'closedate', operator: 'GTE', value: `${year}-01-01T00:00:00.000Z` },
            { propertyName: 'closedate', operator: 'LT', value: `${year + 1}-01-01T00:00:00.000Z` },
          ],
        },
      ],
      properties: ['dealname', 'amount', 'closedate'],
      limit: 100,
    };
    if (after) body.after = after;

    const result = await hubspotSearch(body);
    if (result.results) allDeals.push(...result.results);

    if (result.paging && result.paging.next && result.paging.next.after) {
      after = result.paging.next.after;
    } else {
      break;
    }
  }

  return allDeals;
}

// --- Fetch Notion missions for a specific year (uses "Année final" formula) ---
async function fetchNotionMissionsForYear(year) {
  const allMissions = await fetchAllNotionMissions();
  return allMissions.filter(m => {
    return m.anneeFinal === String(year);
  });
}

// --- Reconciliation endpoint ---
app.get('/api/reconciliation', async (req, res) => {
  try {
    const RECON_YEAR = new Date().getFullYear();

    const [hubspotDeals, notionMissions] = await Promise.all([
      fetchClosedWonDealsForYear(RECON_YEAR),
      fetchNotionMissionsForYear(RECON_YEAR),
    ]);

    const hsDeals = hubspotDeals.map(d => ({
      id: d.id,
      name: d.properties.dealname || 'Sans nom',
      amount: parseFloat(d.properties.amount) || 0,
      closedate: d.properties.closedate || null,
    }));

    // Build full score matrix
    const THRESHOLD = 0.45;
    const scoreMatrix = [];
    for (let h = 0; h < hsDeals.length; h++) {
      scoreMatrix[h] = [];
      for (let n = 0; n < notionMissions.length; n++) {
        const nm = notionMissions[n];
        const { total, nameSim } = combinedScore(
          hsDeals[h].name, hsDeals[h].amount,
          nm.nom, nm.client, nm.ca
        );
        scoreMatrix[h][n] = { total, nameSim };
      }
    }

    // Optimal matching: iteratively pick the best global pair
    const usedHS = new Set();
    const usedNotion = new Set();
    const pairs = [];

    // Collect all candidate pairs above threshold, sorted by score desc
    const candidates = [];
    for (let h = 0; h < hsDeals.length; h++) {
      for (let n = 0; n < notionMissions.length; n++) {
        if (scoreMatrix[h][n].total >= THRESHOLD) {
          candidates.push({ h, n, score: scoreMatrix[h][n].total, nameSim: scoreMatrix[h][n].nameSim });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    for (const c of candidates) {
      if (usedHS.has(c.h) || usedNotion.has(c.n)) continue;
      usedHS.add(c.h);
      usedNotion.add(c.n);
      pairs.push(c);
    }

    const matched = pairs.map(p => {
      const hs = hsDeals[p.h];
      const nm = notionMissions[p.n];
      const amountDiff = hs.amount - nm.ca;
      return {
        hubspot: { name: hs.name, amount: hs.amount, closedate: hs.closedate },
        notion: { nom: nm.nom, client: nm.client, ca: nm.ca, etat: nm.etat },
        score: Math.round(p.nameSim * 100),
        amountMatch: nm.ca > 0 ? Math.abs(amountDiff) < 1 : false,
        amountDiff,
      };
    });

    const hsOnly = hsDeals
      .filter((_, i) => !usedHS.has(i))
      .map(d => ({ name: d.name, amount: d.amount, closedate: d.closedate }));

    const notionOnly = notionMissions
      .filter((_, i) => !usedNotion.has(i))
      .map(nm => ({ nom: nm.nom, client: nm.client, ca: nm.ca, etat: nm.etat }));

    res.json({
      year: RECON_YEAR,
      matched,
      hubspotOnly: hsOnly,
      notionOnly,
      stats: {
        totalHubspot: hsDeals.length,
        totalNotion: notionMissions.length,
        matched: matched.length,
        hubspotOnly: hsOnly.length,
        notionOnly: notionOnly.length,
        amountMismatches: matched.filter(m => !m.amountMatch && m.notion.ca > 0).length,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur réconciliation:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Facturation endpoint ---
app.get('/api/facturation', async (req, res) => {
  try {
    const allMissions = await fetchAllNotionMissions();
    // Toutes les missions (sans filtre d'année)
    const missions = allMissions;

    const result = missions.map(m => {
      // Calcul du reste à facturer basé sur le statut de facturation
      const status = (m.facturation || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      let resteAFacturer;
      if (status.includes('solde paye') || status.includes('solde envoye')) {
        resteAFacturer = 0;
      } else if (status.includes('acompte paye') || status.includes('solde a envoyer')) {
        resteAFacturer = m.ca - m.montantAcompte;
      } else {
        // Acompte à envoyer / Acompte envoyé / Non défini
        resteAFacturer = m.ca;
      }

      return {
      nom: m.nom,
      client: m.client,
      ca: m.ca,
      etat: m.etat,
      facturation: m.facturation,
      montantAcompte: m.montantAcompte,
      montantFinal: m.montantFinal,
      resteAFacturer,
      dateFactureAcompte: m.dateFactureAcompte,
      dateFactureFinale: m.dateFactureFinale,
      anneeFinal: m.anneeFinal,
      jrsAcompteRetard: m.jrsAcompteRetard,
      jrsSoldeRetard: m.jrsSoldeRetard,
    };
    });

    res.json({
      year: new Date().getFullYear(),
      missions: result,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur facturation:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Pennylane API ---
const PENNYLANE_API_TOKEN = process.env.PENNYLANE_API_TOKEN;

if (!PENNYLANE_API_TOKEN) {
  console.warn('⚠ PENNYLANE_API_TOKEN manquante — les endpoints Pennylane ne fonctionneront pas.');
}

function pennylaneRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, 'https://app.pennylane.com');
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'app.pennylane.com',
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${PENNYLANE_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Réponse Pennylane invalide')); }
        } else {
          reject(new Error(`Pennylane API ${res.statusCode}: ${data.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Paginated fetch for Pennylane (cursor-based pagination, max 20 items/page)
// maxPages limits total pages to avoid timeout on large datasets
async function pennylaneFetchAll(endpoint, params = {}, maxPages = 200) {
  const allItems = [];
  let cursor = null;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const queryParams = new URLSearchParams(params);
    if (cursor) queryParams.set('cursor', cursor);
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `/api/external/v2${endpoint}${queryParams.toString() ? sep + queryParams.toString() : ''}`;

    let result;
    try {
      result = await pennylaneRequest(url);
    } catch (err) {
      // Retry once on connection reset (rate limit)
      console.warn(`Pennylane retry after error: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000));
      result = await pennylaneRequest(url);
    }

    const items = result.items || [];
    if (Array.isArray(items)) {
      allItems.push(...items);
    }

    pageCount++;

    if (result.has_more && result.next_cursor) {
      cursor = result.next_cursor;
    } else {
      break;
    }

    // Rate limit: 25 req/5s — delay 400ms between requests for safety
    await new Promise(r => setTimeout(r, 400));
  }

  return allItems;
}

// --- Frais KM ---
const OPENROUTESERVICE_API_KEY = process.env.OPENROUTESERVICE_API_KEY;
const ORIGIN_ADDRESS = '2 rue de la Carnoy, 59130 Lambersart';
const KM_RATE = 0.665;

function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      api_key: OPENROUTESERVICE_API_KEY,
      text: address,
      'boundary.country': 'FR',
      size: '1',
    });
    const options = {
      hostname: 'api.openrouteservice.org',
      path: '/geocode/search?' + params.toString(),
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.features && json.features.length > 0) {
            const coords = json.features[0].geometry.coordinates; // [lon, lat]
            resolve(coords);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function orsMatrixRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.openrouteservice.org',
      path: '/v2/matrix/driving-car',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': OPENROUTESERVICE_API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`ORS Matrix ${res.statusCode}: ${JSON.stringify(json).substring(0, 300)}`));
          }
        } catch (e) {
          reject(new Error('ORS Matrix: réponse invalide'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// GET /api/analyse-clients — données enrichies pour analyse
app.get('/api/analyse-clients', async (req, res) => {
  try {
    const { data, error } = await supabase.from('clients_km').select('*');
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/frais-km/clients — lecture rapide depuis Supabase
app.get('/api/frais-km/clients', async (req, res) => {
  try {
    const { data, error } = await supabase.from('clients_km').select('*').order('distance_km_ar', { ascending: false });
    if (error) throw new Error(error.message);
    const results = (data || []).map(c => ({
      id: c.pennylane_id,
      name: c.name,
      address: c.address,
      distanceKmAR: c.distance_km_ar,
      montantAR: c.montant_ar,
    }));
    res.json(results);
  } catch (err) {
    console.error('Erreur frais-km/clients:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Lookup entreprise par SIRET via API gouv
function lookupEntreprise(siret) {
  return new Promise((resolve) => {
    if (!siret || siret.length < 9) return resolve(null);
    const siren = siret.replace(/\s/g, '').substring(0, 9);
    const options = {
      hostname: 'recherche-entreprises.api.gouv.fr',
      path: '/search?q=' + encodeURIComponent(siren) + '&per_page=1',
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.results && json.results.length > 0) {
            const r = json.results[0];
            const sectionLabels = {
              'A':'Agriculture','B':'Industries extractives','C':'Industrie manufacturiere','D':'Electricite, gaz','E':'Eau, dechets',
              'F':'Construction','G':'Commerce','H':'Transport, entreposage','I':'Hebergement, restauration','J':'Information, communication',
              'K':'Finance, assurance','L':'Immobilier','M':'Activites scientifiques, techniques','N':'Services administratifs',
              'O':'Administration publique','P':'Enseignement','Q':'Sante, action sociale','R':'Arts, spectacles','S':'Autres services',
              'T':'Activites menageres','U':'Organisations extraterritoriales',
            };
            const section = r.section_activite_principale || '';
            resolve({
              code_naf: r.activite_principale || '',
              secteur: sectionLabels[section] || section,
            });
          } else {
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Département → Région
const DEPT_REGION = {
  '01':'Auvergne-Rhône-Alpes','03':'Auvergne-Rhône-Alpes','07':'Auvergne-Rhône-Alpes','15':'Auvergne-Rhône-Alpes','26':'Auvergne-Rhône-Alpes','38':'Auvergne-Rhône-Alpes','42':'Auvergne-Rhône-Alpes','43':'Auvergne-Rhône-Alpes','63':'Auvergne-Rhône-Alpes','69':'Auvergne-Rhône-Alpes','73':'Auvergne-Rhône-Alpes','74':'Auvergne-Rhône-Alpes',
  '21':'Bourgogne-Franche-Comté','25':'Bourgogne-Franche-Comté','39':'Bourgogne-Franche-Comté','58':'Bourgogne-Franche-Comté','70':'Bourgogne-Franche-Comté','71':'Bourgogne-Franche-Comté','89':'Bourgogne-Franche-Comté','90':'Bourgogne-Franche-Comté',
  '22':'Bretagne','29':'Bretagne','35':'Bretagne','56':'Bretagne',
  '18':'Centre-Val de Loire','28':'Centre-Val de Loire','36':'Centre-Val de Loire','37':'Centre-Val de Loire','41':'Centre-Val de Loire','45':'Centre-Val de Loire',
  '2A':'Corse','2B':'Corse','20':'Corse',
  '08':'Grand Est','10':'Grand Est','51':'Grand Est','52':'Grand Est','54':'Grand Est','55':'Grand Est','57':'Grand Est','67':'Grand Est','68':'Grand Est','88':'Grand Est',
  '59':'Hauts-de-France','60':'Hauts-de-France','62':'Hauts-de-France','80':'Hauts-de-France','02':'Hauts-de-France',
  '75':'Île-de-France','77':'Île-de-France','78':'Île-de-France','91':'Île-de-France','92':'Île-de-France','93':'Île-de-France','94':'Île-de-France','95':'Île-de-France',
  '14':'Normandie','27':'Normandie','50':'Normandie','61':'Normandie','76':'Normandie',
  '16':'Nouvelle-Aquitaine','17':'Nouvelle-Aquitaine','19':'Nouvelle-Aquitaine','23':'Nouvelle-Aquitaine','24':'Nouvelle-Aquitaine','33':'Nouvelle-Aquitaine','40':'Nouvelle-Aquitaine','47':'Nouvelle-Aquitaine','64':'Nouvelle-Aquitaine','79':'Nouvelle-Aquitaine','86':'Nouvelle-Aquitaine','87':'Nouvelle-Aquitaine',
  '09':'Occitanie','11':'Occitanie','12':'Occitanie','30':'Occitanie','31':'Occitanie','32':'Occitanie','34':'Occitanie','46':'Occitanie','48':'Occitanie','65':'Occitanie','66':'Occitanie','81':'Occitanie','82':'Occitanie',
  '44':'Pays de la Loire','49':'Pays de la Loire','53':'Pays de la Loire','72':'Pays de la Loire','85':'Pays de la Loire',
  '04':'Provence-Alpes-Côte d\'Azur','05':'Provence-Alpes-Côte d\'Azur','06':'Provence-Alpes-Côte d\'Azur','13':'Provence-Alpes-Côte d\'Azur','83':'Provence-Alpes-Côte d\'Azur','84':'Provence-Alpes-Côte d\'Azur',
};

function getDeptRegion(postalCode) {
  if (!postalCode) return { departement: '', region: '' };
  const dept = postalCode.substring(0, 2);
  return { departement: dept, region: DEPT_REGION[dept] || '' };
}

// POST /api/frais-km/sync — sync Pennylane → géocodage → distances → Supabase
app.post('/api/frais-km/sync', async (req, res) => {
  try {
    if (!OPENROUTESERVICE_API_KEY) {
      return res.status(500).json({ error: 'OPENROUTESERVICE_API_KEY non configurée' });
    }

    // 1. Fetch clients from Pennylane
    const customers = await pennylaneFetchAll('/customers', {});
    const clientsWithAddress = customers
      .map(c => {
        const ba = c.billing_address || {};
        const addr = [ba.address, ba.postal_code, ba.city].filter(Boolean).join(', ');
        if (!addr || addr.length < 5) return null;
        return {
          id: c.id,
          name: c.name || (c.first_name + ' ' + c.last_name),
          address: addr,
          siret: c.reg_no || '',
          postalCode: ba.postal_code || '',
        };
      })
      .filter(Boolean);

    if (clientsWithAddress.length === 0) {
      return res.json({ synced: 0, message: 'Aucun client avec adresse' });
    }

    // 2. Geocode origin
    const originCoords = await geocodeAddress(ORIGIN_ADDRESS);
    if (!originCoords) {
      return res.status(500).json({ error: 'Impossible de géocoder l\'adresse d\'origine' });
    }

    // 3. Geocode all clients (with rate limit delay)
    const geocodedClients = [];
    for (const client of clientsWithAddress) {
      await new Promise(r => setTimeout(r, 200));
      const coords = await geocodeAddress(client.address);
      if (coords) {
        geocodedClients.push({ ...client, coords });
      }
    }

    if (geocodedClients.length === 0) {
      return res.json({ synced: 0, message: 'Aucune adresse géocodable' });
    }

    // 4. Matrix distances par batch
    const BATCH_SIZE = 50;
    const results = [];

    for (let i = 0; i < geocodedClients.length; i += BATCH_SIZE) {
      const batch = geocodedClients.slice(i, i + BATCH_SIZE);
      const locations = [originCoords, ...batch.map(c => c.coords)];

      const matrix = await orsMatrixRequest({
        locations,
        metrics: ['distance'],
        sources: [0],
        destinations: Array.from({ length: batch.length }, (_, j) => j + 1),
      });

      if (matrix.distances && matrix.distances[0]) {
        batch.forEach((client, j) => {
          const distanceMeters = matrix.distances[0][j];
          const distanceKmAR = Math.round((distanceMeters / 1000) * 2 * 10) / 10;
          const montantAR = Math.round(distanceKmAR * KM_RATE * 100) / 100;
          results.push({
            pennylane_id: client.id,
            name: client.name,
            address: client.address,
            lon: client.coords[0],
            lat: client.coords[1],
            distance_km_ar: distanceKmAR,
            montant_ar: montantAR,
            updated_at: new Date().toISOString(),
          });
        });
      }

      if (i + BATCH_SIZE < geocodedClients.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 5. Enrichir avec SIRET → secteur d'activité + département/région
    const clientMap = {};
    clientsWithAddress.forEach(c => { clientMap[c.id] = c; });

    for (const r of results) {
      const orig = clientMap[r.pennylane_id];
      if (orig) {
        // Département / Région depuis le code postal
        const { departement, region } = getDeptRegion(orig.postalCode);
        r.departement = departement;
        r.region = region;
        r.siret = orig.siret;

        // Lookup secteur via API entreprises
        if (orig.siret && orig.siret.length >= 9) {
          await new Promise(resolve => setTimeout(resolve, 200)); // rate limit
          const info = await lookupEntreprise(orig.siret);
          if (info) {
            r.code_naf = info.code_naf;
            r.secteur = info.secteur;
          }
        }
      }
    }

    // 6. Upsert dans Supabase
    const { error } = await supabase.from('clients_km').upsert(results, { onConflict: 'pennylane_id' });
    if (error) throw new Error(error.message);

    res.json({ synced: results.length, message: `${results.length} clients synchronisés` });
  } catch (err) {
    console.error('Erreur frais-km/sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/frais-km/generate
app.post('/api/frais-km/generate', async (req, res) => {
  try {
    const { montant, dateDebut, dateFin } = req.body;
    if (!montant || montant <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }
    if (!dateDebut || !dateFin) {
      return res.status(400).json({ error: 'Période requise (dateDebut, dateFin)' });
    }

    // Lire les clients depuis Supabase
    const { data: dbClients, error } = await supabase.from('clients_km').select('*');
    if (error) throw new Error(error.message);

    const clients = (dbClients || []).filter(c => c.montant_ar > 0).map(c => ({
      name: c.name,
      address: c.address,
      distanceKmAR: c.distance_km_ar,
      montantAR: c.montant_ar,
    }));
    if (clients.length === 0) {
      return res.status(400).json({ error: 'Aucun client avec distance valide' });
    }

    // Calculer les jours ouvrés dans la période
    const joursOuvres = [];
    const d = new Date(dateDebut);
    const fin = new Date(dateFin);
    while (d <= fin) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) { // Lundi-Vendredi
        joursOuvres.push(new Date(d).toISOString().split('T')[0]);
      }
      d.setDate(d.getDate() + 1);
    }

    const kmCible = montant / KM_RATE;
    const tolerance = 0.05; // ±5%

    const tentatives = [];
    for (let t = 0; t < 20; t++) {
      const shuffled = [...clients].sort(() => Math.random() - 0.5);
      const trips = [];
      let totalKm = 0;
      // Copie des jours dispo, mélangés
      const joursDispos = [...joursOuvres].sort(() => Math.random() - 0.5);
      let jourIdx = 0;

      for (const client of shuffled) {
        if (totalKm + client.distanceKmAR > kmCible * (1 + tolerance)) continue;
        if (jourIdx >= joursDispos.length) break; // plus de jours disponibles
        trips.push({
          date: joursDispos[jourIdx],
          clientName: client.name,
          address: client.address,
          distanceKmAR: client.distanceKmAR,
          montant: client.montantAR,
        });
        jourIdx++;
        totalKm += client.distanceKmAR;
        if (totalKm >= kmCible * (1 - tolerance)) break;
      }

      if (trips.length > 0) {
        // Trier les trajets par date
        trips.sort((a, b) => a.date.localeCompare(b.date));
        const totalMontant = Math.round(totalKm * KM_RATE * 100) / 100;
        tentatives.push({
          trips,
          totalKm: Math.round(totalKm * 10) / 10,
          totalMontant,
          ecart: Math.abs(totalMontant - montant),
        });
      }
    }

    // Sort by closest to target, take top 5
    tentatives.sort((a, b) => a.ecart - b.ecart);
    const itineraires = tentatives.slice(0, 5).map(({ ecart, ...rest }) => rest);

    res.json({ itineraires });
  } catch (err) {
    console.error('Erreur frais-km/generate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Facture overrides ---
app.get('/api/facture-overrides', async (req, res) => {
  try {
    const { data, error } = await supabase.from('facture_overrides').select('*');
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/facture-overrides', async (req, res) => {
  try {
    const { mission, type, status, comment } = req.body;
    if (!mission || !type) return res.status(400).json({ error: 'mission et type requis' });
    const row = { mission, type, updated_at: new Date().toISOString() };
    if (status !== undefined) row.status = status;
    if (comment !== undefined) row.comment = comment;
    const { error } = await supabase.from('facture_overrides').upsert(
      row,
      { onConflict: 'mission,type' }
    );
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/facture-overrides', async (req, res) => {
  try {
    const { mission, type } = req.body;
    if (!mission || !type) return res.status(400).json({ error: 'mission et type requis' });
    const { error } = await supabase.from('facture_overrides').delete().eq('mission', mission).eq('type', type);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract customer name from invoice label (format: "Facture CLIENT_NAME - INVOICE_NUMBER (label généré)")
function extractCustomerFromLabel(label) {
  if (!label) return '';
  const cleaned = label.replace(/\(label généré\)/i, '').trim();
  // "Facture CLIENT - F-2026-XXX" or "Avoir CLIENT - F-2026-XXX"
  const match = cleaned.match(/^(?:Facture|Avoir)\s+(.+?)\s*-\s*(?:F-\d|[A-Z0-9]{3,})/i);
  if (match) return match[1].trim();
  // Fallback: remove "Facture - " prefix
  return cleaned.replace(/^(?:Facture|Avoir)\s*-?\s*/i, '').trim();
}

// Extract supplier name from label
function extractSupplierFromLabel(label) {
  if (!label) return '';
  const cleaned = label.replace(/\(label généré\)/i, '').trim();
  const match = cleaned.match(/^Facture\s+(.+?)\s*-\s*[A-Z0-9]/i);
  if (match) return match[1].trim();
  return cleaned.replace(/^Facture\s*-?\s*/i, '').trim();
}

// Fetch customer invoices (factures clients)
async function fetchCustomerInvoices() {
  const invoices = await pennylaneFetchAll('/customer_invoices', {});
  return invoices.map(inv => ({
    id: inv.id,
    label: inv.label || '',
    customerName: extractCustomerFromLabel(inv.label),
    amount: parseFloat(inv.amount) || 0,
    remainingAmount: parseFloat(inv.remaining_amount_with_tax) || 0,
    currency: inv.currency || 'EUR',
    date: inv.date || null,
    dueDate: inv.deadline || null,
    status: inv.status || 'unknown', // paid, upcoming, late, incomplete, cancelled
    paid: inv.paid || false,
    invoiceNumber: inv.invoice_number || '',
  }));
}

// Fetch supplier invoices (factures fournisseurs / charges)
async function fetchSupplierInvoices() {
  const invoices = await pennylaneFetchAll('/supplier_invoices', {});
  return invoices.map(inv => ({
    id: inv.id,
    label: inv.label || '',
    supplierName: extractSupplierFromLabel(inv.label),
    amount: parseFloat(inv.amount) || 0,
    currency: inv.currency || 'EUR',
    date: inv.date || null,
    dueDate: inv.deadline || null,
    paymentStatus: inv.payment_status || 'unknown',
  }));
}

// Fetch recent transactions (last 6 months) for charges/categories analysis
let _transactionsCache = [];

async function fetchRecentTransactions() {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const fromDate = sixMonthsAgo.toISOString().split('T')[0];
    const filter = JSON.stringify([{ field: 'date', operator: 'gteq', value: fromDate }]);
    console.log(`Chargement des transactions Pennylane depuis ${fromDate}...`);
    const transactions = await pennylaneFetchAll('/transactions', { filter });
    _transactionsCache = transactions;
    console.log(`${transactions.length} transactions chargées (6 derniers mois)`);
    return transactions;
  } catch (err) {
    console.error('Erreur fetchRecentTransactions:', err.message);
    return _transactionsCache;
  }
}

function getTransactions() {
  return _transactionsCache;
}

// Cache for tresorerie data (avoid hammering API)
let tresorerieCache = null;
let tresorerieCacheTime = 0;
const TRESORERIE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fetch all Qonto transactions with pagination (up to 6 months back)
async function fetchQontoTransactions(iban, monthsBack = 6) {
  const allTransactions = [];
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);
  let currentPage = 1;

  while (true) {
    const res = await qontoRequest(
      `/v2/transactions?iban=${iban}&status[]=completed&sort_by=settled_at:desc&per_page=100&current_page=${currentPage}&settled_at_from=${since.toISOString()}`
    );
    const txs = res.transactions || [];
    allTransactions.push(...txs);
    if (txs.length < 100) break;
    currentPage++;
  }

  return allTransactions;
}

// Build treasury data from Qonto
async function buildTresorerieFromQonto() {
  // Return cache if fresh
  if (tresorerieCache && (Date.now() - tresorerieCacheTime) < TRESORERIE_CACHE_TTL) {
    return tresorerieCache;
  }

  // Fetch bank balance + transactions from Qonto
  let solde = null;
  let transactions = [];
  try {
    const org = await qontoRequest('/v2/organization');
    const bankAccounts = org.organization.bank_accounts || [];
    if (bankAccounts.length > 0) {
      const mainAccount = bankAccounts.reduce((a, b) => (b.balance_cents > a.balance_cents ? b : a));
      solde = mainAccount.balance;
      transactions = await fetchQontoTransactions(mainAccount.iban, 6);
    }
  } catch (err) {
    console.error('Erreur Qonto pour trésorerie:', err.message);
  }

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // --- Charges et encaissements par mois + ventilation par catégorie (depuis Qonto) ---
  const chargesParMois = {};
  const encaissementsParMois = {};
  const chargesParCategorie = {};
  const chargesDetailParMois = {};  // { mKey: { cat: [{ label, amount, date }] } }
  const creditsDetailParMois = {};  // { mKey: [{ label, amount, date }] }

  for (const tx of transactions) {
    if (!tx.settled_at) continue;
    const d = new Date(tx.settled_at);
    const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

    if (tx.side === 'debit') {
      chargesParMois[mKey] = (chargesParMois[mKey] || 0) + tx.amount;
      const cat = tx.category || 'Non catégorisé';
      if (!chargesParCategorie[cat]) chargesParCategorie[cat] = 0;
      chargesParCategorie[cat] += tx.amount;
      // Detail par mois/categorie
      if (!chargesDetailParMois[mKey]) chargesDetailParMois[mKey] = {};
      if (!chargesDetailParMois[mKey][cat]) chargesDetailParMois[mKey][cat] = [];
      chargesDetailParMois[mKey][cat].push({ label: tx.label || 'Sans libellé', amount: tx.amount, date: tx.settled_at });
    } else {
      encaissementsParMois[mKey] = (encaissementsParMois[mKey] || 0) + tx.amount;
      // Detail credits par mois
      if (!creditsDetailParMois[mKey]) creditsDetailParMois[mKey] = [];
      creditsDetailParMois[mKey].push({ label: tx.label || 'Sans libellé', amount: tx.amount, date: tx.settled_at });
    }
  }

  // Charges mois courant
  const moisCourantKey = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const chargesMoisCourant = chargesParMois[moisCourantKey] || 0;

  // --- Estimer les charges récurrentes mensuelles ---
  // On prend la moyenne des 3 derniers mois complets
  const chargesRecurrentes = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(currentYear, currentMonth - 1 - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (chargesParMois[key]) chargesRecurrentes.push(chargesParMois[key]);
  }
  const chargesMoyennes = chargesRecurrentes.length > 0
    ? chargesRecurrentes.reduce((s, v) => s + v, 0) / chargesRecurrentes.length
    : chargesMoisCourant;

  // --- Prévisionnel mois par mois (12 mois) ---
  const previsionnel = [];
  let soldeProjection = solde || 0;

  for (let i = 0; i < 12; i++) {
    const mDate = new Date(currentYear, currentMonth - 1 + i, 1);
    const mois = mDate.getMonth() + 1;
    const annee = mDate.getFullYear();
    const mKey = `${annee}-${String(mois).padStart(2, '0')}`;
    const label = `${String(mois).padStart(2, '0')}/${annee}`;

    let encaissementsMois = 0;
    let decaissementsMois = 0;

    if (i === 0) {
      // Mois courant: données réelles Qonto
      encaissementsMois = encaissementsParMois[mKey] || 0;
      decaissementsMois = chargesParMois[mKey] || 0;
    } else {
      // Mois futurs: estimation basée sur la moyenne
      decaissementsMois = chargesMoyennes;
    }

    const variation = encaissementsMois - decaissementsMois;
    soldeProjection += variation;

    previsionnel.push({
      mois,
      annee,
      label,
      soldeDebut: soldeProjection - variation,
      encaissements: Math.round(encaissementsMois),
      decaissements: Math.round(decaissementsMois),
      variation: Math.round(variation),
      soldeFin: Math.round(soldeProjection),
    });
  }

  // --- Ventilation des charges par catégorie ---
  const ventilationCharges = Object.entries(chargesParCategorie)
    .map(([cat, montant]) => ({ categorie: cat, montant: Math.round(montant) }))
    .sort((a, b) => b.montant - a.montant);

  const result = {
    soldeActuel: solde,
    chargesMoisCourant: Math.round(chargesMoisCourant),
    chargesMoyennes: Math.round(chargesMoyennes),
    ventilationCharges,
    previsionnel,
    encaissementsParMois,
    decaissementsParMois: chargesParMois,
    chargesDetailParMois,
    creditsDetailParMois,
  };

  // Update cache
  tresorerieCache = result;
  tresorerieCacheTime = Date.now();

  return result;
}

// --- Google Sheets ---
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1btTMlLB4cNIN_PAkKOujBkOGU8DX526keOi-fvbPlsU';
const GID_MASSE_SALARIALE = 798407110;
const GID_PLAN_TRESORERIE = 2116491556;
const GID_PROJETS = 0;

function fetchGoogleSheetCSV(gid) {
  return new Promise((resolve, reject) => {
    const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Google Sheets ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseCSV(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
        current.push(field);
        field = '';
        rows.push(current);
        current = [];
      } else {
        field += ch;
      }
    }
  }
  if (field || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}

function parseFrenchNumber(str) {
  if (!str || typeof str !== 'string') return 0;
  // Remove € symbol, spaces, and convert comma to dot
  const cleaned = str.replace(/[€\s\u00a0]/g, '').replace(',', '.').trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

// Find month columns: look for header row with "01/YYYY" pattern
function findMonthColumns(rows) {
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const cols = [];
    for (let c = 0; c < rows[r].length; c++) {
      const match = rows[r][c].match(/^(\d{2})\/(\d{4})$/);
      if (match) {
        cols.push({ col: c, month: parseInt(match[1]), year: parseInt(match[2]) });
      }
    }
    if (cols.length >= 6) return { headerRow: r, months: cols };
  }
  return null;
}

function parseMasseSalariale(csvText) {
  const rows = parseCSV(csvText);
  const monthInfo = findMonthColumns(rows);
  if (!monthInfo) return { error: 'Structure non reconnue', months: [], categories: [] };

  const { headerRow, months } = monthInfo;
  const dataStartRow = headerRow + 2; // skip TVA sub-header

  const categories = [];
  let currentCategory = null;

  for (let r = dataStartRow; r < rows.length; r++) {
    const row = rows[r];
    // Label is typically in column 2 (index 2)
    const label = (row[2] || '').trim();
    if (!label) continue;

    // Check if this is a category header (Salaires nets, Charges soci., etc.)
    const isCategoryHeader = [
      'Salaires nets', 'Charges soci. + patr.', 'Rémunération dirigeants',
      'Primes', 'Aide apprentissage', 'Gratification de stage'
    ].some(cat => label.startsWith(cat));

    const values = months.map(m => parseFrenchNumber(row[m.col] || ''));
    const hasValues = values.some(v => v !== 0);

    if (isCategoryHeader) {
      currentCategory = { name: label, total: values, items: [] };
      categories.push(currentCategory);
    } else if (currentCategory && hasValues) {
      currentCategory.items.push({ name: label, values });
    }
  }

  return {
    months: months.map(m => ({ month: m.month, year: m.year, label: `${String(m.month).padStart(2, '0')}/${m.year}` })),
    categories,
  };
}

function parsePlanTresorerie(csvText) {
  const rows = parseCSV(csvText);
  const monthInfo = findMonthColumns(rows);
  if (!monthInfo) return { error: 'Structure non reconnue', months: [], lines: {} };

  const { headerRow, months } = monthInfo;

  // Key lines we want to extract (label -> key mapping)
  const keyLines = {
    'Trésorerie début de mois': 'tresorerieDebut',
    'Trésorerie fin de mois': 'tresorerieFin',
    'Variation sur le mois': 'variation',
    'Total encaissements (€TTC)': 'totalEncaissements',
    'Total décaissements (€TTC)': 'totalDecaissements',
    'Enc. Acompte': 'encAcompte',
    'Enc. Solde': 'encSolde',
    'Salaires nets': 'salairesNets',
    'Gratification de stage': 'gratificationStage',
    'Charges soci. + patr.': 'chargesSociales',
    'Rémunération dirigeants': 'remunerationDirigeants',
    'Primes': 'primes',
    'Comptable': 'comptable',
    'Publicité / marketing': 'publicite',
    'Assurance': 'assurance',
    'Frais bancaires': 'fraisBancaires',
    'Mutuelle': 'mutuelle',
    'Prévoyance': 'prevoyance',
    'Sous-traitance': 'sousTraitance',
    'Apport affaires': 'apportAffaires',
    'Formation': 'formation',
    'Développement SaaS': 'devSaas',
    'IS (impôt sur sociétés)': 'impotSocietes',
    'CFE (cotisation foncière)': 'cfe',
    'Crédit de TVA': 'creditTVA',
    'Décaissement de TVA': 'decaissementTVA',
    'Solde de TVA': 'soldeTVA',
  };

  // Also capture logiciels as a group
  const logiciels = [
    'PayFit', 'Notion', 'Chat gpt', 'Cloudflare', 'OVH', 'Pennylane',
    'Walaaxy', 'Qonto', 'Microsoft', 'Emelia', 'Adresses email', 'canva',
    'WP Rocket', 'Dropcontact', 'SalesNav', 'Simapro', 'Hubspot', 'One Click LCA',
  ];

  // Charges variables items
  const chargesVariablesItems = [
    'Événements / salons', 'Frais déplacement - Train', 'Frais déplacement - Carburant',
    'Frais déplacement - Taxi', 'Frais déplacement - Train Vincent',
    'Frais déplacement - KM Nathan', 'Frais déplacement - KM Guillaume',
    'Fournitures', 'Honoraires divers',
  ];

  // Financements
  const financements = [
    'Prêt bancaire', 'Remb. OPCO', 'Avance remboursable BPI',
    'Subvention BFT', 'Aide apprentissage',
  ];

  const lines = {};
  const logicielsData = [];
  const chargesVariablesData = [];
  const financementsData = [];

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    // Try col 2, then col 3 for the label
    let label = (row[2] || '').trim();
    if (!label) label = (row[3] || '').trim();
    if (!label && row[1]) label = (row[1] || '').trim();
    if (!label) continue;

    const values = months.map(m => parseFrenchNumber(row[m.col] || ''));

    if (keyLines[label]) {
      lines[keyLines[label]] = values;
    }
    if (logiciels.includes(label)) {
      logicielsData.push({ name: label, values });
    }
    if (chargesVariablesItems.includes(label)) {
      chargesVariablesData.push({ name: label, values });
    }
    if (financements.includes(label)) {
      financementsData.push({ name: label, values });
    }
  }

  // Compute totals for logiciels
  const logicielsTotal = months.map((_, i) =>
    logicielsData.reduce((sum, item) => sum + item.values[i], 0)
  );

  return {
    months: months.map(m => ({ month: m.month, year: m.year, label: `${String(m.month).padStart(2, '0')}/${m.year}` })),
    lines,
    logiciels: logicielsData,
    logicielsTotal,
    chargesVariables: chargesVariablesData,
    financements: financementsData,
  };
}

// --- Auth masse salariale ---
const MASSE_SALARIALE_PASSWORD = process.env.MASSE_SALARIALE_PASSWORD || 'admin';

app.post('/api/auth-masse-salariale', (req, res) => {
  const { password } = req.body;
  if (password === MASSE_SALARIALE_PASSWORD) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Mot de passe incorrect' });
});

// --- Revenus exceptionnels (Supabase) ---

app.get('/api/revenus-exceptionnels', async (req, res) => {
  const { data, error } = await supabase.from('revenus_exceptionnels').select('*').order('mois');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/revenus-exceptionnels', async (req, res) => {
  const { libelle, montant, mois } = req.body;
  if (!libelle || typeof libelle !== 'string' || !libelle.trim()) {
    return res.status(400).json({ error: 'Libelle requis' });
  }
  if (!montant || typeof montant !== 'number' || montant <= 0) {
    return res.status(400).json({ error: 'Montant doit etre > 0' });
  }
  if (!mois || !/^\d{4}-\d{2}$/.test(mois)) {
    return res.status(400).json({ error: 'Mois au format YYYY-MM requis' });
  }
  const { data, error } = await supabase.from('revenus_exceptionnels')
    .insert({ libelle: libelle.trim(), montant, mois })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  tresorerieCacheTime = 0;
  res.json(data);
});

app.delete('/api/revenus-exceptionnels/:id', async (req, res) => {
  const { error, count } = await supabase.from('revenus_exceptionnels')
    .delete({ count: 'exact' })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: 'Revenu non trouve' });
  tresorerieCacheTime = 0;
  res.json({ ok: true });
});

// --- Salariés (Supabase) ---

app.get('/api/salaries', async (req, res) => {
  try {
    const { data, error } = await supabase.from('salaries').select('*').order('nom');
    if (error) {
      console.error('[GET /api/salaries] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    console.error('[GET /api/salaries] Exception:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/salaries', async (req, res) => {
  const { nom, poste, type, net_mensuel, charges_mensuelles, date_entree, date_sortie } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!['salarie', 'dirigeant', 'stagiaire', 'alternant'].includes(type)) {
    return res.status(400).json({ error: 'Type invalide' });
  }
  if (typeof net_mensuel !== 'number' || net_mensuel < 0) {
    return res.status(400).json({ error: 'Net mensuel invalide' });
  }
  if (typeof charges_mensuelles !== 'number' || charges_mensuelles < 0) {
    return res.status(400).json({ error: 'Charges mensuelles invalides' });
  }
  if (!date_entree) return res.status(400).json({ error: 'Date entree requise' });
  const { data, error } = await supabase.from('salaries')
    .insert({ nom: nom.trim(), poste: poste || null, type, net_mensuel, charges_mensuelles, date_entree, date_sortie: date_sortie || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  tresorerieCacheTime = 0;
  res.json(data);
});

app.put('/api/salaries/:id', async (req, res) => {
  const { nom, poste, type, net_mensuel, charges_mensuelles, date_entree, date_sortie } = req.body;
  const { data, error } = await supabase.from('salaries')
    .update({ nom, poste, type, net_mensuel, charges_mensuelles, date_entree, date_sortie })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  tresorerieCacheTime = 0;
  res.json(data);
});

app.delete('/api/salaries/:id', async (req, res) => {
  const { error, count } = await supabase.from('salaries')
    .delete({ count: 'exact' })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: 'Salarie non trouve' });
  tresorerieCacheTime = 0;
  res.json({ ok: true });
});

// --- Fonction réutilisable : buildPrevisionnel() ---
// Extrait la logique de projection pour réutiliser dans les scénarios
function masseSalarialeMois(annee, mois, salaries) {
  const mDate = new Date(annee, mois - 1, 15);
  let total = 0;
  const detail = [];
  for (const s of salaries) {
    const entree = new Date(s.date_entree);
    const sortie = s.date_sortie ? new Date(s.date_sortie) : null;
    if (entree > mDate) continue;
    if (sortie && sortie < new Date(annee, mois - 1, 1)) continue;
    const cout = s.net_mensuel + s.charges_mensuelles;
    total += cout;
    detail.push({ nom: s.nom, poste: s.poste, type: s.type, net: s.net_mensuel, charges: s.charges_mensuelles, cout: Math.round(cout) });
  }
  return { total: Math.round(total), detail };
}

async function buildPrevisionnel({ qontoData, pipelineDeals, notionMissions, salaries, revenus, chargesFixesExtras, pipelineFactor, fictionalDeals, crPrevData, caEstimatif }) {
  // --- A encaisser depuis Notion (factures envoyées + prévisionnelles) ---
  const facturesAEncaisser = [];
  const now = new Date();

  for (const m of notionMissions) {
    if (m.ca <= 0) continue;
    const status = (m.facturation || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (status.includes('solde paye')) continue;

    function echeanceJ45(dateStr) {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      d.setDate(d.getDate() + 45);
      return d.toISOString().split('T')[0];
    }

    // --- ACOMPTE ---
    if (m.montantAcompte > 0) {
      if (status.includes('acompte envoye')) {
        const dateEmission = m.dateFactureAcompte;
        const dateEcheance = echeanceJ45(dateEmission);
        const isLate = dateEcheance && new Date(dateEcheance) < now;
        facturesAEncaisser.push({
          client: m.client || m.nom, mission: m.nom, type: 'Acompte',
          montant: m.montantAcompte, dateEmission, dateEcheance,
          status: isLate ? 'late' : 'upcoming', previsionnel: false,
        });
      } else if (status.includes('acompte a envoyer') || status === 'non defini') {
        const dateEmission = m.dateFactureAcompte;
        const dateEcheance = echeanceJ45(dateEmission);
        facturesAEncaisser.push({
          client: m.client || m.nom, mission: m.nom, type: 'Acompte',
          montant: m.montantAcompte, dateEmission, dateEcheance,
          status: 'previsionnel', previsionnel: true,
        });
      }
    }

    // --- SOLDE ---
    const montantSolde = m.ca - m.montantAcompte;
    if (montantSolde > 0) {
      if (status.includes('solde envoye')) {
        const dateEmission = m.dateFactureFinale;
        const dateEcheance = echeanceJ45(dateEmission);
        const isLate = dateEcheance && new Date(dateEcheance) < now;
        facturesAEncaisser.push({
          client: m.client || m.nom, mission: m.nom, type: 'Solde',
          montant: montantSolde, dateEmission, dateEcheance,
          status: isLate ? 'late' : 'upcoming', previsionnel: false,
        });
      } else if (status.includes('acompte paye') || status.includes('solde a envoyer')
                 || status.includes('acompte envoye') || status.includes('acompte a envoyer') || status === 'non defini') {
        const dateEmission = m.dateFactureFinale;
        const dateEcheance = echeanceJ45(dateEmission);
        facturesAEncaisser.push({
          client: m.client || m.nom, mission: m.nom, type: 'Solde',
          montant: montantSolde, dateEmission, dateEcheance,
          status: 'previsionnel', previsionnel: true,
        });
      }
    }
  }

  facturesAEncaisser.sort((a, b) => {
    if (a.previsionnel !== b.previsionnel) return a.previsionnel ? 1 : -1;
    return new Date(a.dateEcheance || '2099-12-31') - new Date(b.dateEcheance || '2099-12-31');
  });

  const totalEnvoye = facturesAEncaisser.filter(f => !f.previsionnel).reduce((s, f) => s + f.montant, 0);
  const totalPrevisionnel = facturesAEncaisser.filter(f => f.previsionnel).reduce((s, f) => s + f.montant, 0);
  const totalAEncaisserNotion = totalEnvoye + totalPrevisionnel;

  // Calcul du pipeline pondéré HubSpot
  const factor = pipelineFactor != null ? pipelineFactor : 1;
  let pipelinePondere = 0;
  const pipelineDetail = [];
  for (const stage of KANBAN_STAGES) {
    const deals = pipelineDeals[stage.label] || [];
    for (const deal of deals) {
      const weighted = deal.amount * (deal.probability / 100) * factor;
      pipelinePondere += weighted;
      pipelineDetail.push({
        name: deal.name, amount: deal.amount,
        probability: deal.probability, weighted: Math.round(weighted), stage: stage.label,
      });
    }
  }

  // Intégrer les factures à encaisser dans le prévisionnel
  const now2 = new Date();
  const moisCourantKey = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, '0')}`;

  const encaissementsParMoisFactures = {};
  const encaissementsEnvoye = {};
  const encaissementsPrev = {};
  const encaissementsRetard = {};
  for (const f of facturesAEncaisser) {
    if (!f.dateEcheance) continue;
    const d = new Date(f.dateEcheance);
    let mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const isRetard = mKey < moisCourantKey;
    if (isRetard) mKey = moisCourantKey;
    encaissementsParMoisFactures[mKey] = (encaissementsParMoisFactures[mKey] || 0) + f.montant;

    if (f.status === 'late' || isRetard) {
      encaissementsRetard[mKey] = (encaissementsRetard[mKey] || 0) + f.montant;
    } else if (f.previsionnel) {
      encaissementsPrev[mKey] = (encaissementsPrev[mKey] || 0) + f.montant;
    } else {
      encaissementsEnvoye[mKey] = (encaissementsEnvoye[mKey] || 0) + f.montant;
    }
  }

  // --- Revenus exceptionnels ---
  const revenusParMois = {};
  const revenusDetailParMois = {};
  for (const r of revenus) {
    revenusParMois[r.mois] = (revenusParMois[r.mois] || 0) + r.montant;
    if (!revenusDetailParMois[r.mois]) revenusDetailParMois[r.mois] = [];
    revenusDetailParMois[r.mois].push(r);
  }

  // --- Charges fixes extras (scénarios) ---
  const chargesFixesParMois = {};
  if (chargesFixesExtras && chargesFixesExtras.length > 0) {
    for (const cf of chargesFixesExtras) {
      const debut = cf.mois_debut;
      const fin = cf.mois_fin;
      // Itérer sur les mois du prévisionnel et ajouter si dans la plage
      for (const mois of qontoData.previsionnel) {
        const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
        if (mKey >= debut && mKey <= fin) {
          chargesFixesParMois[mKey] = (chargesFixesParMois[mKey] || 0) + cf.montant_mensuel;
        }
      }
    }
  }

  // --- Deals fictifs (scénarios) ---
  const fictionalEncaissements = {};
  if (fictionalDeals && fictionalDeals.length > 0) {
    for (const fd of fictionalDeals) {
      const mKey = fd.mois;
      const montant = fd.montant * ((fd.probabilite || 100) / 100);
      fictionalEncaissements[mKey] = (fictionalEncaissements[mKey] || 0) + montant;
    }
  }

  // --- Charges GSheet par mois (pour remplacer la moyenne Qonto sur les mois futurs) ---
  const chargesGSheetParMois = {};
  if (crPrevData && crPrevData.categories) {
    for (const [, moisData] of Object.entries(crPrevData.categories)) {
      for (const [mKey, val] of Object.entries(moisData)) {
        chargesGSheetParMois[mKey] = (chargesGSheetParMois[mKey] || 0) + val;
      }
    }
  }

  // --- CA estimatif mensuel HT ---
  const caMensuelHT = caEstimatif
    ? Math.round((caEstimatif.montant_annuel || 0) / (caEstimatif.nb_mois || 12))
    : null;

  const previsionnelFinal = qontoData.previsionnel.map((mois) => {
    const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
    const isFuture = mKey > moisCourantKey;

    // --- Encaissements ---
    let encaissementsFactures, factEnvoye, factPrev, factRetard, fictionalEnc;
    if (caMensuelHT !== null) {
      // CA estimatif : remplace Notion + pipeline
      factEnvoye = 0; factPrev = 0; factRetard = 0;
      encaissementsFactures = 0;
      fictionalEnc = 0;
    } else {
      factEnvoye = Math.round(encaissementsEnvoye[mKey] || 0);
      factPrev = Math.round(encaissementsPrev[mKey] || 0);
      factRetard = Math.round(encaissementsRetard[mKey] || 0);
      encaissementsFactures = factEnvoye + factPrev + factRetard;
      fictionalEnc = Math.round(fictionalEncaissements[mKey] || 0);
    }

    const revExc = Math.round(revenusParMois[mKey] || 0);
    const masse = masseSalarialeMois(mois.annee, mois.mois, salaries);
    const chargesFixesExtra = Math.round(chargesFixesParMois[mKey] || 0);

    // --- Décaissements : GSheet pour mois futurs, Qonto pour mois courant ---
    let decaissementsBase = mois.decaissements;
    if (isFuture && chargesGSheetParMois[mKey] != null) {
      decaissementsBase = Math.round(chargesGSheetParMois[mKey]);
    }

    // --- Encaissements base ---
    const encBase = caMensuelHT !== null && isFuture ? caMensuelHT : mois.encaissements;

    return {
      ...mois,
      encaissementsFactures,
      encaissementsEnvoye: factEnvoye,
      encaissementsPrev: factPrev,
      encaissementsRetard: factRetard,
      revenusExceptionnels: revExc,
      revenusExceptionnelsDetail: revenusDetailParMois[mKey] || [],
      masseSalariale: masse.total,
      masseSalarialeDetail: masse.detail,
      chargesFixesExtra,
      fictionalEncaissements: fictionalEnc,
      decaissements: decaissementsBase + chargesFixesExtra,
      encaissements: encBase,
      encaissementsTotal: encBase + encaissementsFactures + revExc + fictionalEnc,
    };
  });

  // Recalculer les soldes
  let soldeCumul = qontoData.soldeActuel || 0;
  for (const mois of previsionnelFinal) {
    const encTotal = mois.encaissements + (mois.encaissementsFactures || 0) + (mois.revenusExceptionnels || 0) + (mois.fictionalEncaissements || 0);
    const variation = encTotal - mois.decaissements;
    mois.soldeDebut = Math.round(soldeCumul);
    soldeCumul += variation;
    mois.soldeFin = Math.round(soldeCumul);
  }

  return {
    previsionnel: previsionnelFinal,
    facturesAEncaisser,
    totalEnvoye,
    totalPrevisionnel,
    totalAEncaisserNotion,
    pipelinePondere,
    pipelineDetail,
  };
}

app.get('/api/tresorerie', async (req, res) => {
  try {
    const [qontoData, pipelineDeals, notionMissions] = await Promise.all([
      buildTresorerieFromQonto(),
      fetchOpenDeals(),
      fetchAllNotionMissions(),
    ]);

    const { data: revenusExceptionnels } = await supabase.from('revenus_exceptionnels').select('*');
    const revenus = revenusExceptionnels || [];
    const { data: salariesList } = await supabase.from('salaries').select('*');
    const allSalaries = salariesList || [];

    const crPrevData = await fetchAndParseCRPrev();
    const result = await buildPrevisionnel({
      qontoData, pipelineDeals, notionMissions,
      salaries: allSalaries, revenus,
      chargesFixesExtras: [], pipelineFactor: 1, fictionalDeals: [],
      crPrevData, caEstimatif: null,
    });

    res.json({
      source: 'qonto',
      soldeActuel: qontoData.soldeActuel,
      totalAEncaisser: Math.round(result.totalAEncaisserNotion),
      totalEnvoye: Math.round(result.totalEnvoye),
      totalPrevisionnel: Math.round(result.totalPrevisionnel),
      chargesMoisCourant: qontoData.chargesMoisCourant,
      chargesMoyennes: qontoData.chargesMoyennes,
      facturesImpayees: result.facturesAEncaisser,
      ventilationCharges: qontoData.ventilationCharges,
      chargesDetailParMois: qontoData.chargesDetailParMois,
      creditsDetailParMois: qontoData.creditsDetailParMois,
      previsionnel: result.previsionnel,
      pipelinePondere: Math.round(result.pipelinePondere),
      pipelineDetail: result.pipelineDetail,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur trésorerie:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Scenarios CRUD ---

app.get('/api/scenarios', async (req, res) => {
  const { data, error } = await supabase.from('scenarios').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/scenarios', async (req, res) => {
  const { nom, description } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: 'Nom requis' });
  const { data, error } = await supabase.from('scenarios')
    .insert({ nom: nom.trim(), description: description || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/scenarios/:id', async (req, res) => {
  const { data: scenario, error } = await supabase.from('scenarios').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Scenario non trouve' });
  const { data: overrides } = await supabase.from('scenario_overrides').select('*').eq('scenario_id', req.params.id).order('created_at');
  res.json({ ...scenario, overrides: overrides || [] });
});

app.put('/api/scenarios/:id', async (req, res) => {
  const { nom, description } = req.body;
  const { data, error } = await supabase.from('scenarios')
    .update({ nom, description, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/scenarios/:id', async (req, res) => {
  const { error, count } = await supabase.from('scenarios').delete({ count: 'exact' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: 'Scenario non trouve' });
  res.json({ ok: true });
});

app.post('/api/scenarios/:id/overrides', async (req, res) => {
  const { type, data: overrideData } = req.body;
  const validTypes = ['salaire', 'pipeline', 'charges_fixes', 'revenu_exceptionnel', 'ca_estimatif'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Type invalide: ' + validTypes.join(', ') });
  if (!overrideData || typeof overrideData !== 'object') return res.status(400).json({ error: 'Data requis (objet JSON)' });
  // Vérifier que le scenario existe
  const { data: scenario } = await supabase.from('scenarios').select('id').eq('id', req.params.id).single();
  if (!scenario) return res.status(404).json({ error: 'Scenario non trouve' });
  const { data, error } = await supabase.from('scenario_overrides')
    .insert({ scenario_id: req.params.id, type, data: overrideData })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/scenarios/:id/overrides/:oid', async (req, res) => {
  const { type, data: overrideData } = req.body;
  const update = {};
  if (type) update.type = type;
  if (overrideData) update.data = overrideData;
  const { data, error } = await supabase.from('scenario_overrides')
    .update(update).eq('id', req.params.oid).eq('scenario_id', req.params.id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/scenarios/:id/overrides/:oid', async (req, res) => {
  const { error, count } = await supabase.from('scenario_overrides')
    .delete({ count: 'exact' }).eq('id', req.params.oid).eq('scenario_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: 'Override non trouve' });
  res.json({ ok: true });
});

// --- Projections ---

async function fetchBaseData() {
  const [qontoData, pipelineDeals, notionMissions, crPrevData] = await Promise.all([
    buildTresorerieFromQonto(),
    fetchOpenDeals(),
    fetchAllNotionMissions(),
    fetchAndParseCRPrev(),
  ]);
  const { data: revenusExceptionnels } = await supabase.from('revenus_exceptionnels').select('*');
  const { data: salariesList } = await supabase.from('salaries').select('*');
  return {
    qontoData, pipelineDeals, notionMissions, crPrevData,
    revenus: revenusExceptionnels || [],
    salaries: salariesList || [],
  };
}

function applyOverrides(baseData, overrides) {
  let salaries = [...baseData.salaries];
  let revenus = [...baseData.revenus];
  let chargesFixesExtras = [];
  let pipelineFactor = 1;
  let fictionalDeals = [];
  let caEstimatif = null;

  for (const ov of overrides) {
    const d = ov.data;
    switch (ov.type) {
      case 'salaire':
        if (d.action === 'add') {
          salaries.push({
            id: 'fictional-' + ov.id,
            nom: d.nom || 'Nouveau',
            poste: d.poste || null,
            type: d.type || 'salarie',
            net_mensuel: d.net_mensuel || 0,
            charges_mensuelles: d.charges_mensuelles || 0,
            date_entree: d.date_entree || new Date().toISOString().split('T')[0],
            date_sortie: d.date_sortie || null,
          });
        } else if (d.action === 'remove' && d.salarie_id) {
          salaries = salaries.filter(s => s.id !== d.salarie_id);
        } else if (d.action === 'modify' && d.salarie_id) {
          salaries = salaries.map(s => {
            if (s.id !== d.salarie_id) return s;
            return { ...s, ...d, id: s.id };
          });
        }
        break;
      case 'pipeline':
        if (d.mode === 'factor' && d.facteur != null) {
          pipelineFactor = d.facteur;
        } else if (d.mode === 'deal') {
          fictionalDeals.push({
            nom: d.nom || 'Deal fictif',
            montant: d.montant || 0,
            probabilite: d.probabilite != null ? d.probabilite : 100,
            mois: d.mois,
          });
        }
        break;
      case 'ca_estimatif':
        caEstimatif = { montant_annuel: d.montant_annuel || 0, nb_mois: d.nb_mois || 12 };
        break;
      case 'charges_fixes':
        if (d.mode === 'oneshot') {
          chargesFixesExtras.push({ libelle: d.libelle, montant_mensuel: d.montant || 0, mois_debut: d.mois, mois_fin: d.mois });
        } else {
          chargesFixesExtras.push({ libelle: d.libelle, montant_mensuel: d.montant_mensuel || 0, mois_debut: d.mois_debut, mois_fin: d.mois_fin });
        }
        break;
      case 'revenu_exceptionnel':
        revenus.push({
          id: 'fictional-' + ov.id,
          libelle: d.libelle,
          montant: d.montant || 0,
          mois: d.mois,
        });
        break;
    }
  }

  return { salaries, revenus, chargesFixesExtras, pipelineFactor, fictionalDeals, caEstimatif };
}

app.get('/api/scenarios/baseline/projection', async (req, res) => {
  try {
    const base = await fetchBaseData();
    const result = await buildPrevisionnel({
      qontoData: base.qontoData, pipelineDeals: base.pipelineDeals,
      notionMissions: base.notionMissions, salaries: base.salaries,
      revenus: base.revenus, chargesFixesExtras: [], pipelineFactor: 1, fictionalDeals: [],
      crPrevData: base.crPrevData, caEstimatif: null,
    });
    res.json({ nom: 'Baseline', previsionnel: result.previsionnel });
  } catch (err) {
    console.error('Erreur baseline projection:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scenarios/baseline/salaries', async (req, res) => {
  try {
    const { data, error } = await supabase.from('salaries').select('*').order('nom');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    console.error('Erreur baseline salaries:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scenarios/:id/projection', async (req, res) => {
  try {
    // Vérifier que l'id n'est pas "baseline"
    if (req.params.id === 'baseline') return res.redirect('/api/scenarios/baseline/projection');

    const { data: scenario, error } = await supabase.from('scenarios').select('*').eq('id', req.params.id).single();
    if (error || !scenario) return res.status(404).json({ error: 'Scenario non trouve' });

    const { data: overrides } = await supabase.from('scenario_overrides').select('*').eq('scenario_id', req.params.id).order('created_at');

    const base = await fetchBaseData();
    const applied = applyOverrides(base, overrides || []);

    const result = await buildPrevisionnel({
      qontoData: base.qontoData, pipelineDeals: base.pipelineDeals,
      notionMissions: base.notionMissions,
      salaries: applied.salaries, revenus: applied.revenus,
      chargesFixesExtras: applied.chargesFixesExtras,
      pipelineFactor: applied.pipelineFactor,
      fictionalDeals: applied.fictionalDeals,
      crPrevData: base.crPrevData, caEstimatif: applied.caEstimatif,
    });
    res.json({ nom: scenario.nom, previsionnel: result.previsionnel });
  } catch (err) {
    console.error('Erreur scenario projection:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DEBUG: temporary endpoint to inspect raw Pennylane data
app.get('/api/debug-pennylane', async (req, res) => {
  try {
    // Fetch sample transactions
    const transactions = await pennylaneFetchAll('/transactions', {}, 1); // 1 page only
    // Fetch categories
    let categories = [];
    try { categories = await pennylaneFetchAll('/categories', {}, 5); } catch(e) { categories = [{ error: e.message }]; }
    // Fetch category_groups
    let categoryGroups = [];
    try { categoryGroups = await pennylaneFetchAll('/category_groups', {}, 5); } catch(e) { categoryGroups = [{ error: e.message }]; }

    res.json({
      sampleTransactions: transactions.slice(0, 5),
      transactionKeys: transactions.length > 0 ? Object.keys(transactions[0]) : [],
      categories: categories.slice(0, 30),
      categoryKeys: categories.length > 0 ? Object.keys(categories[0]) : [],
      categoryGroups: categoryGroups.slice(0, 20),
      categoryGroupKeys: categoryGroups.length > 0 ? Object.keys(categoryGroups[0]) : [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Qonto API integration ---
const QONTO_ORG_ID = process.env.QONTO_ORG_ID;
const QONTO_API_KEY = process.env.QONTO_API_KEY;
const QONTO_HOST = 'thirdparty.qonto.com';

function qontoRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, `https://${QONTO_HOST}`);
    const options = {
      hostname: QONTO_HOST,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `${QONTO_ORG_ID}:${QONTO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Réponse Qonto invalide')); }
        } else {
          reject(new Error(`Qonto API ${res.statusCode}: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

app.get('/api/qonto', async (req, res) => {
  if (!QONTO_ORG_ID || !QONTO_API_KEY) {
    return res.status(500).json({ error: 'Qonto credentials not configured' });
  }
  try {
    // Fetch organization (includes bank accounts with balances)
    const org = await qontoRequest('/v2/organization');
    const bankAccounts = org.organization.bank_accounts || [];

    // Find main account (first one or the one with highest balance)
    const mainAccount = bankAccounts.length > 0
      ? bankAccounts.reduce((a, b) => (b.balance_cents > a.balance_cents ? b : a))
      : null;

    // Fetch recent transactions for the main account
    let transactions = [];
    if (mainAccount) {
      const now = new Date();
      const threeMonthsAgo = new Date(now);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const txRes = await qontoRequest(
        `/v2/transactions?iban=${mainAccount.iban}&status[]=completed&sort_by=settled_at:desc&per_page=100&settled_at_from=${threeMonthsAgo.toISOString()}`
      );
      transactions = txRes.transactions || [];
    }

    // Compute monthly summary
    const monthlySummary = {};
    transactions.forEach(tx => {
      if (!tx.settled_at) return;
      const d = new Date(tx.settled_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlySummary[key]) monthlySummary[key] = { credits: 0, debits: 0, count: 0 };
      if (tx.side === 'credit') {
        monthlySummary[key].credits += tx.amount;
      } else {
        monthlySummary[key].debits += tx.amount;
      }
      monthlySummary[key].count++;
    });

    res.json({
      organization: org.organization.slug,
      bankAccounts: bankAccounts.map(a => ({
        name: a.name || a.slug,
        iban: a.iban,
        bic: a.bic,
        balance: a.balance,
        balanceCents: a.balance_cents,
        authorizedBalance: a.authorized_balance,
        currency: a.currency,
        status: a.status,
      })),
      mainAccountBalance: mainAccount ? mainAccount.balance : null,
      mainAccountIban: mainAccount ? mainAccount.iban : null,
      transactions: transactions.slice(0, 50).map(tx => ({
        id: tx.transaction_id,
        label: tx.label,
        amount: tx.amount,
        side: tx.side,
        currency: tx.currency,
        settledAt: tx.settled_at,
        operationType: tx.operation_type,
        status: tx.status,
        category: tx.category,
        note: tx.note,
        reference: tx.reference,
      })),
      monthlySummary,
    });
  } catch (err) {
    console.error('Erreur Qonto:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Prospection IMAP ---
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const Imap = require('imap');
const { simpleParser } = require('mailparser');

function createImapConnection() {
  return new Imap({
    user: GMAIL_USER,
    password: GMAIL_APP_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });
}

function classifyEmail(subject, bodyPreview) {
  const text = ((subject || '') + ' ' + (bodyPreview || '')).toLowerCase();
  const autoReplyPatterns = ['automatic reply', 'out of office', 'absence', 'auto-reply', 'auto reply', 'delivery failure', 'undeliverable', 'mail delivery', 'mailer-daemon', 'reponse automatique'];
  const notInterestedPatterns = ['pas interesse', 'ne me contactez plus', 'desabonnement', 'stop', 'remove me', 'unsubscribe', 'not interested', 'no thank', 'ne nous interesse', 'ne m\'interesse', 'ne pas me recontacter', 'ne souhaitons pas', 'ne souhaite pas'];
  const interestedPatterns = ['interesse', 'interested', 'en savoir plus', 'disponible', 'rdv', 'rendez-vous', 'meeting', 'call', 'planifier', 'volontiers', "let's discuss", 'happy to', 'would love', 'avec plaisir', 'pourquoi pas', 'dites-moi', 'convenons', 'discuter', 'echanger'];

  for (const p of autoReplyPatterns) { if (text.includes(p)) return 'auto_reply'; }
  for (const p of notInterestedPatterns) { if (text.includes(p)) return 'pas_interesse'; }
  for (const p of interestedPatterns) { if (text.includes(p)) return 'interesse'; }
  return 'a_qualifier';
}

// POST /api/prospection/sync — sync IMAP replies into Supabase
app.post('/api/prospection/sync', async (req, res) => {
  try {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return res.status(500).json({ error: 'GMAIL_USER ou GMAIL_APP_PASSWORD non configuré' });
    }

    // Load existing message_ids from Supabase
    const { data: existing, error: fetchErr } = await supabase.from('prospect_emails').select('message_id, manual_override');
    if (fetchErr) throw new Error(fetchErr.message);
    const existingMap = {};
    (existing || []).forEach(e => { existingMap[e.message_id] = e; });

    // Connect to IMAP
    const imap = createImapConnection();

    const emails = await new Promise((resolve, reject) => {
      const results = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err, box) => {
          if (err) { imap.end(); return reject(err); }

          // Search for replies (have In-Reply-To header)
          imap.search([['HEADER', 'IN-REPLY-TO', '']], (err, uids) => {
            if (err) { imap.end(); return reject(err); }
            if (!uids || uids.length === 0) { imap.end(); return resolve([]); }

            const f = imap.fetch(uids, { bodies: '', struct: true });

            f.on('message', (msg) => {
              let rawBuffer = Buffer.alloc(0);
              msg.on('body', (stream) => {
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => { rawBuffer = Buffer.concat(chunks); });
              });
              msg.once('end', () => { results.push(rawBuffer); });
            });

            f.once('error', (err) => { imap.end(); reject(err); });
            f.once('end', () => { imap.end(); resolve(results); });
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });

    // Parse and upsert
    let synced = 0;
    for (const raw of emails) {
      try {
        const parsed = await simpleParser(raw);
        const messageId = parsed.messageId || '';
        if (!messageId) continue;

        const fromAddr = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0] : {};
        const fromEmail = fromAddr.address || '';
        const fromName = fromAddr.name || '';
        const subject = parsed.subject || '';
        const date = parsed.date || new Date();
        const bodyText = parsed.text || '';
        const bodyPreview = bodyText.substring(0, 500).replace(/\r?\n/g, ' ').trim();

        // Skip if already exists with manual override
        if (existingMap[messageId] && existingMap[messageId].manual_override) continue;

        const category = classifyEmail(subject, bodyPreview);

        const { error: upsertErr } = await supabase.from('prospect_emails').upsert({
          message_id: messageId,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          date: date.toISOString(),
          body_preview: bodyPreview,
          category,
          manual_override: false,
        }, { onConflict: 'message_id' });

        if (!upsertErr) synced++;
      } catch (parseErr) {
        console.warn('Erreur parsing email:', parseErr.message);
      }
    }

    // Get total count
    const { count } = await supabase.from('prospect_emails').select('*', { count: 'exact', head: true });

    res.json({ synced, total: count || 0 });
  } catch (err) {
    console.error('Erreur prospection/sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospection/prospects — list all prospects
app.get('/api/prospection/prospects', async (req, res) => {
  try {
    const { data, error } = await supabase.from('prospect_emails').select('*').order('date', { ascending: false });
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospection/qualify — requalify a prospect
app.post('/api/prospection/qualify', async (req, res) => {
  try {
    const { id, category } = req.body;
    if (!id || !category) return res.status(400).json({ error: 'id et category requis' });
    const validCategories = ['interesse', 'pas_interesse', 'auto_reply', 'a_qualifier'];
    if (!validCategories.includes(category)) return res.status(400).json({ error: 'Categorie invalide' });

    const { error } = await supabase.from('prospect_emails')
      .update({ category, manual_override: true })
      .eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Analytics : CA facturé sur une période ---
app.get('/api/analytics', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Paramètres start et end requis' });

    const startDate = new Date(start);
    const endDate = new Date(end);
    endDate.setHours(23, 59, 59, 999);

    const missions = await fetchAllNotionMissions();

    const startNm1 = new Date(startDate); startNm1.setFullYear(startNm1.getFullYear() - 1);
    const endNm1 = new Date(endDate); endNm1.setFullYear(endNm1.getFullYear() - 1);

    let ca = 0;
    const bySubventionne = {};
    const byAcquisition = {};
    const byNatureMission = {};
    const byTypeCa = {};
    const byClient = {};
    const caParMoisN = {};
    const caParMoisNm1 = {};

    function addToMois(map, dateStr, montant) {
      const d = new Date(dateStr);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      map[key] = (map[key] || 0) + montant;
    }

    for (const m of missions) {
      let montantPeriode = 0;

      // Acompte N
      if (m.dateFactureAcompte && m.montantAcompte > 0) {
        const d = new Date(m.dateFactureAcompte);
        if (d >= startDate && d <= endDate) { montantPeriode += m.montantAcompte; addToMois(caParMoisN, m.dateFactureAcompte, m.montantAcompte); }
        if (d >= startNm1 && d <= endNm1) addToMois(caParMoisNm1, m.dateFactureAcompte, m.montantAcompte);
      }

      // Solde N
      if (m.dateFactureFinale) {
        const montantSolde = m.ca - m.montantAcompte;
        if (montantSolde > 0) {
          const d = new Date(m.dateFactureFinale);
          if (d >= startDate && d <= endDate) { montantPeriode += montantSolde; addToMois(caParMoisN, m.dateFactureFinale, montantSolde); }
          if (d >= startNm1 && d <= endNm1) addToMois(caParMoisNm1, m.dateFactureFinale, montantSolde);
        }
      }

      if (montantPeriode > 0) {
        ca += montantPeriode;
        const sub = m.subventionne || 'Non';
        bySubventionne[sub] = (bySubventionne[sub] || 0) + montantPeriode;
        const acq = m.acquisition || 'Non défini';
        byAcquisition[acq] = (byAcquisition[acq] || 0) + montantPeriode;
        const nat = m.natureMission || 'Non défini';
        byNatureMission[nat] = (byNatureMission[nat] || 0) + montantPeriode;
        const tc = m.typeCa || 'Non défini';
        byTypeCa[tc] = (byTypeCa[tc] || 0) + montantPeriode;
        const client = m.client || 'Sans client';
        byClient[client] = (byClient[client] || 0) + montantPeriode;
      }
    }

    const toArray = obj => Object.entries(obj)
      .map(([label, montant]) => ({ label, montant: Math.round(montant) }))
      .sort((a, b) => b.montant - a.montant);

    // Mois couverts par la période N
    const moisLabels = [];
    const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const last = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    while (cur <= last) {
      moisLabels.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }

    res.json({
      start, end,
      ca: Math.round(ca),
      bySubventionne: toArray(bySubventionne),
      byAcquisition: toArray(byAcquisition),
      byNatureMission: toArray(byNatureMission),
      byTypeCa: toArray(byTypeCa),
      byClient: toArray(byClient),
      comparaison: {
        mois: moisLabels,
        N: moisLabels.map(m => Math.round(caParMoisN[m] || 0)),
        Nm1: moisLabels.map(m => {
          const [y, mo] = m.split('-');
          return Math.round(caParMoisNm1[`${parseInt(y) - 1}-${mo}`] || 0);
        }),
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur analytics:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/missions', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Paramètres start et end requis' });
    const startDate = new Date(start);
    const endDate = new Date(end); endDate.setHours(23, 59, 59, 999);
    const missions = await fetchAllNotionMissions();
    const result = [];
    for (const m of missions) {
      const lignes = [];
      if (m.dateFactureAcompte && m.montantAcompte > 0) {
        const d = new Date(m.dateFactureAcompte);
        if (d >= startDate && d <= endDate) lignes.push({ type: 'Acompte', date: m.dateFactureAcompte, montant: m.montantAcompte });
      }
      if (m.dateFactureFinale) {
        const montantSolde = m.ca - m.montantAcompte;
        if (montantSolde > 0) {
          const d = new Date(m.dateFactureFinale);
          if (d >= startDate && d <= endDate) lignes.push({ type: 'Solde', date: m.dateFactureFinale, montant: montantSolde });
        }
      }
      if (lignes.length > 0) {
        result.push({
          mission: m.nom || 'Sans nom',
          client: m.client || 'Sans client',
          lignes,
          total: lignes.reduce((s, l) => s + l.montant, 0),
        });
      }
    }
    result.sort((a, b) => b.total - a.total);
    res.json(result);
  } catch (err) {
    console.error('Erreur /api/analytics/missions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/charges', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Paramètres start et end requis' });

    const org = await qontoRequest('/v2/organization');
    const bankAccounts = org.organization.bank_accounts || [];
    if (bankAccounts.length === 0) return res.status(404).json({ error: 'Aucun compte Qonto' });
    const mainAccount = bankAccounts.reduce((a, b) => (b.balance_cents > a.balance_cents ? b : a));
    const iban = mainAccount.iban;

    async function fetchDebitsByRange(ibanVal, fromDate, toDate) {
      const txs = [];
      let page = 1;
      while (true) {
        const result = await qontoRequest(
          `/v2/transactions?iban=${ibanVal}&status[]=completed&sort_by=settled_at:desc&per_page=100&current_page=${page}&settled_at_from=${fromDate}&settled_at_to=${toDate}`
        );
        const batch = result.transactions || [];
        txs.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
      return txs.filter(tx => tx.side === 'debit');
    }

    function agregParMois(txs) {
      const map = {};
      for (const tx of txs) {
        if (!tx.settled_at) continue;
        const d = new Date(tx.settled_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        map[key] = (map[key] || 0) + tx.amount;
      }
      return map;
    }

    const startD = new Date(start);
    const endD = new Date(end + 'T23:59:59');
    const startNm1 = new Date(startD); startNm1.setFullYear(startNm1.getFullYear() - 1);
    const endNm1 = new Date(endD); endNm1.setFullYear(endNm1.getFullYear() - 1);

    const [txsN, txsNm1] = await Promise.all([
      fetchDebitsByRange(iban, startD.toISOString(), endD.toISOString()),
      fetchDebitsByRange(iban, startNm1.toISOString(), endNm1.toISOString()),
    ]);

    const chargesParCategorie = {};
    const chargesParSousCategorie = {};
    for (const tx of txsN) {
      const cat = (tx.cashflow_category && tx.cashflow_category.name) || tx.category || 'Non catégorisé';
      const sousCat = (tx.cashflow_subcategory && tx.cashflow_subcategory.name) || null;
      chargesParCategorie[cat] = (chargesParCategorie[cat] || 0) + tx.amount;
      const sousCatKey = sousCat ? `${cat} > ${sousCat}` : cat;
      if (!chargesParSousCategorie[sousCatKey]) chargesParSousCategorie[sousCatKey] = { categorie: cat, sousCat: sousCat || null, montant: 0 };
      chargesParSousCategorie[sousCatKey].montant += tx.amount;
    }

    const ventilationCharges = Object.entries(chargesParCategorie)
      .map(([categorie, montant]) => ({ categorie, montant }))
      .sort((a, b) => b.montant - a.montant);
    const ventilationChargesDetail = Object.values(chargesParSousCategorie)
      .sort((a, b) => b.montant - a.montant);

    const totalCharges = ventilationCharges.reduce((s, c) => s + c.montant, 0);
    const nbMois = Math.max(1, Math.round((endD - startD) / (1000 * 60 * 60 * 24 * 30.5)));
    const moyenneMensuelle = totalCharges / nbMois;

    const chargesParMoisN = agregParMois(txsN);
    const chargesParMoisNm1 = agregParMois(txsNm1);

    // Liste des mois couverts par la période N (labels)
    const moisLabels = [];
    const cur = new Date(startD.getFullYear(), startD.getMonth(), 1);
    const last = new Date(endD.getFullYear(), endD.getMonth(), 1);
    while (cur <= last) {
      moisLabels.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }

    res.json({
      ventilationCharges, ventilationChargesDetail,
      totalCharges, moyenneMensuelle,
      comparaison: {
        mois: moisLabels,
        N: moisLabels.map(m => Math.round(chargesParMoisN[m] || 0)),
        Nm1: moisLabels.map(m => {
          const [y, mo] = m.split('-');
          const keyNm1 = `${parseInt(y) - 1}-${mo}`;
          return Math.round(chargesParMoisNm1[keyNm1] || 0);
        }),
      },
    });
  } catch (err) {
    console.error('Erreur /api/charges:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/charges-hybride', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Paramètres start et end requis' });

    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const startKey = start.slice(0, 7);
    const endKey   = end.slice(0, 7);

    // Séparation des périodes
    const realEndKey   = endKey <= todayKey ? endKey : todayKey;
    const hasReal      = start <= realEndKey;
    const nextMonth    = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthKey = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`;
    const prevStartKey = start > todayKey ? start : nextMonthKey;
    const hasPrev      = prevStartKey <= end;

    // --- Partie réelle (Qonto) ---
    let realTotal = 0;
    let chargesParMoisN    = {};
    let chargesParMoisNm1  = {};
    let realVentilation    = [];
    let realSubVentilation = [];

    // Qonto : on fetch toujours le N-1 sur la totalité de la période (pas seulement la partie réelle)
    // pour que les barres N-1 s'affichent aussi pour les mois futurs (ex. Avr-Déc 2025 vs Avr-Déc 2026)
    const fetchDebitsHybride = async (ibanVal, from, to) => {
      const txs = []; let page = 1;
      while (true) {
        const r = await qontoRequest(
          `/v2/transactions?iban=${ibanVal}&status[]=completed&sort_by=settled_at:desc&per_page=100&current_page=${page}&settled_at_from=${from}&settled_at_to=${to}`
        );
        const batch = r.transactions || [];
        txs.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
      return txs.filter(t => t.side === 'debit');
    };

    if (hasReal || hasPrev) {
      const org = await qontoRequest('/v2/organization');
      const bankAccounts = org.organization.bank_accounts || [];
      const mainAccount  = bankAccounts.reduce((a, b) => (b.balance_cents > a.balance_cents ? b : a));
      const iban = mainAccount.iban;

      // N réel : seulement la période passée
      // N-1 : toute la période sélectionnée décalée d'un an (pour comparer même les mois futurs)
      const fullStartD = new Date(startKey + '-01');
      const fullEndD   = new Date(endKey   + '-28T23:59:59');
      const nm1StartD  = new Date(fullStartD); nm1StartD.setFullYear(nm1StartD.getFullYear() - 1);
      const nm1EndD    = new Date(fullEndD);   nm1EndD.setFullYear(nm1EndD.getFullYear() - 1);

      const fetches = [fetchDebitsHybride(iban, nm1StartD.toISOString(), nm1EndD.toISOString())];
      if (hasReal) {
        const realStartD = new Date(startKey + '-01');
        const realEndD   = new Date(realEndKey + '-28T23:59:59');
        fetches.unshift(fetchDebitsHybride(iban, realStartD.toISOString(), realEndD.toISOString()));
      }

      const results = await Promise.all(fetches);
      const txsNm1 = hasReal ? results[1] : results[0];
      const txsN   = hasReal ? results[0] : [];

      const catMap = {};
      const subCatMap = {};
      for (const tx of txsN) {
        const cat = (tx.cashflow_category && tx.cashflow_category.name) || tx.category || 'Non catégorisé';
        const sousCat = (tx.cashflow_subcategory && tx.cashflow_subcategory.name) || null;
        catMap[cat] = (catMap[cat] || 0) + tx.amount;
        const subKey = sousCat ? `${cat}||${sousCat}` : `${cat}||`;
        if (!subCatMap[subKey]) subCatMap[subKey] = { categorie: cat, sousCat, montant: 0 };
        subCatMap[subKey].montant += tx.amount;
        const d = new Date(tx.settled_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        chargesParMoisN[key] = (chargesParMoisN[key] || 0) + tx.amount;
      }
      for (const tx of txsNm1) {
        const d = new Date(tx.settled_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        chargesParMoisNm1[key] = (chargesParMoisNm1[key] || 0) + tx.amount;
      }

      realVentilation = Object.entries(catMap).map(([categorie, montant]) => ({ categorie, montant }));
      realSubVentilation = Object.values(subCatMap);
      realTotal = realVentilation.reduce((s, v) => s + v.montant, 0);
    }

    // --- Partie prévisionnelle (GSheet) ---
    let prevTotal = 0;
    let chargesGSheetParMois = {};
    let prevVentilation = [];

    let prevSubVentilation = [];
    let chargesGSheetParMoisNm1 = {};
    if (hasPrev) {
      const { budgetCols, categories, subCategories } = await fetchAndParseCRPrev();
      const cols = budgetCols.filter(c => c.key >= prevStartKey && c.key <= end);
      const catMap = {};
      for (const [cat, monthMap] of Object.entries(categories)) {
        for (const col of cols) {
          const v = monthMap[col.key] || 0;
          if (v !== 0) {
            catMap[cat] = (catMap[cat] || 0) + v;
            chargesGSheetParMois[col.key] = (chargesGSheetParMois[col.key] || 0) + v;
          }
        }
        // GSheet N-1 : pour chaque mois futur, chercher la valeur de l'année précédente dans le GSheet
        for (const col of cols) {
          const [y, mo] = col.key.split('-');
          const nm1Key = `${parseInt(y) - 1}-${mo}`;
          const v = monthMap[nm1Key] || 0;
          if (v !== 0) chargesGSheetParMoisNm1[nm1Key] = (chargesGSheetParMoisNm1[nm1Key] || 0) + v;
        }
      }
      prevVentilation = Object.entries(catMap).map(([categorie, montant]) => ({ categorie, montant: Math.round(montant) }));
      prevTotal = prevVentilation.reduce((s, v) => s + v.montant, 0);
      // Sous-catégories GSheet
      for (const [parent, subs] of Object.entries(subCategories)) {
        for (const [subName, monthMap] of Object.entries(subs)) {
          const montant = cols.reduce((acc, c) => acc + (monthMap[c.key] || 0), 0);
          if (montant > 0) prevSubVentilation.push({ categorie: parent, sousCat: subName, montant: Math.round(montant) });
        }
      }
    }

    // --- Ventilation fusionnée (catégories mères) ---
    const ventMap = {};
    for (const v of realVentilation) ventMap[v.categorie] = (ventMap[v.categorie] || 0) + v.montant;
    for (const v of prevVentilation) ventMap[v.categorie] = (ventMap[v.categorie] || 0) + v.montant;
    const ventilationCharges = Object.entries(ventMap)
      .map(([categorie, montant]) => ({ categorie, montant: Math.round(montant) }))
      .sort((a, b) => b.montant - a.montant);

    // --- Ventilation fusionnée (sous-catégories) ---
    const subMap = {};
    const makeSubKey = (cat, sub) => `${cat}||${sub || ''}`;
    for (const v of [...realSubVentilation, ...prevSubVentilation]) {
      const k = makeSubKey(v.categorie, v.sousCat);
      if (!subMap[k]) subMap[k] = { categorie: v.categorie, sousCat: v.sousCat, montant: 0 };
      subMap[k].montant += v.montant;
    }
    const ventilationChargesDetail = Object.values(subMap).sort((a, b) => b.montant - a.montant);

    const totalCharges = Math.round(realTotal + prevTotal);

    // --- Mois labels + comparaison (sans Date objects pour éviter les bugs de timezone) ---
    const moisLabels = [];
    let [cy, cm] = startKey.split('-').map(Number);
    const [ey, em] = endKey.split('-').map(Number);
    while (cy < ey || (cy === ey && cm <= em)) {
      moisLabels.push(`${cy}-${String(cm).padStart(2, '0')}`);
      cm++; if (cm > 12) { cm = 1; cy++; }
    }

    res.json({
      real: hasReal ? { total: Math.round(realTotal), start: startKey, end: realEndKey.slice(0, 7) } : null,
      prev: hasPrev ? { total: prevTotal, start: prevStartKey.slice(0, 7), end: endKey } : null,
      ventilationCharges,
      ventilationChargesDetail,
      totalCharges,
      moyenneMensuelle: moisLabels.length > 0 ? Math.round(totalCharges / moisLabels.length) : 0,
      comparaison: {
        mois: moisLabels,
        N:    moisLabels.map(k => Math.round(chargesParMoisN[k] || chargesGSheetParMois[k] || 0)),
        Nm1:  moisLabels.map(k => {
          const [y, mo] = k.split('-');
          const nm1Key = `${parseInt(y) - 1}-${mo}`;
          return Math.round(chargesParMoisNm1[nm1Key] || chargesGSheetParMoisNm1[nm1Key] || 0);
        }),
      },
    });
  } catch (err) {
    console.error('Erreur /api/charges-hybride:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/previsionnel', async (_req, res) => {
  crPrevCache = null;
  try {
    const url = `https://docs.google.com/spreadsheets/d/e/${GSHEET_PUBLISHED_ID}/pub?output=csv&gid=${CRPREV_GID}`;
    const csvText = await fetchCSV(url);
    const rows = parseCsvCRPrev(csvText);

    // Trouver la ligne des mois
    let monthRowIdx = -1;
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      if (rows[i].some(cell => /^\d{2}\/\d{4}$/.test(cell.trim()))) { monthRowIdx = i; break; }
    }

    // Afficher les 10 lignes autour de monthRowIdx + les premières colonnes
    const sampleRows = [];
    const start = Math.max(0, monthRowIdx);
    for (let r = start; r < Math.min(start + 12, rows.length); r++) {
      sampleRows.push({
        rowIndex: r,
        col0: rows[r][0],
        col1: rows[r][1],
        col2: rows[r][2],
        col3: rows[r][3],
        col4: rows[r][4],
        col5: rows[r][5],
      });
    }

    const { budgetCols, categories } = await fetchAndParseCRPrev();
    res.json({ monthRowIdx, budgetCols: budgetCols.slice(0, 5), categories, sampleRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/previsionnel-charges', async (req, res) => {
  try {
    const { start, end } = req.query; // format "YYYY-MM"
    const { budgetCols, categories, subCategories } = await fetchAndParseCRPrev();

    // Filtrer les colonnes dans la période
    const cols = budgetCols.filter(c => (!start || c.key >= start) && (!end || c.key <= end));

    if (cols.length === 0) return res.json({
      ventilationCharges: [], ventilationChargesDetail: [], totalCharges: 0, moyenneMensuelle: 0,
      comparaison: { mois: [], N: [], Nm1: [] },
    });

    // Ventilation par catégorie mère sur la période
    const totals = {};
    for (const [cat, monthMap] of Object.entries(categories)) {
      const sum = cols.reduce((acc, c) => acc + (monthMap[c.key] || 0), 0);
      if (sum > 0) totals[cat] = sum;
    }
    const totalCharges = Object.values(totals).reduce((a, b) => a + b, 0);
    const moyenneMensuelle = cols.length > 0 ? Math.round(totalCharges / cols.length) : 0;
    const ventilationCharges = Object.entries(totals)
      .map(([categorie, montant]) => ({ categorie, montant: Math.round(montant), pourcentage: totalCharges > 0 ? Math.round(montant / totalCharges * 100) : 0 }))
      .sort((a, b) => b.montant - a.montant);

    // Ventilation par sous-catégorie (pour le mode détail)
    const ventilationChargesDetail = [];
    for (const [parent, subs] of Object.entries(subCategories)) {
      for (const [subName, monthMap] of Object.entries(subs)) {
        const montant = cols.reduce((acc, c) => acc + (monthMap[c.key] || 0), 0);
        if (montant > 0) ventilationChargesDetail.push({ categorie: parent, sousCat: subName, montant: Math.round(montant) });
      }
    }
    ventilationChargesDetail.sort((a, b) => b.montant - a.montant);

    // Comparaison N vs N-1
    const moisLabels = cols.map(c => c.key);
    const N = moisLabels.map(key =>
      Math.round(Object.values(categories).reduce((acc, monthMap) => acc + (monthMap[key] || 0), 0))
    );
    const Nm1 = moisLabels.map(key => {
      const [y, mo] = key.split('-');
      const keyNm1 = `${parseInt(y) - 1}-${mo}`;
      return Math.round(Object.values(categories).reduce((acc, monthMap) => acc + (monthMap[keyNm1] || 0), 0));
    });

    res.json({
      ventilationCharges,
      ventilationChargesDetail,
      totalCharges: Math.round(totalCharges),
      moyenneMensuelle,
      comparaison: { mois: moisLabels, N, Nm1 },
    });
  } catch (err) {
    console.error('Erreur /api/previsionnel-charges:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PROSPECTOR — Routes
// ============================================================

// Serve prospector.html with injected Supabase env vars
app.get('/prospector', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'prospector.html'), 'utf8');
  html = html.replace('__SUPABASE_URL__', process.env.SUPABASE_URL || '');
  html = html.replace('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
  res.send(html);
});

// GET /api/prospector/campaigns — List campaigns sorted by priority
app.get('/api/prospector/campaigns', async (req, res) => {
  try {
    let q = supabase.from('campaigns').select('*').order('priority', { ascending: true, nullsFirst: false });

    if (req.query.status) {
      q = q.eq('status', req.query.status);
    } else if (req.query.active === 'true') {
      q = q.in('status', ['À lancer', 'En cours', 'En suivi']);
    }

    const { data: campaigns, error } = await q;
    if (error) throw error;

    // Attach prospect counts
    const result = [];
    for (const c of campaigns) {
      const { count } = await supabase.from('prospects').select('id', { count: 'exact', head: true }).eq('source_campaign_id', c.id);
      result.push({ ...c, prospects_count: count || 0 });
    }

    res.json(result);
  } catch (err) {
    console.error('Erreur GET /api/prospector/campaigns:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/prospects — List prospects (optionally filtered by campaign_id)
app.get('/api/prospector/prospects', async (req, res) => {
  try {
    let q = supabase.from('prospects').select('id, first_name, last_name, linkedin_url, company, job_title, email, phone, sector, geography, status, source_campaign_id, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (req.query.campaign_id) q = q.eq('source_campaign_id', req.query.campaign_id);
    if (req.query.status) q = q.eq('status', req.query.status);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur GET /api/prospector/prospects:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: shift priorities to make room for a given priority
async function shiftPriorities(targetPrio, excludeId) {
  // Get all campaigns with priority >= targetPrio, sorted ascending
  let q = supabase.from('campaigns').select('id, priority')
    .gte('priority', targetPrio).order('priority', { ascending: true });
  if (excludeId) q = q.neq('id', excludeId);
  const { data: toShift } = await q;
  if (!toShift?.length) return;

  // Shift each one by +1, starting from the highest to avoid unique constraint conflicts
  for (let i = toShift.length - 1; i >= 0; i--) {
    const c = toShift[i];
    // Only shift if it's actually blocking (contiguous)
    if (i === 0 || toShift[i].priority === toShift[i - 1]?.priority + 1 || toShift[i].priority === targetPrio) {
      await supabase.from('campaigns').update({ priority: c.priority + 1 }).eq('id', c.id);
    }
  }
}

// POST /api/prospector/campaigns — Create campaign with priority auto-shift
app.post('/api/prospector/campaigns', async (req, res) => {
  try {
    const { name, status, priority, criteria, daily_quota, sector, geography, details, excluded_keywords, objectives } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const prio = priority != null ? parseInt(priority) : null;

    // Auto-shift existing priorities if conflict
    if (prio != null) {
      const { data: existing } = await supabase.from('campaigns').select('id').eq('priority', prio);
      if (existing?.length) await shiftPriorities(prio, null);
    }

    const row = {
      name,
      status: status || 'À lancer',
      priority: prio,
      criteria: criteria || {},
      daily_quota: daily_quota != null ? parseInt(daily_quota) : 20,
      sector: sector || null,
      geography: geography || null,
      details: details || null,
      excluded_keywords: excluded_keywords || [],
      objectives: objectives || [],
    };

    const { data, error } = await supabase.from('campaigns').insert(row).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Erreur POST /api/prospector/campaigns:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prospector/campaigns/:id — Update campaign with priority auto-shift
app.put('/api/prospector/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    const allowed = ['name', 'status', 'priority', 'criteria', 'daily_quota', 'sector', 'geography', 'details', 'excluded_keywords', 'objectives'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (updates.priority != null) {
      updates.priority = parseInt(updates.priority);
      const { data: existing } = await supabase.from('campaigns').select('id').eq('priority', updates.priority).neq('id', id);
      if (existing?.length) await shiftPriorities(updates.priority, id);
    }
    if (updates.daily_quota != null) updates.daily_quota = parseInt(updates.daily_quota);

    const { data, error } = await supabase.from('campaigns').update(updates).eq('id', id).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Cette priorité est déjà utilisée.' });
      throw error;
    }
    res.json(data);
  } catch (err) {
    console.error('Erreur PUT /api/prospector/campaigns/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/import — Bulk import from Claude Dispatch or external
app.post('/api/prospector/import', async (req, res) => {
  try {
    const { prospects, campaign_id, skip_duplicates = true } = req.body;
    if (!prospects || !Array.isArray(prospects)) {
      return res.status(400).json({ error: 'prospects array required' });
    }

    // Fetch existing prospects for dedup
    const { data: existing } = await supabase.from('prospects').select('email, linkedin_url, first_name, last_name');

    let imported = 0, duplicates = 0, errors = 0;
    const toInsert = [];

    for (const p of prospects) {
      const isDupe = (existing || []).some(e =>
        (p.email && e.email && p.email.toLowerCase() === e.email.toLowerCase()) ||
        (p.linkedin_url && e.linkedin_url && p.linkedin_url === e.linkedin_url) ||
        (p.first_name && p.last_name && e.first_name &&
         e.first_name.toLowerCase() === p.first_name.toLowerCase() &&
         e.last_name.toLowerCase() === p.last_name.toLowerCase())
      );

      if (isDupe) {
        duplicates++;
        if (skip_duplicates) continue;
      }

      const row = {
        first_name: p.first_name || '',
        last_name: p.last_name || '',
        email: p.email || null,
        phone: p.phone || null,
        linkedin_url: p.linkedin_url || null,
        company: p.company || null,
        job_title: p.job_title || null,
        sector: p.sector || null,
        geography: p.geography || null,
      };
      if (campaign_id) row.source_campaign_id = campaign_id;
      toInsert.push(row);
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('prospects').insert(toInsert);
      if (error) {
        console.error('Bulk insert error:', error.message);
        errors = toInsert.length;
      } else {
        imported = toInsert.length;
      }
    }

    // Log import
    await supabase.from('imports').insert({
      filename: 'api-import',
      total_rows: prospects.length,
      imported, duplicates, errors,
    });

    res.json({ imported, duplicates, errors });
  } catch (err) {
    console.error('Erreur /api/prospector/import:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/export — CSV export
app.get('/api/prospector/export', async (req, res) => {
  try {
    let q = supabase.from('prospects').select('*');
    if (req.query.status) q = q.eq('status', req.query.status);
    if (req.query.sector) q = q.eq('sector', req.query.sector);
    if (req.query.geography) q = q.eq('geography', req.query.geography);
    if (req.query.campaign_id) q = q.eq('source_campaign_id', req.query.campaign_id);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;

    const fields = ['first_name','last_name','email','phone','linkedin_url','company','job_title','sector','geography','status'];
    const header = fields.join(',');
    const rows = (data || []).map(r => fields.map(f => `"${(r[f] || '').replace(/"/g, '""')}"`).join(','));
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prospects-export.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Erreur /api/prospector/export:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PROSPECTOR — Claude Dispatch endpoints
// ============================================================

const VALID_PROSPECT_STATUSES = [
  'Profil à valider','Nouveau','Invitation envoyée','Invitation acceptée',
  'Message à valider','Message à envoyer','Message envoyé',
  'Réponse reçue','RDV planifié','Gagné','Perdu','Non pertinent'
];

// --- Daily quotas ---
const DAILY_INVITATION_LIMIT = parseInt(process.env.PROSPECTOR_INVITATION_LIMIT) || 23;
const DAILY_MESSAGE_LIMIT = parseInt(process.env.PROSPECTOR_MESSAGE_LIMIT) || 23;

function todayParis() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // "YYYY-MM-DD"
}

async function countTodayInvitations() {
  const today = todayParis();
  const { count } = await supabase.from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'Ajout LinkedIn')
    .eq('date', today);
  return count || 0;
}

async function countTodayMessages() {
  const today = todayParis();
  const { count } = await supabase.from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'Message envoyé')
    .eq('date', today);
  return count || 0;
}

// GET /api/prospector/daily-stats
app.get('/api/prospector/daily-stats', async (req, res) => {
  try {
    const invSent = await countTodayInvitations();
    const msgSent = await countTodayMessages();
    res.json({
      date: todayParis(),
      quotas: {
        invitations: { sent_today: invSent, limit: DAILY_INVITATION_LIMIT, remaining: Math.max(0, DAILY_INVITATION_LIMIT - invSent) },
        messages:    { sent_today: msgSent,  limit: DAILY_MESSAGE_LIMIT,    remaining: Math.max(0, DAILY_MESSAGE_LIMIT - msgSent) },
      },
    });
  } catch (err) {
    console.error('Erreur /api/prospector/daily-stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/sync — Upsert prospects (create or update by linkedin_url)
// Used by Claude Dispatch after LinkedIn actions
app.post('/api/prospector/sync', async (req, res) => {
  try {
    const { prospects, campaign_id } = req.body;
    if (!prospects || !Array.isArray(prospects)) {
      return res.status(400).json({ error: 'prospects array required' });
    }

    // Quota check: count new invitations in this batch
    const newInvitations = prospects.filter(p => p.status === 'Invitation envoyée').length;
    if (newInvitations > 0) {
      const invSent = await countTodayInvitations();
      if (invSent + newInvitations > DAILY_INVITATION_LIMIT) {
        return res.status(429).json({
          error: "Quota journalier d'invitations atteint",
          quota: { sent_today: invSent, limit: DAILY_INVITATION_LIMIT, remaining: Math.max(0, DAILY_INVITATION_LIMIT - invSent) },
        });
      }
    }

    let created = 0, updated = 0, errors = 0;

    for (const p of prospects) {
      try {
        let existing = null;

        // Find by linkedin_url first (most reliable)
        if (p.linkedin_url) {
          const { data } = await supabase.from('prospects')
            .select('id').eq('linkedin_url', p.linkedin_url).limit(1);
          if (data?.length) existing = data[0];
        }

        // Fallback: find by first_name + last_name
        if (!existing && p.first_name && p.last_name) {
          const { data } = await supabase.from('prospects')
            .select('id')
            .ilike('first_name', p.first_name)
            .ilike('last_name', p.last_name)
            .limit(1);
          if (data?.length) existing = data[0];
        }

        if (existing) {
          // Update existing prospect
          const updates = {};
          if (p.status && VALID_PROSPECT_STATUSES.includes(p.status)) updates.status = p.status;
          if (p.company) updates.company = p.company;
          if (p.job_title) updates.job_title = p.job_title;
          if (p.email) updates.email = p.email;
          if (p.phone) updates.phone = p.phone;
          if (p.sector) updates.sector = p.sector;
          if (p.geography) updates.geography = p.geography;
          if (p.linkedin_url) updates.linkedin_url = p.linkedin_url;
          if (p.pending_message !== undefined) updates.pending_message = p.pending_message;
          if (p.notes) updates.notes = p.notes;
          updates.updated_at = new Date().toISOString();

          await supabase.from('prospects').update(updates).eq('id', existing.id);
          updated++;

          // Log interaction if provided
          if (p.interaction) {
            await supabase.from('interactions').insert({
              prospect_id: existing.id,
              type: p.interaction.type || 'Note',
              date: p.interaction.date || new Date().toISOString().split('T')[0],
              content: p.interaction.content || '',
            });
          }
        } else {
          // Create new prospect
          const row = {
            first_name: p.first_name || '',
            last_name: p.last_name || '',
            email: p.email || null,
            phone: p.phone || null,
            linkedin_url: p.linkedin_url || null,
            company: p.company || null,
            job_title: p.job_title || null,
            sector: p.sector || null,
            geography: p.geography || null,
            status: (p.status && VALID_PROSPECT_STATUSES.includes(p.status)) ? p.status : 'Nouveau',
            pending_message: p.pending_message || null,
          };
          if (campaign_id) row.source_campaign_id = campaign_id;

          const { data: newP } = await supabase.from('prospects').insert(row).select('id').single();
          created++;

          // Log interaction if provided
          if (p.interaction && newP) {
            await supabase.from('interactions').insert({
              prospect_id: newP.id,
              type: p.interaction.type || 'Ajout LinkedIn',
              date: p.interaction.date || new Date().toISOString().split('T')[0],
              content: p.interaction.content || '',
            });
          }
        }
      } catch (err) {
        console.error('Sync error for prospect:', p.first_name, p.last_name, err.message);
        errors++;
      }
    }

    res.json({ created, updated, errors, total: prospects.length });
  } catch (err) {
    console.error('Erreur /api/prospector/sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/update-status — Update a prospect's status (by linkedin_url or id)
app.post('/api/prospector/update-status', async (req, res) => {
  try {
    const { linkedin_url, id, status, pending_message, message_versions } = req.body;
    if (!status || !VALID_PROSPECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Valid: ' + VALID_PROSPECT_STATUSES.join(', ') });
    }

    let prospectId = id;
    if (!prospectId && linkedin_url) {
      const { data } = await supabase.from('prospects').select('id').eq('linkedin_url', linkedin_url).limit(1);
      if (!data?.length) return res.status(404).json({ error: 'Prospect not found' });
      prospectId = data[0].id;
    }
    if (!prospectId) return res.status(400).json({ error: 'id or linkedin_url required' });

    const updates = { status, updated_at: new Date().toISOString() };
    if (pending_message !== undefined) updates.pending_message = pending_message;
    if (message_versions !== undefined) updates.message_versions = message_versions;

    await supabase.from('prospects').update(updates).eq('id', prospectId);
    res.json({ success: true, id: prospectId, status });
  } catch (err) {
    console.error('Erreur /api/prospector/update-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/pending-messages — Get prospects with status "Message à envoyer" (validated by user)
// Claude Dispatch polls this to know which messages to send on LinkedIn
app.get('/api/prospector/pending-messages', async (req, res) => {
  try {
    const { data, error } = await supabase.from('prospects')
      .select('id, first_name, last_name, linkedin_url, pending_message, message_versions')
      .eq('status', 'Message à envoyer');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur /api/prospector/pending-messages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/message-sent — Mark a message as sent (called by Dispatch after sending on LinkedIn)
app.post('/api/prospector/message-sent', async (req, res) => {
  try {
    // Quota check
    const msgSent = await countTodayMessages();
    if (msgSent >= DAILY_MESSAGE_LIMIT) {
      return res.status(429).json({
        error: 'Quota journalier de messages atteint',
        quota: { sent_today: msgSent, limit: DAILY_MESSAGE_LIMIT, remaining: 0 },
      });
    }

    const { linkedin_url, id } = req.body;
    let prospectId = id;
    if (!prospectId && linkedin_url) {
      const { data } = await supabase.from('prospects').select('id').eq('linkedin_url', linkedin_url).limit(1);
      if (!data?.length) return res.status(404).json({ error: 'Prospect not found' });
      prospectId = data[0].id;
    }
    if (!prospectId) return res.status(400).json({ error: 'id or linkedin_url required' });

    await supabase.from('prospects').update({
      status: 'Message envoyé',
      pending_message: null,
      updated_at: new Date().toISOString(),
    }).eq('id', prospectId);

    await supabase.from('interactions').insert({
      prospect_id: prospectId,
      type: 'Message envoyé',
      date: new Date().toISOString().split('T')[0],
      content: 'Message LinkedIn envoyé via Claude Dispatch',
    });

    res.json({ success: true, id: prospectId });
  } catch (err) {
    console.error('Erreur /api/prospector/message-sent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/validated-profiles — Prospects validated by Nathan, ready for LinkedIn add
app.get('/api/prospector/validated-profiles', async (req, res) => {
  try {
    const { data, error } = await supabase.from('prospects')
      .select('id, first_name, last_name, linkedin_url, company, job_title, source_campaign_id, campaigns(name)')
      .eq('status', 'Nouveau')
      .not('linkedin_url', 'is', null);
    if (error) throw error;
    res.json((data || []).map(p => ({
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      linkedin_url: p.linkedin_url,
      company: p.company,
      job_title: p.job_title,
      campaign_id: p.source_campaign_id,
      campaign_name: p.campaigns?.name || null,
    })));
  } catch (err) {
    console.error('Erreur /api/prospector/validated-profiles:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/bulk-update-status — Bulk update prospect statuses
app.post('/api/prospector/bulk-update-status', async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids (array) and status required' });
    if (!VALID_PROSPECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Valid: ' + VALID_PROSPECT_STATUSES.join(', ') });
    }
    const { error } = await supabase.from('prospects').update({ status, updated_at: new Date().toISOString() }).in('id', ids);
    if (error) throw error;
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    console.error('Erreur /api/prospector/bulk-update-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/regenerate-messages — Regenerate message versions via Claude API
app.post('/api/prospector/regenerate-messages', async (req, res) => {
  try {
    const { linkedin_url, id, instructions } = req.body;
    let prospectId = id;
    if (!prospectId && linkedin_url) {
      const { data } = await supabase.from('prospects').select('id').eq('linkedin_url', linkedin_url).limit(1);
      if (!data?.length) return res.status(404).json({ error: 'Prospect not found' });
      prospectId = data[0].id;
    }
    if (!prospectId) return res.status(400).json({ error: 'id or linkedin_url required' });

    // Fetch prospect + campaign
    const { data: prospect } = await supabase.from('prospects')
      .select('*, campaigns(name, sector, geography, criteria, objectives)')
      .eq('id', prospectId).single();
    if (!prospect) return res.status(404).json({ error: 'Prospect not found' });

    const camp = prospect.campaigns || {};
    const criteria = camp.criteria || {};
    const objectives = (camp.objectives || []).join(', ') || 'non définis';
    const jobTitles = (criteria.job_titles || []).join(', ') || 'non définis';

    const systemPrompt = `Tu rédiges deux messages LinkedIn de prospection courts pour Nathan.

Prospect : ${prospect.first_name} ${prospect.last_name}, ${prospect.job_title || 'poste inconnu'} chez ${prospect.company || 'entreprise inconnue'}
Campagne : secteur ${camp.sector || criteria.sector || 'non défini'}, zone ${camp.geography || criteria.geography || 'non définie'}, postes ciblés ${jobTitles}
Objectifs de la campagne : ${objectives}
${instructions ? `Instructions supplémentaires : ${instructions}` : ''}

Règles absolues :
- Vouvoiement (vous, votre) — jamais de tutoiement
- ZÉRO ligne vide entre les lignes — le message est un bloc continu
- La phrase après "Bonjour ${prospect.first_name}," commence par une minuscule
- Pas de pitch commercial — ne pas mentionner Releaf Carbon ni ses services
- Ton direct, humain, sans jargon
- CTA = question ouverte, 5 à 8 mots maximum

VERSION A — Angle "problème" — EXACTEMENT 3 lignes :
Ligne 1 : "Bonjour ${prospect.first_name},"
Ligne 2 : observation courte sur une tension ou un enjeu lié à leur rôle / secteur / objectifs
Ligne 3 : CTA court (5-8 mots) — question ouverte sur leur vécu

Exemple de Version A :
"Bonjour Claire,
les directions RSE de votre secteur jonglent souvent entre reporting réglementaire et démarches de fond — deux vitesses difficiles à réconcilier.
Comment vous organisez-vous face à ça ?"

VERSION B — Angle "opportunité" — EXACTEMENT 4 lignes :
Ligne 1 : "Bonjour ${prospect.first_name},"
Ligne 2 : observation sur leur secteur ou leur profil
Ligne 3 : phrase de contexte ou tension sous-jacente
Ligne 4 : CTA court (5-8 mots) — question stratégique invitant à prendre du recul

Exemple de Version B :
"Bonjour Marc,
votre secteur est en train de basculer vers une exigence carbone plus structurée, au-delà du simple bilan annuel.
Certaines entreprises avancent déjà sur des trajectoires sectorielles, d'autres attendent d'y être contraintes.
Où en est votre réflexion sur ce sujet ?"

Retourne uniquement un JSON valide (pas de markdown, pas d'explication) :
{"version_a": "...", "version_b": "..."}`;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: systemPrompt }],
      }),
    });

    if (!claudeResp.ok) {
      const errBody = await claudeResp.text();
      console.error('Claude API error:', claudeResp.status, errBody);
      return res.status(502).json({ error: `Claude API error: ${claudeResp.status}` });
    }

    const claudeData = await claudeResp.json();
    const text = claudeData.content?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: 'Claude did not return valid JSON', raw: text });

    const parsed = JSON.parse(jsonMatch[0]);
    const messageVersions = [
      { label: 'Angle problème', content: parsed.version_a || '' },
      { label: 'Angle opportunité', content: parsed.version_b || '' },
    ];

    // Save to prospect
    await supabase.from('prospects').update({
      message_versions: messageVersions,
      updated_at: new Date().toISOString(),
    }).eq('id', prospectId);

    res.json({ success: true, message_versions: messageVersions });
  } catch (err) {
    console.error('Erreur /api/prospector/regenerate-messages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/pipeline-chart — snapshot du jour + 30j d'historique
app.get('/api/prospector/pipeline-chart', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Comptage actuel par statut
    const { data: prospects } = await supabase.from('prospects').select('status');
    const counts = {};
    for (const p of prospects || []) {
      if (p.status) counts[p.status] = (counts[p.status] || 0) + 1;
    }

    // Upsert snapshot du jour
    const upserts = Object.entries(counts).map(([status, count]) => ({ date: today, status, count }));
    if (upserts.length > 0) {
      await supabase.from('pipeline_snapshots').upsert(upserts, { onConflict: 'date,status' });
    }

    // Récupérer les 15 derniers jours
    const from = new Date();
    from.setDate(from.getDate() - 15);
    const fromStr = from.toISOString().split('T')[0];
    const { data: snapshots } = await supabase
      .from('pipeline_snapshots')
      .select('date,status,count')
      .gte('date', fromStr)
      .order('date', { ascending: true });

    res.json({ snapshots: snapshots || [] });
  } catch (err) {
    console.error('Erreur /api/prospector/pipeline-chart:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Releaf Pilot démarré sur http://localhost:${PORT}`);
});
