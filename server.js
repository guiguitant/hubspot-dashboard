require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const AdmZip = require('adm-zip');
const fs = require('fs');
const { execFile } = require('child_process');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { buildSalesNavUrl } = require('./utils/buildSalesNavUrl');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const { cleanEmeliaRows } = require('./utils/emeliaCleaner');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['text/csv', 'application/csv', 'text/plain'];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Seuls les fichiers .csv sont acceptés'));
    }
  },
});

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Supabase admin client (bypasses RLS for public endpoints like /api/accounts)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
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

app.use(express.json());

// Route: / — Serve Releaf Pilot (main dashboard)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pilot.html'));
});

// Route: /prospector-app — Redirect to /prospector (legacy compatibility)
app.get('/prospector-app', (req, res) => {
  res.redirect('/prospector');
});

// Sync legacy files from public/ → dist/ at startup (public/ is source of truth)
// HTML pages
['pilot.html', 'prospector.html'].forEach(file => {
  const src = path.join(__dirname, 'public', file);
  const dst = path.join(__dirname, 'dist', file);
  if (fs.existsSync(src) && fs.existsSync(path.dirname(dst))) {
    fs.copyFileSync(src, dst);
  }
});
// JS and CSS directories
['js', 'css'].forEach(dir => {
  const srcDir = path.join(__dirname, 'public', dir);
  const dstDir = path.join(__dirname, 'dist', dir);
  if (fs.existsSync(srcDir) && fs.existsSync(dstDir)) {
    fs.readdirSync(srcDir).forEach(file => {
      const src = path.join(srcDir, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(dstDir, file));
      }
    });
  }
});

// Static files (after explicit routes)
// Serve /dist (React build) and /public (legacy files)
app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

// --- Utility functions ---

// Normalize LinkedIn URL to avoid duplicates
function normalizeLinkedinUrl(url) {
  if (!url) return null;
  // Remove trailing slashes
  url = url.replace(/\/+$/, '');
  // Remove query params
  url = url.split('?')[0];
  // Force format https://www.linkedin.com/in/xxx
  const match = url.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/);
  if (match) {
    return `https://www.linkedin.com/in/${match[1].toLowerCase()}`;
  }
  return url.toLowerCase();
}

// Generate a Supabase JWT token with custom account_id claim (for RLS)
// This allows RLS policies to read the account_id from the JWT
function generateSupabaseJWT(accountId) {
  const secret = process.env.SUPABASE_JWT_SECRET;

  if (!secret) {
    console.warn('SUPABASE_JWT_SECRET not set - RLS policies may not work');
    return null;
  }

  const payload = {
    sub: accountId,
    aud: 'authenticated',
    role: 'authenticated',
    account_id: accountId, // Custom claim for RLS
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24h expiry
  };

  try {
    return jwt.sign(payload, secret);
  } catch (err) {
    console.error('Error generating JWT:', err.message);
    return null;
  }
}

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
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({}); }
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
let openDealsCache = null;
let openDealsCacheTime = 0;
const OPEN_DEALS_CACHE_TTL = 5 * 60 * 1000;

async function fetchOpenDeals() {
  if (openDealsCache && (Date.now() - openDealsCacheTime) < OPEN_DEALS_CACHE_TTL) {
    return openDealsCache;
  }
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
      properties: ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'hs_date_entered_qualifiedtobuy', 'hs_date_entered_presentationscheduled', 'hs_date_entered_decisionmakerboughtin', 'hs_date_entered_contractsent'],
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

    const stageEnteredKey = `hs_date_entered_${stageInfo.id}`;
    pipelineDeals[stageInfo.label].push({
      id: deal.id,
      name: deal.properties.dealname || 'Sans nom',
      amount: parseFloat(deal.properties.amount) || 0,
      probability: stageInfo.probability,
      createdate: deal.properties.createdate || null,
      closedate: deal.properties.closedate || null,
      stageEnteredAt: deal.properties[stageEnteredKey] || null,
    });
  }

  openDealsCache = pipelineDeals;
  openDealsCacheTime = Date.now();
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
// --- Deal mutations ---
const STAGE_ID_MAP = {
  'RDV Qualif':     'qualifiedtobuy',
  'RDV Propale':    'presentationscheduled',
  'Négociation':    'decisionmakerboughtin',
  'Contrat envoyé': 'contractsent',
  'closedwon':      'closedwon',
  'closedlost':     'closedlost',
};

app.post('/api/deals', async (req, res) => {
  const { name, amount, stage, closedate } = req.body;
  if (!name || !stage) return res.status(400).json({ error: 'Nom et stage requis' });
  const stageId = STAGE_ID_MAP[stage];
  if (!stageId) return res.status(400).json({ error: 'Stage invalide' });
  const properties = {
    dealname: name,
    dealstage: stageId,
    pipeline: 'default',
  };
  if (amount) properties.amount = String(parseFloat(amount));
  if (closedate) properties.closedate = closedate;
  try {
    const result = await hubspotWrite('POST', '/crm/v3/objects/deals', { properties });
    res.json({ ok: true, id: result.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/deals/:id', async (req, res) => {
  const { id } = req.params;
  const { amount, stage, closedate, description } = req.body;
  const properties = {};
  if (amount !== undefined) properties.amount = String(parseFloat(amount));
  if (closedate !== undefined) properties.closedate = closedate;
  if (description !== undefined) properties.description = description;
  if (stage !== undefined) {
    if (stage === 'closedwon' || stage === 'closedlost') {
      properties.dealstage = stage;
    } else {
      const stageId = STAGE_ID_MAP[stage];
      if (!stageId) return res.status(400).json({ error: 'Stage invalide' });
      properties.dealstage = stageId;
    }
  }
  if (!Object.keys(properties).length) return res.status(400).json({ error: 'Rien à modifier' });
  try {
    await hubspotWrite('PATCH', `/crm/v3/objects/deals/${id}`, { properties });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Deal metadata (tags + proposal date, stored locally in Supabase) ---

app.get('/api/deals/metadata', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('deal_metadata').select('*');
    if (error) return res.status(500).json({ error: error.message });
    const map = {};
    for (const row of data) map[row.deal_id] = row;
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/deals/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const props = ['dealname', 'amount', 'dealstage', 'closedate', 'createdate', 'description', 'hs_deal_stage_probability', 'pipeline'];
    const data = await hubspotRequest(`/crm/v3/objects/deals/${id}?properties=${props.join(',')}`);
    const stageId = data.properties.dealstage;
    const stageInfo = KANBAN_STAGES.find(s => s.id === stageId);
    res.json({
      id: data.id,
      name: data.properties.dealname || '',
      amount: parseFloat(data.properties.amount) || 0,
      stage: stageInfo ? stageInfo.label : (stageId || ''),
      stageId,
      closedate: data.properties.closedate || null,
      createdate: data.properties.createdate || null,
      description: data.properties.description || '',
      probability: stageInfo ? stageInfo.probability : (parseFloat(data.properties.hs_deal_stage_probability) || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/deals/:id/metadata', async (req, res) => {
  const { id } = req.params;
  const { tags, proposal_sent_at } = req.body;
  const update = { deal_id: id, updated_at: new Date().toISOString() };
  if (tags !== undefined) update.tags = tags;
  if (proposal_sent_at !== undefined) update.proposal_sent_at = proposal_sent_at;
  try {
    const { error } = await supabaseAdmin
      .from('deal_metadata')
      .upsert(update, { onConflict: 'deal_id' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

  // Trouver la ligne contenant les mois (format MM/YYYY)
  let monthRowIdx = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const found = rows[i].some(cell => /^\d{2}\/\d{4}$/.test(cell.trim()));
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

  // categories    : { "Frais de personnel": { "2025-01": 15000, ... } }  — totaux par catégorie mère (charges)
  // subCategories : { "Frais de personnel": { "Salaires nets": { "2025-01": 4810 } } }
  // encaissementsCA : { "2025-01": 63132, ... } — HT, Enc. Acompte + Enc. Solde (éclatement du CA budgété via Notion signé)
  // encaissementsCADetail : { "2025-01": { "Enc. Acompte": 34552, "Enc. Solde": 28580 } }
  const categories    = {};
  const subCategories = {};
  const encaissementsCA = {};
  const encaissementsCADetail = {};
  let currentParent   = null;

  for (let r = monthRowIdx + 2; r < rows.length; r++) {
    const row = rows[r];
    const rawName = (row[2] || row[0] || '').trim();

    // Capture les lignes "Enc. *" (CA encaissé budgété) AVANT le skip filter
    if (/^enc\./i.test(rawName)) {
      for (const { index, key } of budgetCols) {
        const raw = (row[index] || '').trim().replace(/[€\s ]/g, '').replace(',', '.');
        const val = parseFloat(raw) || 0;
        if (val !== 0) {
          encaissementsCA[key] = (encaissementsCA[key] || 0) + val;
          if (!encaissementsCADetail[key]) encaissementsCADetail[key] = {};
          encaissementsCADetail[key][rawName] = (encaissementsCADetail[key][rawName] || 0) + val;
        }
      }
      continue; // ne pas descendre dans la logique charges
    }

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

  crPrevCache = { budgetCols, categories, subCategories, encaissementsCA, encaissementsCADetail };
  crPrevCacheTime = Date.now();
  return crPrevCache;
}

let notionMissionsCache = null;
let notionMissionsCacheTime = 0;
// TTL réduit à 60s (Patch 2+ safety) : évite que le cache capture une valeur stale Notion juste après
// un PATCH (eventual consistency Notion → GET /databases/query peut renvoyer l'ancienne valeur). Le
// cache sert toujours à éviter un rafale de requêtes mais se rafraîchit vite.
const NOTION_MISSIONS_CACHE_TTL = 60 * 1000; // 60 secondes

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
      partnerCommercial: props['Partner_commercial'] && props['Partner_commercial'].people
        ? props['Partner_commercial'].people.map(p => p.name.split(' ')[0]) : [],
      partnerOperationnel: props['Partner_Opérationnel'] && props['Partner_Opérationnel'].people
        ? props['Partner_Opérationnel'].people.map(p => p.name.split(' ')[0]) : [],
      acquisition: props['Acquisition'] && props['Acquisition'].select
        ? props['Acquisition'].select.name : 'Non défini',
      typeCa: props['type_ca'] && props['type_ca'].select
        ? props['type_ca'].select.name : 'Non défini',
      subventionne: props['CA Subventionné ?'] && props['CA Subventionné ?'].formula
        ? props['CA Subventionné ?'].formula.string || 'Non' : 'Non',
      contact: props['Contact'] && props['Contact'].rich_text
        ? props['Contact'].rich_text.map(t => t.plain_text).join('') : '',
      secteur: props["Secteur d'activité"] && props["Secteur d'activité"].multi_select
        ? props["Secteur d'activité"].multi_select.map(s => s.name) : [],
      // Acompte forcé : Number saisi par user pour override du split 50/50 par défaut.
      // - null/0 → pas d'override, montantAcompte = CA/2 via la formule Notion
      // - valeur < 5€ → signale "paiement en 1 fois" (pas d'acompte réel, solde = ~CA)
      // - valeur > 0 et < CA → split custom (ex: 40/60)
      acompteForce: props['Acompte forcé'] && props['Acompte forcé'].number != null
        ? props['Acompte forcé'].number : null,
      // Liens Pennylane (Patch 2 : matching) — lecture Text. Écriture via PATCH Notion plus tard.
      factAcptPenny: props['Fact acpt Penny'] && props['Fact acpt Penny'].rich_text
        ? props['Fact acpt Penny'].rich_text.map(t => t.plain_text).join('') : '',
      factSoldePenny: props['Fact solde Penny'] && props['Fact solde Penny'].rich_text
        ? props['Fact solde Penny'].rich_text.map(t => t.plain_text).join('') : '',
    };
  });

  notionMissionsCache = result;
  notionMissionsCacheTime = Date.now();
  // Patch 2++++ : invalide aussi le summary cache. Sans ça, le summary peut être stale par rapport
  // aux missions fraîchement refetchées (ex: user édite Notion directement → missions se refresh
  // au prochain TTL expiry mais summary garde l'ancienne valeur 60s de plus).
  // Bénéfice : le summary est toujours dérivé de la dernière version des missions.
  if (typeof invalidateFactMatchingSummaryCache === 'function') {
    invalidateFactMatchingSummaryCache();
  }
  return notionMissionsCache;
}

// --- Write-back Notion (Patch 2) : helper pour PATCH une propriété d'une page Notion ---
// Implémentation avec refetch-before-write (détection de drift) + read-after-write (confirmation PATCH pris).
// Mitigations identifiées dans l'audit Q1 :
// - #1 Concurrence Notion UI ↔ Pilot : refetch avant write, compare current value à expectedCurrent.
//      Si divergent, renvoie 409 "drift" avec la valeur actuelle pour que l'UI recharge.
// - #2 Échec PATCH silencieux : read-after-write, compare la valeur retournée à celle demandée.
// - #5 Audit trail : on stocke aussi en Supabase facture_overrides comme journal (reuse table existante).

// Récupère une page Notion par son id (sans passer par fetchAllNotionMissions qui fait tout charger).
async function fetchNotionMissionById(pageId) {
  return notionRequest(`/v1/pages/${pageId}`, 'GET');
}

// Lit la valeur texte actuelle d'une propriété rich_text d'une page.
function extractRichTextValue(page, propName) {
  const prop = page.properties && page.properties[propName];
  if (!prop || !prop.rich_text) return '';
  return prop.rich_text.map(t => t.plain_text).join('');
}

// Écrit une valeur texte dans une propriété rich_text d'une page Notion.
// - pageId : id de la page (UUID)
// - propName : nom exact de la propriété (sensible à la casse et aux accents)
// - newValue : nouvelle valeur texte (string, peut être vide pour effacer)
// - expectedCurrent : valeur attendue avant write (optional, pour détecter drift). Si fournie et divergente → throw.
// Renvoie { updated: boolean, previousValue, newValue, pageId } ou throw Error.
async function updateNotionMissionRichTextProperty(pageId, propName, newValue, expectedCurrent) {
  // Refetch-before-write : compare valeur actuelle à expectedCurrent pour détecter drift
  const currentPage = await fetchNotionMissionById(pageId);
  const currentValue = extractRichTextValue(currentPage, propName);
  if (expectedCurrent !== undefined && currentValue !== expectedCurrent) {
    const err = new Error(`Notion drift: la valeur actuelle "${currentValue}" diffère de la valeur attendue "${expectedCurrent}". Recharge la page pour voir la dernière version.`);
    err.code = 'NOTION_DRIFT';
    err.currentValue = currentValue;
    throw err;
  }
  if (currentValue === newValue) {
    // No-op : la valeur est déjà celle demandée, pas besoin de PATCH
    return { updated: false, previousValue: currentValue, newValue, pageId, reason: 'no_change' };
  }
  // PATCH
  const body = {
    properties: {
      [propName]: {
        rich_text: newValue ? [{ text: { content: newValue } }] : [],
      },
    },
  };
  const patched = await notionRequest(`/v1/pages/${pageId}`, 'PATCH', body);
  // Read-after-write : vérifie que la valeur retournée correspond bien
  const writtenValue = extractRichTextValue(patched, propName);
  if (writtenValue !== newValue) {
    throw new Error(`Notion PATCH a échoué silencieusement : valeur écrite "${writtenValue}" ≠ "${newValue}". Vérifier le schéma de la propriété "${propName}".`);
  }
  // Invalider le cache missions (la prochaine lecture re-fetch) + cache summary
  notionMissionsCache = null; notionMissionsCacheTime = 0;
  invalidateFactMatchingSummaryCache();
  console.log(`[Notion PATCH OK] page=${pageId} prop="${propName}" "${currentValue}" → "${newValue}"`);
  return { updated: true, previousValue: currentValue, newValue, pageId };
}

// Write Notion STATUS property (Patch 3, write-back Facturation).
// Différent du rich_text : le payload API Notion utilise { status: { name: '...' } }.
// L'option "name" doit exister EXACTEMENT dans le schéma de la propriété, sinon Notion renvoie 400.
async function updateNotionMissionStatusProperty(pageId, propName, statusName, expectedCurrent) {
  const currentPage = await fetchNotionMissionById(pageId);
  const prop = currentPage.properties && currentPage.properties[propName];
  const currentValue = (prop && prop.status && prop.status.name) || '';
  if (expectedCurrent !== undefined && currentValue !== expectedCurrent) {
    const err = new Error(`Notion drift: la valeur actuelle "${currentValue}" diffère de la valeur attendue "${expectedCurrent}". Recharge la page.`);
    err.code = 'NOTION_DRIFT';
    err.currentValue = currentValue;
    throw err;
  }
  if (currentValue === statusName) {
    return { updated: false, previousValue: currentValue, newValue: statusName, pageId, reason: 'no_change' };
  }
  const body = { properties: { [propName]: { status: { name: statusName } } } };
  const patched = await notionRequest(`/v1/pages/${pageId}`, 'PATCH', body);
  const writtenProp = patched.properties && patched.properties[propName];
  const writtenValue = (writtenProp && writtenProp.status && writtenProp.status.name) || '';
  if (writtenValue !== statusName) {
    throw new Error(`Notion PATCH a échoué silencieusement : valeur écrite "${writtenValue}" ≠ "${statusName}". Vérifier que l'option existe dans le schéma "${propName}".`);
  }
  notionMissionsCache = null; notionMissionsCacheTime = 0;
  invalidateFactMatchingSummaryCache();
  return { updated: true, previousValue: currentValue, newValue: statusName, pageId };
}

// Progression officielle des statuts Notion "Facturation" (6 options, cf screenshot user G1).
// L'ordre est utilisé pour détecter : reculs (curIdx > tgtIdx) et sauts (|tgtIdx - curIdx| > 1).
const NOTION_FACTURATION_ORDER = [
  'Acompte à envoyer',
  'Acompte envoyé',
  'Acompte payé',
  'Solde à envoyer',
  'Solde envoyé',
  'Solde payé',
];

// Mapping Pilot → Notion selon (rowType, newStatus, oneShot, currentNotionStatus).
// Retourne { target } si valide, { error } si transition refusée.
// Règles (cf. matrices audit G) :
// - Acompte : "En attente" invalide
// - Solde : "En attente" invalide (modifier Acompte plutôt)
// - Solde → Envoyé/Payé : l'acompte doit être payé dans Notion (pas de saut avant "Acompte payé")
// - One-shot : seule la ligne Solde modifiable, mapping direct Solde→Solde
function mapPilotToNotionStatus(rowType, newStatus, oneShot, currentNotionStatus) {
  if (oneShot) {
    if (rowType !== 'solde') {
      return { error: 'Mission en paiement 1 fois : seule la ligne Solde est modifiable.' };
    }
    switch (newStatus) {
      case 'A envoyer': return { target: 'Solde à envoyer' };
      case 'Envoye':    return { target: 'Solde envoyé' };
      case 'Paye':      return { target: 'Solde payé' };
      case 'En attente': return { error: '"En attente" non applicable pour une mission en paiement 1 fois.' };
      default: return { error: 'Statut inconnu : ' + newStatus };
    }
  }
  if (rowType === 'acompte') {
    switch (newStatus) {
      case 'A envoyer': return { target: 'Acompte à envoyer' };
      case 'Envoye':    return { target: 'Acompte envoyé' };
      case 'Paye':      return { target: 'Acompte payé' };
      case 'En attente': return { error: '"En attente" non applicable à l\'acompte.' };
      default: return { error: 'Statut inconnu : ' + newStatus };
    }
  }
  if (rowType === 'solde') {
    switch (newStatus) {
      case 'A envoyer': return { target: 'Solde à envoyer' };
      case 'Envoye': {
        const curIdx = NOTION_FACTURATION_ORDER.indexOf(currentNotionStatus);
        const paidIdx = NOTION_FACTURATION_ORDER.indexOf('Acompte payé');
        if (curIdx >= 0 && curIdx < paidIdx) {
          return { error: 'Le solde ne peut pas être envoyé tant que l\'acompte n\'est pas payé. Statut actuel : "' + currentNotionStatus + '".' };
        }
        return { target: 'Solde envoyé' };
      }
      case 'Paye': {
        const curIdx = NOTION_FACTURATION_ORDER.indexOf(currentNotionStatus);
        const paidIdx = NOTION_FACTURATION_ORDER.indexOf('Acompte payé');
        if (curIdx >= 0 && curIdx < paidIdx) {
          return { error: 'Le solde ne peut pas être payé tant que l\'acompte n\'est pas payé. Statut actuel : "' + currentNotionStatus + '".' };
        }
        return { target: 'Solde payé' };
      }
      case 'En attente':
        return { error: 'Pour remettre en attente, modifier plutôt le statut de la ligne Acompte.' };
      default: return { error: 'Statut inconnu : ' + newStatus };
    }
  }
  return { error: 'rowType inconnu : ' + rowType };
}

// POST /api/facturation-matching/set-status
// Body : { missionNom, rowType: 'acompte'|'solde', newStatus, oneShot, expectedCurrent }
// Applique le mapping + PATCH Notion avec refetch-before-write. Retourne erreurs structurées.
app.post('/api/facturation-matching/set-status', async (req, res) => {
  try {
    const { missionNom, rowType, newStatus, oneShot, expectedCurrent } = req.body || {};
    if (!missionNom || !rowType || !newStatus) {
      return res.status(400).json({ error: 'missionNom, rowType, newStatus requis' });
    }
    if (rowType !== 'acompte' && rowType !== 'solde') {
      return res.status(400).json({ error: 'rowType doit être "acompte" ou "solde"' });
    }
    const missions = await fetchAllNotionMissions();
    const mission = missions.find(m => m.nom === missionNom);
    if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

    const currentNotionStatus = mission.facturation || '';
    const mapping = mapPilotToNotionStatus(rowType, newStatus, !!oneShot, currentNotionStatus);
    if (mapping.error) {
      return res.status(400).json({ error: mapping.error, code: 'INVALID_TRANSITION', currentNotionStatus });
    }

    try {
      const result = await updateNotionMissionStatusProperty(mission.id, 'Facturation', mapping.target, expectedCurrent);
      res.json({ ok: true, ...result, missionNom, rowType, newStatus, targetNotionStatus: mapping.target, currentNotionStatus });
    } catch (err) {
      if (err.code === 'NOTION_DRIFT') {
        return res.status(409).json({ error: err.message, code: 'NOTION_DRIFT', currentValue: err.currentValue });
      }
      throw err;
    }
  } catch (err) {
    console.error('Erreur set-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Invalidation cache Notion + Pennylane (Patch 2) : déclenché par le bouton "Sync" de Pilot
// pour forcer un re-fetch immédiat quand un user a modifié Notion ou Pennylane directement.
// Sans ça, le cache de 5 min (Notion) / 10 min (Pennylane) retarde la propagation côté Pilot.
app.post('/api/notion-missions/invalidate-cache', (req, res) => {
  notionMissionsCache = null;
  notionMissionsCacheTime = 0;
  customerInvoicesCache = null;
  customerInvoicesCacheTime = 0;
  invalidateFactMatchingSummaryCache();
  res.json({ ok: true, invalidated: ['notionMissions', 'customerInvoices', 'factMatchingSummary'] });
});

// --- Repeat clients (grouping of finished Notion missions by client) ---
app.get('/api/repeat-clients', async (req, res) => {
  try {
    const missions = await fetchAllNotionMissions();
    const ACTIVE_STATES = ['En cours', 'Planning', 'En pause', 'En attente'];
    // Exclude only cancelled missions
    const relevant = missions.filter(m => m.etat !== 'Annulé');

    const byClient = {};
    for (const m of relevant) {
      const key = (m.client || '').trim();
      if (!key) continue;
      if (!byClient[key]) {
        byClient[key] = {
          client: key,
          contact: m.contact || '',
          secteur: m.secteur || [],
          partners: [],
          missions: [],
          totalCa: 0,
          lastMissionEndDate: null,
          hasActiveMission: false,
        };
      }
      const endDate = m.dates && m.dates.end ? m.dates.end
        : (m.etat === 'Terminé' && m.anneeFinal ? `${m.anneeFinal}-12-31` : null);

      byClient[key].missions.push({
        nom: m.nom,
        ca: m.ca,
        nature: m.natureMission,
        endDate,
        etat: m.etat,
        partnerCommercial: m.partnerCommercial || [],
        partnerOperationnel: m.partnerOperationnel || [],
      });
      byClient[key].totalCa += m.ca;

      if (ACTIVE_STATES.includes(m.etat)) byClient[key].hasActiveMission = true;

      if (endDate && (!byClient[key].lastMissionEndDate || endDate > byClient[key].lastMissionEndDate)) {
        byClient[key].lastMissionEndDate = endDate;
      }
      if (m.contact && !byClient[key].contact) byClient[key].contact = m.contact;
      for (const s of (m.secteur || [])) {
        if (!byClient[key].secteur.includes(s)) byClient[key].secteur.push(s);
      }
      for (const p of [...(m.partnerCommercial || []), ...(m.partnerOperationnel || [])]) {
        if (p && !byClient[key].partners.includes(p)) byClient[key].partners.push(p);
      }
    }

    const clients = Object.values(byClient).sort((a, b) => {
      if (!a.lastMissionEndDate) return 1;
      if (!b.lastMissionEndDate) return -1;
      return a.lastMissionEndDate.localeCompare(b.lastMissionEndDate);
    });

    res.json(clients);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Repeat state persistence (dismissed / contacts / deals / notes) — shared across all users ---
const REPEAT_ALLOWED_FIELDS = ['dismissed', 'contacts', 'deals', 'notes'];
const REPEAT_STATE_KEY = 'shared';

app.get('/api/repeat-state', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('repeat_state')
      .select('dismissed, contacts, deals, notes')
      .eq('user_key', REPEAT_STATE_KEY)
      .single();
    if (error) throw error;
    res.json(data || { dismissed: {}, contacts: {}, deals: {}, notes: {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/repeat-state', async (req, res) => {
  const { field, value } = req.body;
  if (!REPEAT_ALLOWED_FIELDS.includes(field)) return res.status(400).json({ error: 'field invalide' });
  try {
    const { error } = await supabaseAdmin
      .from('repeat_state')
      .upsert({ user_key: REPEAT_STATE_KEY, [field]: value, updated_at: new Date().toISOString() }, { onConflict: 'user_key' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
      id: m.id, // nécessaire pour PATCH Notion (Patch 2 matching)
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
      acompteForce: m.acompteForce,
      factAcptPenny: m.factAcptPenny,
      factSoldePenny: m.factSoldePenny,
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

// Helpers de matching réutilisables (utilisés par /api/facturation-matching/suggest et /link).
// Hypothèses : montants Notion HT, conversion TTC = ×1.2.
function normalizeCompanyName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(sasu|sarl|sas|eurl|sci|sa|snc)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}
function similarityScore(a, b) {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 3 && (nb.includes(na))) return 0.88;
  if (nb.length >= 3 && (na.includes(nb))) return 0.88;
  // Jaccard trigrammes
  const tri = (s) => { const set = new Set(); for (let i = 0; i <= s.length - 3; i++) set.add(s.substring(i, i + 3)); return set; };
  const ta = tri(na), tb = tri(nb);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
function daysBetween(d1, d2) {
  if (!d1 || !d2) return Infinity;
  const dt = Math.abs(new Date(d1).getTime() - new Date(d2).getTime());
  if (isNaN(dt)) return Infinity;
  return Math.round(dt / (24 * 3600 * 1000));
}
// --- Debug Pennylane raw : dump de tous les endpoints Pennylane accessibles ---
// Objectif : explorer quelles données sont exposées pour déterminer une stratégie de matching
// plus robuste (ex. présence d'un numéro de commande, référence externe, lineitems, etc.).
// Mise en forme : chaque entité rendue séparément, champs bruts (flatten à 1 niveau).
function flattenRow(obj, prefix = '', out = {}) {
  if (obj == null) return out;
  if (typeof obj !== 'object') { out[prefix || 'value'] = obj; return out; }
  if (Array.isArray(obj)) {
    if (obj.length === 0) { out[prefix] = ''; return out; }
    // Arrays d'objets : on JSON.stringify (trop imbriqués pour aplatir proprement en CSV)
    out[prefix] = JSON.stringify(obj).slice(0, 2000);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenRow(v, key, out);
    } else if (Array.isArray(v)) {
      out[key] = v.length === 0 ? '' : JSON.stringify(v).slice(0, 2000);
    } else {
      out[key] = v == null ? '' : v;
    }
  }
  return out;
}

// --- Matching Pennylane ↔ Notion (Patch 2) : suggestions + linking ---
// Leçons du PoC : le scoring doit exclure strictement les factures cancelled/archived/negative
// et supporter le cas "split acompte/solde différent" (total mission TTC matché même si individuels divergent).

// --- Optimisations matching (Patch 2++) : pré-calcul des valeurs coûteuses ---
// Le scoring naïf recompute pour chaque (mission, invoice) la normalisation NFD/regex et les trigrammes.
// Avec 104 missions × 248 invoices × 2 types = 51k itérations × 6 normalisations = 300k+ opérations.
// On cache les valeurs normalisées + trigrammes EN PLACE sur les objets via préfixe `_pre*`.
function trigramsOf(s) {
  const set = new Set();
  if (!s) return set;
  for (let i = 0; i <= s.length - 3; i++) set.add(s.substring(i, i + 3));
  return set;
}
function normalizeTextFr(s) {
  return s ? String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') : '';
}
function ensureMissionPrecomputed(m) {
  if (m._preClient !== undefined) return;
  m._preClient = normalizeCompanyName(m.client);
  m._trigClient = trigramsOf(m._preClient);
  m._preNom = normalizeTextFr(m.nom);
}
function ensureInvoicePrecomputed(inv) {
  if (inv._preCustomer !== undefined) return;
  inv._preCustomer = normalizeCompanyName(inv.customerName);
  inv._preLabel    = normalizeCompanyName(inv.label);
  inv._preFilename = normalizeCompanyName(inv.filename);
  inv._trigCustomer = trigramsOf(inv._preCustomer);
  inv._trigLabel    = trigramsOf(inv._preLabel);
  inv._trigFilename = trigramsOf(inv._preFilename);
  // Type detection en avance pour éviter recompute regex
  const subjectType = detectInvoiceTypeInText(inv.pdfInvoiceSubject);
  const descType    = detectInvoiceTypeInText(inv.pdfDescription);
  inv._resolvedType = subjectType === 'ambiguous' ? null : (subjectType || (descType === 'ambiguous' ? null : descType));
  inv._subjectNorm = normalizeTextFr(inv.pdfInvoiceSubject);
  inv._descNorm    = normalizeTextFr(inv.pdfDescription);
}
function similarityFromPrecomputed(naStr, naTrig, nbStr, nbTrig) {
  if (!naStr || !nbStr) return 0;
  if (naStr === nbStr) return 1;
  if (naStr.length >= 3 && nbStr.includes(naStr)) return 0.88;
  if (nbStr.length >= 3 && naStr.includes(nbStr)) return 0.88;
  if (naTrig.size === 0 || nbTrig.size === 0) return 0;
  let inter = 0;
  for (const t of naTrig) if (nbTrig.has(t)) inter++;
  return inter / (naTrig.size + nbTrig.size - inter);
}

// Helper : check si un texte Pennylane contient un mot-clé type, avec normalisation accents/casse.
// Retourne 'acompte' | 'solde' | null selon ce qui apparaît dans le texte.
function detectInvoiceTypeInText(text) {
  if (!text) return null;
  const norm = String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // "acompte" d'abord car il peut coexister avec "solde" (ex: "acompte pour solde à venir" rare)
  const hasAcompte = /\bacompte\b/.test(norm);
  const hasSolde = /\bsolde\b/.test(norm);
  if (hasAcompte && !hasSolde) return 'acompte';
  if (hasSolde && !hasAcompte) return 'solde';
  if (hasAcompte && hasSolde) return 'ambiguous';
  return null;
}

// Score 0-100 + raisons pour un candidat Pennylane donné vs une mission Notion + un type (acompte|solde).
// Refonte v3 (focus client) : le nom client est le SIGNAL PIVOT. Pas de proposition si client sim < 0.5.
// Notion = HT, Pennylane.amount = TTC (vérifié par dump). Conversion HT × 1.2 = TTC.
// Le montant individuel est un SIGNAL FAIBLE car le split Notion (50/50 par défaut si Acompte forcé non
// rempli) diverge souvent de la réalité Pennylane (30/70, 40/60...). Tolérance élargie à ±25%, poids
// réduit. La discrimination acompte/solde repose principalement sur pdf_invoice_subject/description.
//
// Pondération (sur ~110, capé 100) :
//   Client best-of-3 (filename / customerName / label) : 0/10/25/45 selon similarité (HARD FILTER ≥ 0.5)
//   Type acompte/solde dans subject : +30 match | -50 mismatch (signal fort)
//   Nom mission dans subject/description : +15
//   Montant TTC ±1% / ±5% / ±25% : 15/10/5
//   Date émission ≤5j / ≤30j / ≤90j : 5/3/1
function scoreInvoiceForMission(inv, mission, type) {
  if (!inv || inv.amount == null || inv.amount <= 0) return { score: 0, reasons: 'montant invalide' };
  if (inv.status === 'cancelled' || inv.status === 'archived') return { score: 0, reasons: 'facture ' + inv.status };

  // Pré-calcul lazy (cache sur l'objet) — la 1ère fois c'est lent, les suivantes c'est instant
  ensureMissionPrecomputed(mission);
  ensureInvoicePrecomputed(inv);

  // --- HARD FILTER client (évite faux positifs montant/date sans rapport client) ---
  const simCustomer = similarityFromPrecomputed(inv._preCustomer, inv._trigCustomer, mission._preClient, mission._trigClient);
  const simLabel    = similarityFromPrecomputed(inv._preLabel,    inv._trigLabel,    mission._preClient, mission._trigClient);
  const simFilename = similarityFromPrecomputed(inv._preFilename, inv._trigFilename, mission._preClient, mission._trigClient);
  const simBest = Math.max(simCustomer, simLabel, simFilename);
  if (simBest < 0.5) {
    return { score: 0, reasons: `client mismatch (best ${Math.round(simBest * 100)}%)` };
  }

  const reasons = [];
  let score = 0;
  const targetHT = type === 'acompte' ? (mission.montantAcompte || 0)
                                       : ((mission.ca || 0) - (mission.montantAcompte || 0));
  const targetTTC = targetHT * 1.2;
  const targetDate = type === 'acompte' ? mission.dateFactureAcompte : mission.dateFactureFinale;

  // 1) Client (signal pivot)
  if (simBest >= 0.95)     { score += 45; reasons.push(`client=${Math.round(simBest * 100)}%`); }
  else if (simBest >= 0.8) { score += 35; reasons.push(`client≈${Math.round(simBest * 100)}%`); }
  else if (simBest >= 0.6) { score += 25; reasons.push(`client~${Math.round(simBest * 100)}%`); }
  else                     { score += 10; reasons.push(`client min ${Math.round(simBest * 100)}%`); }

  // 2) Type (acompte/solde) — utilise valeur pré-calculée
  if (inv._resolvedType === type) {
    score += 30;
    reasons.push(`type=${type}`);
  } else if (inv._resolvedType && inv._resolvedType !== type) {
    score -= 50;
    reasons.push(`⚠ type mismatch (${inv._resolvedType}≠${type})`);
  }

  // 3) Nom mission dans subject/description (utilise valeurs pré-normalisées)
  if (mission._preNom && mission._preNom.length >= 3) {
    if (inv._subjectNorm.includes(mission._preNom) || inv._descNorm.includes(mission._preNom)) {
      score += 15;
      reasons.push('mission∈sujet/desc');
    }
  }

  // 4) Montant TTC — signal faible (split Notion souvent divergent), tolérance large ±25%
  if (targetTTC > 0) {
    const diff = Math.abs(inv.amount - targetTTC);
    if (diff < 1)                       { score += 15; reasons.push('montant=TTC'); }
    else if (diff <= targetTTC * 0.05)  { score += 10; reasons.push('montant±5%'); }
    else if (diff <= targetTTC * 0.25)  { score += 5;  reasons.push('montant±25%'); }
  }

  // 5) Date émission
  const dd = daysBetween(targetDate, inv.date);
  if (dd <= 5)       { score += 5; reasons.push('date≤5j'); }
  else if (dd <= 30) { score += 3; reasons.push('date≤30j'); }
  else if (dd <= 90) { score += 1; reasons.push('date≤90j'); }

  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return { score, reasons: reasons.join(' | ') };
}

// Retourne top N candidats Pennylane scorés pour une mission/type donné (seuil score > 0).
function suggestPennylaneMatches(mission, type, customerInvoices, topN = 5) {
  const candidates = [];
  for (const inv of customerInvoices) {
    const s = scoreInvoiceForMission(inv, mission, type);
    if (s.score > 0) candidates.push({ inv, ...s });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topN);
}

// Patch 2+++ : trigram inverted index sur les invoices pour speedup massif du bulk matching.
// Au lieu d'itérer 248 invoices × 104 missions × 2 types = 51k iterations, on construit UNE FOIS un
// index trigramme→Set<invoice>. Pour chaque mission, on lookup ses ~15 trigrammes pour récupérer
// directement les ~30-50 invoices candidates partageant au moins un trigramme client → score uniquement
// celles-là. Speedup empirique : ~10x sur le bulk.
function buildInvoiceTrigramIndex(invoices) {
  const idx = new Map(); // trigram → Set<invoice>
  for (const inv of invoices) {
    if (!inv || inv.amount == null || inv.amount <= 0) continue;
    if (inv.status === 'cancelled' || inv.status === 'archived') continue;
    ensureInvoicePrecomputed(inv);
    // Union des trigrammes des 3 sources de nom client
    const allTrigrams = new Set();
    for (const t of inv._trigCustomer) allTrigrams.add(t);
    for (const t of inv._trigLabel)    allTrigrams.add(t);
    for (const t of inv._trigFilename) allTrigrams.add(t);
    for (const t of allTrigrams) {
      let bucket = idx.get(t);
      if (!bucket) { bucket = new Set(); idx.set(t, bucket); }
      bucket.add(inv);
    }
  }
  return idx;
}

// Find candidate invoices via trigram index. Bien plus rapide que d'itérer toute la liste.
// Retourne un Array (pas un Set) pour pouvoir itérer + sort ensuite.
function findCandidateInvoices(mission, invoiceTrigramIndex) {
  ensureMissionPrecomputed(mission);
  const candidates = new Set();
  for (const t of mission._trigClient) {
    const bucket = invoiceTrigramIndex.get(t);
    if (bucket) for (const inv of bucket) candidates.add(inv);
  }
  return [...candidates];
}

// Combined acompte+solde scoring : itère les invoices une seule fois pour produire les 2 tops.
// Évite le double parcours et garantit les pré-calculs sont chauds dès la 1ère itération.
function suggestPennylaneMatchesBoth(mission, customerInvoices, topN = 5, invoiceTrigramIndex = null) {
  const candidatesAcompte = [];
  const candidatesSolde = [];
  // Si index fourni, ne score que les candidats qui ont au moins 1 trigramme commun (filtre client)
  const pool = invoiceTrigramIndex ? findCandidateInvoices(mission, invoiceTrigramIndex) : customerInvoices;
  for (const inv of pool) {
    const sA = scoreInvoiceForMission(inv, mission, 'acompte');
    if (sA.score > 0) candidatesAcompte.push({ inv, ...sA });
    const sS = scoreInvoiceForMission(inv, mission, 'solde');
    if (sS.score > 0) candidatesSolde.push({ inv, ...sS });
  }
  candidatesAcompte.sort((a, b) => b.score - a.score);
  candidatesSolde.sort((a, b) => b.score - a.score);
  return { acompte: candidatesAcompte.slice(0, topN), solde: candidatesSolde.slice(0, topN) };
}

// Phase 1 (Pilot↔Penny) : helper standalone pour calculer warnings cohérence + orphelins Pennylane.
// Utilisé par /api/facturation-matching/suggest summary (frontend Facturation) — léger, sans TRE projection.
// Doit rester aligné avec la logique inline dans buildPrevisionnel (source of truth pour le TRE).
function computeMatchingCoherence(missions, customerInvoices) {
  const linkedInvoiceNumbersLower = new Set();
  const invoiceByNumberLower = new Map();
  for (const inv of (customerInvoices || [])) {
    if (inv.invoiceNumber) invoiceByNumberLower.set(inv.invoiceNumber.toLowerCase(), inv);
  }
  const notionWarnings = [];
  const now = new Date();

  function processSide(m, type, links, status) {
    let allPaid = links.length > 0;
    let allCancelledOrMissing = links.length > 0;
    let pushedAny = false;
    for (const num of links) {
      linkedInvoiceNumbersLower.add(num.toLowerCase());
      const inv = invoiceByNumberLower.get(num.toLowerCase());
      if (!inv) {
        notionWarnings.push({ missionNom: m.nom, type, code: 'linked-not-found',
          message: 'Lien vers "' + num + '" mais introuvable dans Pennylane' });
        allPaid = false;
        continue;
      }
      if (inv.paid) { allCancelledOrMissing = false; continue; }
      allPaid = false;
      if (inv.status === 'cancelled' || inv.status === 'incomplete') continue;
      allCancelledOrMissing = false;
      if (inv.status !== 'upcoming' && inv.status !== 'late') continue;
      if (!inv.remainingAmount || inv.remainingAmount <= 0) continue;
      pushedAny = true;
    }
    return { allPaid, allCancelledOrMissing, pushedAny };
  }

  for (const m of (missions || [])) {
    if (!m || (m.ca || 0) <= 0) continue;
    const status = (m.facturation || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (status.includes('solde paye')) continue;
    const oneShot = (m.montantAcompte || 0) < 5;

    if (!oneShot && (m.montantAcompte || 0) >= 5) {
      const acompteLinks = parseLinkedInvoiceList(m.factAcptPenny);
      if (acompteLinks.length === 0) {
        if (status.includes('acompte envoye')) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'unmatched-issued',
            message: 'Notion "Acompte envoye" sans matching Pennylane' });
        }
      } else {
        const st = processSide(m, 'acompte', acompteLinks, status);
        if (st.allPaid && (status.includes('acompte a envoyer') || status === 'non defini' || status === '')) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'notion-late-update',
            message: 'Notion "Acompte a envoyer" mais factures liees toutes payees' });
        }
        if (status.includes('acompte paye') && !st.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'notion-overdue',
            message: 'Notion "Acompte paye" mais facture liee non payee' });
        }
        if (st.allCancelledOrMissing && !st.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'linked-cancelled',
            message: 'Toutes les factures acompte liees sont annulees' });
        }
      }
    }

    const montantSoldeHT = (m.ca || 0) - (m.montantAcompte || 0);
    if (montantSoldeHT > 5) {
      const soldeLinks = parseLinkedInvoiceList(m.factSoldePenny);
      if (soldeLinks.length === 0) {
        if (status.includes('solde envoye')) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'unmatched-issued',
            message: 'Notion "Solde envoye" sans matching Pennylane' });
        }
      } else {
        const st = processSide(m, 'solde', soldeLinks, status);
        if (st.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'notion-late-update',
            message: 'Factures solde liees toutes payees mais Notion non a jour' });
        }
        if (status.includes('solde a envoyer') && st.pushedAny) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'notion-late-update',
            message: 'Notion "Solde a envoyer" mais Pennylane factures emises' });
        }
        if (st.allCancelledOrMissing && !st.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'linked-cancelled',
            message: 'Toutes les factures solde liees sont annulees' });
        }
      }
    }
  }

  // Orphelins
  const pennylaneOrphans = [];
  for (const inv of (customerInvoices || [])) {
    if (inv.paid) continue;
    if (inv.status === 'cancelled' || inv.status === 'incomplete') continue;
    if (!inv.remainingAmount || inv.remainingAmount <= 0) continue;
    if (inv.status !== 'upcoming' && inv.status !== 'late') continue;
    if (linkedInvoiceNumbersLower.has((inv.invoiceNumber || '').toLowerCase())) continue;
    const isLate = inv.status === 'late' || (inv.dueDate && new Date(inv.dueDate) < now);
    pennylaneOrphans.push({
      invoiceNumber: inv.invoiceNumber || '',
      customerName: inv.customerName || '',
      label: inv.label || '',
      amount: inv.remainingAmount,
      date: inv.date,
      dueDate: inv.dueDate,
      status: inv.status,
      isLate,
    });
  }
  return { notionWarnings, pennylaneOrphans };
}

// Patch 2++++ : helper de détection de doublons. Pour une liste de n° factures à écrire dans
// (excludeMissionNom, excludeType), cherche les autres (mission, type) qui contiennent déjà l'un
// d'eux. Retourne la liste des conflits avec contexte complet pour pouvoir les retirer ensuite.
function findDuplicateLinks(invoiceNumbers, missions, excludeMissionNom, excludeType) {
  const lowerSet = new Set(invoiceNumbers.map(s => String(s).toLowerCase()));
  const conflicts = [];
  for (const m of missions) {
    for (const fieldType of ['acompte', 'solde']) {
      if (m.nom === excludeMissionNom && fieldType === excludeType) continue;
      const raw = fieldType === 'acompte' ? m.factAcptPenny : m.factSoldePenny;
      if (!raw) continue;
      const list = parseLinkedInvoiceList(raw);
      for (const inv of list) {
        if (lowerSet.has(inv.toLowerCase())) {
          conflicts.push({
            invoice: inv,
            otherMission: m.nom,
            otherMissionId: m.id,
            otherType: fieldType,
            otherCurrentList: list,
          });
        }
      }
    }
  }
  return conflicts;
}

// Patch 2++ : helper pour parser une valeur de propriété Notion "Fact acpt/solde Penny" pouvant
// contenir plusieurs n° de facture séparés par ',' / ';' / newline. Retourne un tableau dédupliqué
// (insensible à la casse, conserve la première casse rencontrée).
function parseLinkedInvoiceList(raw) {
  if (!raw) return [];
  const seen = new Set();
  const result = [];
  for (const part of String(raw).split(/[,;\n]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

// Patch 2+++ : cache server-side du summary (mode "résumé pour toutes missions") pour servir
// instantanément les re-fetch dans la fenêtre TTL. Invalidé proactivement à chaque PATCH Notion
// (helpers updateNotionMissionRichTextProperty + updateNotionMissionStatusProperty) et au Sync.
let factMatchingSummaryCache = null;
let factMatchingSummaryCacheTime = 0;
const FACT_MATCHING_SUMMARY_TTL = 30 * 1000; // 30s — assez court pour limiter la latence des éditions Notion directes
function invalidateFactMatchingSummaryCache() {
  factMatchingSummaryCache = null;
  factMatchingSummaryCacheTime = 0;
}

// GET /api/facturation-matching/suggest?mission=<nom>&type=<acompte|solde>
// Retourne les top 5 candidats Pennylane pour une mission/type donnés.
// Si mission non fournie : retourne un résumé pour toutes les missions (top 1 par mission/type).
app.get('/api/facturation-matching/suggest', async (req, res) => {
  try {
    const { mission: missionNom, type } = req.query;
    // Cas par défaut : résumé global → check cache d'abord (instantané si TTL valide)
    if (!missionNom && !type) {
      if (factMatchingSummaryCache && (Date.now() - factMatchingSummaryCacheTime) < FACT_MATCHING_SUMMARY_TTL) {
        return res.json(factMatchingSummaryCache);
      }
    }
    const tStart = Date.now();
    const [missions, invoices] = await Promise.all([
      fetchAllNotionMissions(),
      fetchCustomerInvoices(),
    ]);
    if (missionNom && type) {
      // Cas ciblé : top 5 pour une mission/type
      const mission = missions.find(m => m.nom === missionNom);
      if (!mission) return res.status(404).json({ error: 'Mission introuvable' });
      if (type !== 'acompte' && type !== 'solde') return res.status(400).json({ error: 'type doit être acompte ou solde' });
      const suggestions = suggestPennylaneMatches(mission, type, invoices, 5);
      const currentRaw = type === 'acompte' ? mission.factAcptPenny : mission.factSoldePenny;
      return res.json({
        mission: { nom: mission.nom, client: mission.client, ca: mission.ca, pageId: mission.id },
        type,
        currentlyLinked: currentRaw,
        currentlyLinkedList: parseLinkedInvoiceList(currentRaw),
        suggestions: suggestions.map(c => ({
          invoiceNumber: c.inv.invoiceNumber,
          customerName: c.inv.customerName,
          amount: c.inv.amount,
          date: c.inv.date,
          status: c.inv.status,
          paid: c.inv.paid,
          score: c.score,
          reasons: c.reasons,
          pdfInvoiceSubject: c.inv.pdfInvoiceSubject || '',
          pdfDescription: c.inv.pdfDescription || '',
        })),
      });
    }
    // Cas par défaut : résumé par mission. Patch 2+++ : trigram index + scoring combiné.
    const trigIdx = buildInvoiceTrigramIndex(invoices);
    const summary = missions.map(m => {
      // ensureMissionPrecomputed appelé dans suggestPennylaneMatchesBoth via scoreInvoiceForMission.
      const wantAcompte = (m.montantAcompte || 0) >= 5;
      const wantSolde   = (m.montantFinal   || 0) >= 5;
      let acompteSuggest = null, soldeSuggest = null;
      if (wantAcompte || wantSolde) {
        const both = suggestPennylaneMatchesBoth(m, invoices, 1, trigIdx);
        if (wantAcompte) acompteSuggest = both.acompte[0] || null;
        if (wantSolde)   soldeSuggest   = both.solde[0]   || null;
      }
      return {
        missionNom: m.nom,
        pageId: m.id,
        client: m.client,
        acompteLinked: m.factAcptPenny || '',
        soldeLinked:   m.factSoldePenny || '',
        acompteSuggest: acompteSuggest ? { invoice: acompteSuggest.inv.invoiceNumber, amount: acompteSuggest.inv.amount, score: acompteSuggest.score, reasons: acompteSuggest.reasons } : null,
        soldeSuggest:   soldeSuggest   ? { invoice: soldeSuggest.inv.invoiceNumber,   amount: soldeSuggest.inv.amount,   score: soldeSuggest.score,   reasons: soldeSuggest.reasons   } : null,
      };
    });
    // Phase 1 : warnings cohérence + orphelins Pennylane (utilisés par bandeau + section Facturation)
    const coherence = computeMatchingCoherence(missions, invoices);
    const elapsed = Date.now() - tStart;
    const responsePayload = {
      summary,
      invoicesCount: invoices.length,
      missionsCount: missions.length,
      notionWarnings: coherence.notionWarnings,
      pennylaneOrphans: coherence.pennylaneOrphans,
      computedInMs: elapsed,
    };
    factMatchingSummaryCache = responsePayload;
    factMatchingSummaryCacheTime = Date.now();
    console.log(`[matching summary] ${missions.length} missions × ${invoices.length} invoices computed in ${elapsed}ms (warnings=${coherence.notionWarnings.length}, orphans=${coherence.pennylaneOrphans.length})`);
    res.json(responsePayload);
  } catch (err) {
    console.error('Erreur matching suggest:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/facturation-matching/link
// Body : { missionNom, type, invoiceNumbers?: string[], invoiceNumber?: string, expectedCurrent?, confirmDuplicates? }
// - invoiceNumbers : array de n° factures (Patch 2++). Joint par ", " avant PATCH Notion.
// - invoiceNumber : single value (rétrocompat — équivaut à invoiceNumbers: [invoiceNumber]).
// - tableau vide ou string vide = unlink (efface la valeur Notion).
// - confirmDuplicates (Patch 2++++) : si true, accepte de retirer les factures déjà liées ailleurs.
//   Sinon : refuse avec 409 INVALID_DUPLICATE en listant les conflits.
app.post('/api/facturation-matching/link', async (req, res) => {
  try {
    const { missionNom, type, invoiceNumbers, invoiceNumber, expectedCurrent, confirmDuplicates } = req.body || {};
    if (!missionNom || !type) return res.status(400).json({ error: 'missionNom et type requis' });
    if (type !== 'acompte' && type !== 'solde') return res.status(400).json({ error: 'type doit être acompte ou solde' });

    let listInput;
    if (Array.isArray(invoiceNumbers)) {
      listInput = invoiceNumbers;
    } else if (typeof invoiceNumber === 'string') {
      listInput = invoiceNumber ? [invoiceNumber] : [];
    } else {
      listInput = [];
    }
    const cleaned = parseLinkedInvoiceList(listInput.join(','));
    const newValue = cleaned.join(', ');

    const missions = await fetchAllNotionMissions();
    const mission = missions.find(m => m.nom === missionNom);
    if (!mission) return res.status(404).json({ error: 'Mission introuvable' });

    // Détection doublons : pour chaque invoice du nouveau lien, cherche dans les autres (mission, type).
    // Skip si la liste cible est vide (unlink, jamais de conflit possible).
    let conflicts = [];
    if (cleaned.length > 0) {
      conflicts = findDuplicateLinks(cleaned, missions, missionNom, type);
      if (conflicts.length > 0 && !confirmDuplicates) {
        return res.status(409).json({
          error: 'Factures déjà liées ailleurs — confirmation requise pour les retirer.',
          code: 'INVALID_DUPLICATE',
          conflicts: conflicts.map(c => ({
            invoice: c.invoice,
            otherMission: c.otherMission,
            otherType: c.otherType,
            otherCurrentList: c.otherCurrentList,
          })),
        });
      }
    }

    // Si conflits ET confirmé : retire d'abord les factures des anciens emplacements
    // pour éviter le doublon. Group par (mission, type) pour 1 PATCH par emplacement.
    if (conflicts.length > 0 && confirmDuplicates) {
      const removalsByLoc = new Map();
      for (const c of conflicts) {
        const key = c.otherMissionId + '||' + c.otherType;
        if (!removalsByLoc.has(key)) {
          removalsByLoc.set(key, {
            missionId: c.otherMissionId,
            missionNom: c.otherMission,
            type: c.otherType,
            removed: new Set(),
            currentList: c.otherCurrentList,
          });
        }
        removalsByLoc.get(key).removed.add(c.invoice.toLowerCase());
      }
      for (const info of removalsByLoc.values()) {
        const newList = info.currentList.filter(inv => !info.removed.has(inv.toLowerCase()));
        const newValueOther = newList.join(', ');
        const propNameOther = info.type === 'acompte' ? 'Fact acpt Penny' : 'Fact solde Penny';
        try {
          // Best effort : pas de expectedCurrent ici (on a refetché frais juste avant la détection).
          await updateNotionMissionRichTextProperty(info.missionId, propNameOther, newValueOther);
          console.log(`[duplicate cleanup] removed ${[...info.removed].join(', ')} from ${info.missionNom}/${info.type}`);
        } catch (err) {
          // Si le retrait échoue, on bloque le PATCH cible pour éviter un état incohérent
          console.error(`[duplicate cleanup FAILED] mission=${info.missionNom} type=${info.type}: ${err.message}`);
          return res.status(500).json({
            error: `Échec retrait facture chez ${info.missionNom}/${info.type} : ${err.message}. PATCH cible annulé pour éviter doublon.`,
            code: 'DUPLICATE_CLEANUP_FAILED',
          });
        }
      }
    }

    // PATCH cible
    const propName = type === 'acompte' ? 'Fact acpt Penny' : 'Fact solde Penny';
    try {
      const result = await updateNotionMissionRichTextProperty(mission.id, propName, newValue, expectedCurrent);
      res.json({
        ok: true,
        ...result,
        missionNom, type, propName, invoicesList: cleaned,
        cleanedFromOthers: conflicts.length, // info utile côté UI
      });
    } catch (err) {
      if (err.code === 'NOTION_DRIFT') {
        return res.status(409).json({ error: err.message, code: 'NOTION_DRIFT', currentValue: err.currentValue });
      }
      throw err;
    }
  } catch (err) {
    console.error('Erreur matching link:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/pennylane-raw', async (req, res) => {
  // Rate-limit safeguard côté serveur : on cap chaque entité à ~1000 pages max pour éviter les timeouts.
  // Pennylane pagine 20/pages + delay 400ms → ~500 items/entity en <1min.
  const results = {};

  // Liste des endpoints candidats à tenter. Certains peuvent 404 selon le plan / permissions Pennylane.
  const endpoints = [
    { key: 'customer_invoices',    path: '/customer_invoices',   params: {} },
    { key: 'supplier_invoices',    path: '/supplier_invoices',   params: {} },
    { key: 'customers',            path: '/customers',           params: {} },
    { key: 'suppliers',            path: '/suppliers',           params: {} },
    { key: 'products',             path: '/products',            params: {} },
    { key: 'transactions_90d',     path: '/transactions',        params: (() => {
        const d = new Date(); d.setDate(d.getDate() - 90);
        return { filter: JSON.stringify([{ field: 'date', operator: 'gteq', value: d.toISOString().split('T')[0] }]) };
    })() },
    { key: 'plan_items',           path: '/plan_items',          params: {} },
    { key: 'journal_entries_90d',  path: '/journal_entries',     params: (() => {
        const d = new Date(); d.setDate(d.getDate() - 90);
        return { filter: JSON.stringify([{ field: 'date', operator: 'gteq', value: d.toISOString().split('T')[0] }]) };
    })() },
    { key: 'credit_notes',         path: '/credit_notes',        params: {} },
  ];

  for (const ep of endpoints) {
    try {
      const items = await pennylaneFetchAll(ep.path, ep.params, 50);
      results[ep.key] = {
        count: items.length,
        sample: items.slice(0, 3),        // échantillon JSON pour debug
        records: items,                    // tous les records pour export CSV
      };
    } catch (err) {
      results[ep.key] = { error: err.message, count: 0, sample: [], records: [] };
    }
  }

  res.json({
    entities: Object.keys(results),
    data: results,
    fetchedAt: new Date().toISOString(),
  });
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

    // Rate limit Pennylane : 25 req/5s = 200ms minimum. On respecte 250ms (10% marge) pour speedup vs 400ms.
    await new Promise(r => setTimeout(r, 250));
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

// --- Plan TRE Prév : validations manuelles (subv/aide/prêt/avance/remb_opco/remb_avance reçus) ---
// Stockage Supabase (pas de matching auto Qonto pour ces flux). Bascule visuelle prévi → réel validé.
app.get('/api/plan-tre-validations', async (req, res) => {
  try {
    const { month } = req.query;
    let query = supabase.from('plan_tre_validations').select('*');
    if (month) query = query.eq('month_key', month);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/plan-tre-validations', async (req, res) => {
  try {
    const { lineLabel, lineCategory, monthKey, paid } = req.body || {};
    if (!lineLabel || !lineCategory || !monthKey) return res.status(400).json({ error: 'lineLabel, lineCategory, monthKey requis' });
    const validCategories = ['subvention', 'aide', 'pret', 'avance', 'remb_opco', 'remb_avance'];
    if (!validCategories.includes(lineCategory)) return res.status(400).json({ error: 'lineCategory invalide' });
    if (paid === false) {
      // Unmark : delete row
      const { error } = await supabase.from('plan_tre_validations').delete()
        .eq('line_label', lineLabel).eq('month_key', monthKey);
      if (error) throw new Error(error.message);
      return res.json({ ok: true, deleted: true });
    }
    const row = {
      line_label: lineLabel,
      line_category: lineCategory,
      month_key: monthKey,
      paid: true,
      validated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('plan_tre_validations').upsert(row, { onConflict: 'line_label,month_key' });
    if (error) throw new Error(error.message);
    res.json({ ok: true, validated: true });
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
// Cache 10 min : Pennylane pagine à 400ms/page, un refresh tréso sans cache prend plusieurs secondes.
let customerInvoicesCache = null;
let customerInvoicesCacheTime = 0;
const CUSTOMER_INVOICES_CACHE_TTL = 10 * 60 * 1000;

// Concurrency-limited map (Pennylane = 25 req/5s, on reste a 3 paralleles pour marge).
async function pLimitMap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (err) { results[idx] = { __error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Source de verite paid_at : Pennylane v2 ne fournit ni paid_at sur la facture, ni /payments
// (toujours vide). Mais le sous-endpoint /matched_transactions retourne la transaction Qonto
// matchee, avec sa vraie date. C'est la date du virement reel.
// Retry avec backoff exponentiel sur erreurs (rate limit Pennylane = 25 req/5s).
async function fetchInvoicePaidAtFromMatchedTx(invoiceId, attempt = 0) {
  const MAX_ATTEMPTS = 4;
  try {
    const result = await pennylaneRequest(`/api/external/v2/customer_invoices/${invoiceId}/matched_transactions`);
    const items = Array.isArray(result) ? result : (result.items || []);
    if (!items.length) return null;
    let latest = null;
    for (const tx of items) {
      const dateStr = tx.date;
      if (!dateStr) continue;
      if (!latest || new Date(dateStr) > new Date(latest)) latest = dateStr;
    }
    return latest;
  } catch (err) {
    // Retry sur rate limit ou erreur reseau, jusqu'a 4 tentatives (1s, 2s, 4s)
    if (attempt < MAX_ATTEMPTS - 1) {
      const delayMs = 1000 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delayMs));
      return fetchInvoicePaidAtFromMatchedTx(invoiceId, attempt + 1);
    }
    console.warn(`[fetchInvoicePaidAtFromMatchedTx] ${invoiceId} apres ${MAX_ATTEMPTS} tentatives: ${err.message}`);
    return null;
  }
}

async function fetchCustomerInvoices() {
  if (customerInvoicesCache && (Date.now() - customerInvoicesCacheTime) < CUSTOMER_INVOICES_CACHE_TTL) {
    return customerInvoicesCache;
  }
  const invoices = await pennylaneFetchAll('/customer_invoices', {});
  const mapped = invoices.map(inv => {
    // paidAt initial : fallback sur updated_at pour les factures status=paid (proxy imparfait
    // mais sans appel API). Sera override ci-dessous via matched_transactions (date reelle du virement).
    const isRealPaid = inv.paid && inv.status === 'paid';
    const paidAtFallback = isRealPaid && inv.updated_at ? inv.updated_at.split('T')[0] : null;
    return {
      id: inv.id,
      label: inv.label || '',
      customerName: extractCustomerFromLabel(inv.label),
      amount: parseFloat(inv.amount) || 0,
      remainingAmount: parseFloat(inv.remaining_amount_with_tax) || 0,
      currency: inv.currency || 'EUR',
      date: inv.date || null,
      dueDate: inv.deadline || null,
      status: inv.status || 'unknown', // paid, upcoming, late, incomplete, cancelled, archived
      paid: inv.paid || false,
      paidAt: paidAtFallback,
      invoiceNumber: inv.invoice_number || '',
      // Patch 2+ : signaux supplémentaires pour améliorer le matching (type acompte/solde + nom client plus propre)
      filename: inv.filename || '',
      pdfDescription: inv.pdf_description || '',
      pdfInvoiceSubject: inv.pdf_invoice_subject || '',
    };
  });

  // Enrichissement paidAt via matched_transactions (vraie date du virement Qonto).
  // ~150 fetchs en parallele 3 par 3, ~10-15s sur cache miss, absorbed par cache 10min.
  const toEnrich = mapped.filter(m => m.paid && m.status === 'paid');
  if (toEnrich.length > 0) {
    const t0 = Date.now();
    const txDates = await pLimitMap(toEnrich, 3, m => fetchInvoicePaidAtFromMatchedTx(m.id));
    let overridden = 0;
    let kept = 0;
    for (let i = 0; i < toEnrich.length; i++) {
      const txDate = txDates[i];
      if (txDate && typeof txDate === 'string' && !txDate.__error) {
        toEnrich[i].paidAt = txDate; // override avec la date reelle
        overridden++;
      } else {
        kept++; // garde le fallback updated_at
      }
    }
    console.log(`[fetchCustomerInvoices] paidAt enrichi: ${overridden} via matched_tx, ${kept} fallback updated_at, en ${Date.now() - t0}ms`);
  }

  customerInvoicesCache = mapped;
  customerInvoicesCacheTime = Date.now();
  return mapped;
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
    const transactions = await pennylaneFetchAll('/transactions', { filter });
    _transactionsCache = transactions;
    return transactions;
  } catch (err) {
    console.error('Erreur fetchRecentTransactions:', err.message);
    return _transactionsCache;
  }
}

// Cache for tresorerie data (avoid hammering API)
// Deux slots : sans M-1 (scénarios), avec M-1 (/api/tresorerie)
let tresorerieCache = null;
let tresorerieCacheTime = 0;
let tresorerieCacheWithPrev = null;
let tresorerieCacheWithPrevTime = 0;
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
// horizonMonths : nombre de mois projetés dans `previsionnel` (défaut 12, utilisé par /api/tresorerie).
// includePreviousMonth : si true, ajoute aussi M-1 au début de previsionnel (utilisé par /api/tresorerie
//   pour afficher le dernier mois clos à côté du mois en cours).
// startYear/startMonth : si fournis, override le point de départ (par défaut = mois courant).
//   Les endpoints scénarios utilisent startMonth=1 pour couvrir toute l'année civile.
// Le cache ne s'applique qu'au horizon par défaut sans override de start, pour éviter les résultats tronqués.
async function buildTresorerieFromQonto(horizonMonths = 12, { includePreviousMonth = false, startYear, startMonth } = {}) {
  const hasStartOverride = (startYear != null && startMonth != null);
  // Return cache if fresh (deux slots distincts selon includePreviousMonth, pas de cache si start override)
  if (horizonMonths === 12 && !hasStartOverride) {
    if (!includePreviousMonth && tresorerieCache && (Date.now() - tresorerieCacheTime) < TRESORERIE_CACHE_TTL) {
      return tresorerieCache;
    }
    if (includePreviousMonth && tresorerieCacheWithPrev && (Date.now() - tresorerieCacheWithPrevTime) < TRESORERIE_CACHE_TTL) {
      return tresorerieCacheWithPrev;
    }
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

  // --- Estimer les charges récurrentes mensuelles (utilisé par les KPIs top du tab Tréso) ---
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

  // --- Prévisionnel mois par mois : M-1 (clos, Qonto réel) + M (en cours) + (horizonMonths-1) futurs ---
  // Contrat :
  // - Mois CLOS (mKey < moisCourantKey) : encaissements/decaissements = Qonto réel
  // - Mois EN COURS + FUTURS : encaissements/decaissements = 0, seront remplis côté buildPrevisionnel
  //   (CR_Prev pour charges, factures Notion + pipeline pondéré pour encaissements)
  // soldeDebutFirstMonth = soldeDebut du premier mois de la projection (M-1), dérivé à rebours
  // depuis le solde Qonto actuel en décumulant les transactions réelles. Le cumul des soldes
  // mois par mois sera refait dans buildPrevisionnel à partir de ce point de départ.
  // Point de départ du loop : startYear/startMonth si fournis, sinon mois courant (+ éventuel -1 si includePreviousMonth)
  const loopStartYear = hasStartOverride ? startYear : currentYear;
  const loopStartMonth = hasStartOverride ? startMonth : currentMonth;
  const startOffset = (hasStartOverride || !includePreviousMonth) ? 0 : -1;

  const previsionnel = [];
  for (let i = startOffset; i < horizonMonths; i++) {
    const mDate = new Date(loopStartYear, loopStartMonth - 1 + i, 1);
    const mois = mDate.getMonth() + 1;
    const annee = mDate.getFullYear();
    const mKey = `${annee}-${String(mois).padStart(2, '0')}`;
    const label = `${String(mois).padStart(2, '0')}/${annee}`;
    const isClos = mKey < moisCourantKey;

    const encaissementsMois = isClos ? (encaissementsParMois[mKey] || 0) : 0;
    const decaissementsMois = isClos ? (chargesParMois[mKey] || 0) : 0;

    previsionnel.push({
      mois,
      annee,
      label,
      isClos,
      encaissements: Math.round(encaissementsMois),
      decaissements: Math.round(decaissementsMois),
      // soldeDebut / soldeFin seront calculés dans buildPrevisionnel à partir de soldeDebutFirstMonth
      soldeDebut: 0,
      soldeFin: 0,
      variation: 0,
    });
  }

  // Calcul du soldeDebut du premier mois du previsionnel, à rebours depuis le solde Qonto actuel :
  // solde(M) = soldeActuel - partial_M  (retire les movements du mois en cours)
  // puis on décumule chaque mois complet de (currentMonth - 1) jusqu'à firstMonth (inclus).
  let soldeDebutFirstMonth = solde || 0;
  soldeDebutFirstMonth -= (encaissementsParMois[moisCourantKey] || 0);
  soldeDebutFirstMonth += (chargesParMois[moisCourantKey] || 0);
  const firstMois = previsionnel[0];
  if (firstMois) {
    const firstDate = new Date(firstMois.annee, firstMois.mois - 1, 1);
    const currentDate = new Date(currentYear, currentMonth - 1, 1);
    let cursor = new Date(currentDate);
    cursor.setMonth(cursor.getMonth() - 1);
    while (cursor >= firstDate) {
      const cKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      soldeDebutFirstMonth -= (encaissementsParMois[cKey] || 0);
      soldeDebutFirstMonth += (chargesParMois[cKey] || 0);
      cursor.setMonth(cursor.getMonth() - 1);
    }
  }

  // --- Ventilation des charges par catégorie ---
  const ventilationCharges = Object.entries(chargesParCategorie)
    .map(([cat, montant]) => ({ categorie: cat, montant: Math.round(montant) }))
    .sort((a, b) => b.montant - a.montant);

  const result = {
    soldeActuel: solde,
    soldeDebutFirstMonth: Math.round(soldeDebutFirstMonth),
    moisCourantKey,
    chargesMoisCourant: Math.round(chargesMoisCourant),
    chargesMoyennes: Math.round(chargesMoyennes),
    ventilationCharges,
    previsionnel,
    encaissementsParMois,
    decaissementsParMois: chargesParMois,
    chargesDetailParMois,
    creditsDetailParMois,
  };

  // Update cache (slot dédié selon includePreviousMonth, pas de cache si start override)
  if (horizonMonths === 12 && !hasStartOverride) {
    if (includePreviousMonth) {
      tresorerieCacheWithPrev = result;
      tresorerieCacheWithPrevTime = Date.now();
    } else {
      tresorerieCache = result;
      tresorerieCacheTime = Date.now();
    }
  }

  return result;
}

// --- Google Sheets ---
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1btTMlLB4cNIN_PAkKOujBkOGU8DX526keOi-fvbPlsU';
const GID_MASSE_SALARIALE = 798407110;
const GID_SALARIES_META = 1450270387;
const GID_PLAN_TRESORERIE = 2116491556;
const GID_PROJETS = 0;
const GID_CATEGORIES_TVA = 771195553;

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

// --- Caches GSheet pour la masse salariale (30 min) ---
let masseSalarialeCache = null;
let masseSalarialeCacheTime = 0;
let salariesMetaCache = null;
let salariesMetaCacheTime = 0;
const MASSE_SALARIALE_CACHE_TTL = 30 * 60 * 1000;

// Lit l'onglet GSheet Masse_salariale et produit une structure indexée par mois :
// {
//   months: [{ month, year, label, mKey }],  // trié chronologiquement
//   byMonth: {
//     'YYYY-MM': {
//       total: 12345,
//       detail: [{ nom, net, charges, prime, aide, remuneration, gratification, cout }]  // un par employé
//     }
//   }
// }
// Sert à la fois au display (tab Masse salariale) et aux overrides scénarios (delta par employé).
async function fetchAndParseMasseSalarialeDetailed() {
  if (masseSalarialeCache && (Date.now() - masseSalarialeCacheTime) < MASSE_SALARIALE_CACHE_TTL) {
    return masseSalarialeCache;
  }
  const csv = await fetchGoogleSheetCSV(GID_MASSE_SALARIALE);
  const data = parseMasseSalariale(csv);
  if (data.error) throw new Error(data.error);

  // Catégories déjà parsées : { name: "Salaires nets", total: [vals], items: [{ name: "Juliette", values: [vals] }] }
  // On indexe par mois puis par nom d'employé, en agrégeant les montants par type.
  const monthsSorted = data.months.map(m => ({
    month: m.month, year: m.year, label: m.label,
    mKey: `${m.year}-${String(m.month).padStart(2, '0')}`,
  }));
  const byMonth = {};
  for (const m of monthsSorted) byMonth[m.mKey] = { total: 0, detail: {} };

  for (const cat of data.categories) {
    const typeKey = (() => {
      const n = cat.name.toLowerCase();
      if (n.startsWith('salaires nets'))        return 'net';
      if (n.startsWith('charges soci'))         return 'charges';
      if (n.startsWith('primes'))               return 'prime';
      if (n.startsWith('aide'))                 return 'aide';
      if (n.startsWith('rémunération'))         return 'remuneration';
      if (n.startsWith('gratification'))        return 'gratification';
      return null;
    })();
    if (!typeKey) continue;
    for (const item of cat.items) {
      monthsSorted.forEach((m, i) => {
        const val = item.values[i] || 0;
        if (val === 0) return;
        const slot = byMonth[m.mKey];
        if (!slot.detail[item.name]) {
          slot.detail[item.name] = { nom: item.name, net: 0, charges: 0, prime: 0, aide: 0, remuneration: 0, gratification: 0, cout: 0 };
        }
        slot.detail[item.name][typeKey] += val;
        slot.detail[item.name].cout += val;
        slot.total += val;
      });
    }
  }

  // Convertir chaque detail en array trié par coût descendant (pour l'affichage)
  for (const mKey of Object.keys(byMonth)) {
    const entries = Object.values(byMonth[mKey].detail).sort((a, b) => b.cout - a.cout);
    byMonth[mKey].detail = entries.map(e => ({ ...e, net: Math.round(e.net), charges: Math.round(e.charges), prime: Math.round(e.prime), aide: Math.round(e.aide), remuneration: Math.round(e.remuneration), gratification: Math.round(e.gratification), cout: Math.round(e.cout) }));
    byMonth[mKey].total = Math.round(byMonth[mKey].total);
  }

  const result = { months: monthsSorted, byMonth };
  masseSalarialeCache = result;
  masseSalarialeCacheTime = Date.now();
  return result;
}

// Lit l'onglet GSheet Salaires (metadata employés) : nom, type de contrat, date début/fin.
// Retourne [{ nom, type, date_debut, date_fin, isDirigeant }]. Utile pour la multi-select
// "Salariés concernés" de l'override salaire_augmentation.
// --- Catégories TVA (Phase E complète) ---
// Onglet "Catégories" (GID 771195553). Format attendu : colonne nom + colonne taux TVA.
// Parser défensif : scan toutes les colonnes pour trouver un taux TVA par ligne.
// Taux reconnu : "20", "20%", "0.20", "20,00%", etc. — normalisé en décimale (0.20 pour 20%).
let categoriesTvaCache = null;
let categoriesTvaCacheTime = 0;
const CATEGORIES_TVA_CACHE_TTL = 30 * 60 * 1000;

async function fetchAndParseCategoriesTVA() {
  if (categoriesTvaCache && (Date.now() - categoriesTvaCacheTime) < CATEGORIES_TVA_CACHE_TTL) {
    return categoriesTvaCache;
  }
  const csv = await fetchGoogleSheetCSV(GID_CATEGORIES_TVA);
  const rows = parseCSV(csv);
  const byCategorie = {};
  // Ignore les 2 premières lignes si header probable ("Catégorie" / "Nom" / "Catégories" en col A, etc.)
  let startRow = 0;
  for (let r = 0; r < Math.min(3, rows.length); r++) {
    const first = (rows[r][0] || '').trim().toLowerCase();
    if (first === 'catégorie' || first === 'categorie' || first === 'catégories' || first === 'nom' || first === 'libellé' || first === '') {
      startRow = r + 1;
    }
  }
  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    const nom = (row[0] || '').trim();
    if (!nom) continue;
    // Cherche un taux TVA dans les colonnes suivantes (première valeur numérique plausible en pct ou décimal)
    let taux = null;
    for (let c = 1; c < row.length; c++) {
      const raw = (row[c] || '').trim();
      if (!raw) continue;
      const cleaned = raw.replace(/[%\s ]/g, '').replace(',', '.');
      const n = parseFloat(cleaned);
      if (isNaN(n)) continue;
      if (n > 0.99 && n <= 30)  { taux = n / 100; break; } // "20", "20%", "5.5"
      else if (n >= 0 && n <= 0.30) { taux = n; break; }   // "0.20", "0.055"
      else if (n === 0) { taux = 0; break; }
    }
    if (taux !== null) byCategorie[nom] = taux;
  }
  const result = { byCategorie, nbDetected: Object.keys(byCategorie).length };
  console.log('[CategoriesTVA] parsed', result.nbDetected, 'catégories :', Object.keys(byCategorie).slice(0, 10).join(', '), result.nbDetected > 10 ? '...' : '');
  categoriesTvaCache = result;
  categoriesTvaCacheTime = Date.now();
  return result;
}

async function fetchAndParseSalariesMeta() {
  if (salariesMetaCache && (Date.now() - salariesMetaCacheTime) < MASSE_SALARIALE_CACHE_TTL) {
    return salariesMetaCache;
  }
  const csv = await fetchGoogleSheetCSV(GID_SALARIES_META);
  const rows = parseCSV(csv);
  const result = [];
  let seenDirigeantsHeader = false;
  // Col A = nom, B = type, C = date début, D = date fin. Header est ligne 1-2. Ligne "Dirigeants" = séparateur.
  for (let r = 2; r < rows.length; r++) {
    const nom = (rows[r][0] || '').trim();
    if (!nom) continue;
    if (/dirigeants/i.test(nom) && !/^\S/.test(rows[r][1] || '')) {
      seenDirigeantsHeader = true;
      continue;
    }
    const type = (rows[r][1] || '').trim();
    const date_debut = (rows[r][2] || '').trim() || null;
    const date_fin = (rows[r][3] || '').trim() || null;
    if (!type && !date_debut) continue; // ligne vide ou séparateur
    result.push({ nom, type, date_debut, date_fin, isDirigeant: seenDirigeantsHeader });
  }
  salariesMetaCache = result;
  salariesMetaCacheTime = Date.now();
  return result;
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

  // Financements / remboursements : pattern-based detection par catégorie.
  // Direction 'in' = encaissement (cash-in TTC), 'out' = décaissement (cash-out TTC).
  // inEBE = true → la ligne impacte l'EBE (produit/subvention d'exploitation).
  //         false → pur flux financier hors EBE (prêt, avance remboursable, remb. de dette).
  // ORDRE IMPORTANT : patterns plus spécifiques (Remb. Avance, Remb. OPCO) en premier pour
  // ne pas être capturés par les patterns génériques (Avance) qui suivent.
  // "Autres" n'a pas de pattern → ignoré silencieusement (cf. Q7 user).
  const financementPatterns = [
    { pattern: /^Remb\.?\s*OPCO/i,     category: 'remb_opco',    direction: 'in',  inEBE: true  }, // produit d'exploitation
    { pattern: /^Remb\.?\s*Avance/i,   category: 'remb_avance',  direction: 'out', inEBE: false }, // remboursement dette
    { pattern: /^Subvention\b/i,       category: 'subvention',   direction: 'in',  inEBE: true  }, // subvention d'exploitation
    { pattern: /^Aide\s/i,             category: 'aide',         direction: 'in',  inEBE: true  }, // subvention d'exploitation
    { pattern: /^Prêt\b/i,             category: 'pret',         direction: 'in',  inEBE: false }, // encaissement financier
    { pattern: /^Avance\b/i,           category: 'avance',       direction: 'in',  inEBE: false }, // encaissement financier
  ];

  const lines = {};
  const logicielsData = [];
  const chargesVariablesData = [];
  const financementsData = [];

  // Phase 2 UX : breakdown auto par catégorie cm.X (Option 2 user)
  // Structure : chargesParCategorieByMonth[mKey] = { 'Frais de personnel': { total: X, lines: [{ name, value }] }, ... }
  const chargesParCategorieByMonth = {};
  // Crédit de TVA = encaissement (cash-in) → exposé séparément
  const creditTvaByMonth = {};

  // Top-level section headers à ignorer / qui resettent le contexte cm.
  // - Lignes contenant "(ne rien écrire" : "Chiffre d'affaires (...)", "Charges Fixes (...)", "Charges Variables (...)"
  // - "Budget de TVA" : début section tracking TVA (TVA collectée/déductible/Solde) — tout ce qui suit jusqu'à
  //   prochain cm.X est à skipper côté charges (juste du tracking, pas du cash)
  const SKIP_AFTER_LABELS = new Set(['Budget de TVA']);
  let currentSection = null;
  let skipMode = false;

  function pushChargeLine(monthIdx, mKey, sectionName, lineName, value) {
    if (!chargesParCategorieByMonth[mKey]) chargesParCategorieByMonth[mKey] = {};
    if (!chargesParCategorieByMonth[mKey][sectionName]) {
      chargesParCategorieByMonth[mKey][sectionName] = { total: 0, lines: {} };
    }
    chargesParCategorieByMonth[mKey][sectionName].total += value;
    const existing = chargesParCategorieByMonth[mKey][sectionName].lines[lineName] || 0;
    chargesParCategorieByMonth[mKey][sectionName].lines[lineName] = existing + value;
  }

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    let label = (row[2] || '').trim();
    if (!label) label = (row[3] || '').trim();
    if (!label && row[1]) label = (row[1] || '').trim();
    if (!label) continue;

    const values = months.map(m => parseFrenchNumber(row[m.col] || ''));

    // === Logique existante (rétrocompat) ===
    if (keyLines[label]) lines[keyLines[label]] = values;
    if (logiciels.includes(label)) logicielsData.push({ name: label, values });
    if (chargesVariablesItems.includes(label)) chargesVariablesData.push({ name: label, values });
    const matchedFin = financementPatterns.find(p => p.pattern.test(label));
    if (matchedFin) {
      financementsData.push({
        name: label,
        category: matchedFin.category,
        direction: matchedFin.direction,
        inEBE: matchedFin.inEBE,
        values,
      });
    }

    // === Phase 2 UX : détection automatique sections cm.X ===
    // Détection en-tête section "cm.X" → switch contexte courant
    if (label.startsWith('cm.')) {
      currentSection = label.replace(/^cm\./, '').trim();
      skipMode = false;
      continue;
    }
    // Top-level header ("Charges Fixes (ne rien écrire...)", "Budget de TVA", etc.) → reset / skip
    if (/\(ne rien écrire/i.test(label)) {
      currentSection = null;
      skipMode = false;
      continue;
    }
    if (SKIP_AFTER_LABELS.has(label)) {
      currentSection = null;
      skipMode = true; // skip TVA collectée, TVA déductible, Solde de TVA qui suivent
      continue;
    }
    if (skipMode) continue;

    // Cas spéciaux TVA
    if (label === 'Crédit de TVA') {
      // ENCAISSEMENT TVA (remboursement) — exposé séparément
      months.forEach((m, i) => {
        const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
        creditTvaByMonth[key] = (creditTvaByMonth[key] || 0) + (values[i] || 0);
      });
      continue;
    }
    if (label === 'Décaissement de TVA') {
      // Catégorie dédiée "TVA" dans les charges
      months.forEach((m, i) => {
        const v = values[i] || 0;
        if (v === 0) return;
        const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
        pushChargeLine(i, key, 'TVA', label, v);
      });
      continue;
    }

    // Skip les lignes financements (subv/aide/prêt/avance/remb_opco/remb_avance) — déjà capturées plus haut, hors charges
    if (matchedFin) continue;

    // Skip les lignes encaissement CA (Enc. Acompte / Enc. Solde)
    if (/^Enc\./i.test(label)) continue;

    // Skip totaux / soldes / variations
    if (/^Total\b/i.test(label) || /^Trésorerie\b/i.test(label) || /^Variation\b/i.test(label)) continue;

    // Sub-catégorie d'une section cm.X courante → ajout au breakdown
    if (currentSection) {
      months.forEach((m, i) => {
        const v = values[i] || 0;
        if (v === 0) return;
        const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
        pushChargeLine(i, key, currentSection, label, v);
      });
    }
  }

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
    // Phase 2 UX : breakdown auto par catégorie cm.X + cas spéciaux TVA
    chargesParCategorieByMonth,
    creditTvaByMonth,
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

// --- Revenus exceptionnels Supabase : déprécié en migration 24.
// Table `revenus_exceptionnels` droppée. Use case remplacé par :
//   • override scénario `revenu_exceptionnel` (cas hypothétique)
//   • lignes Subvention/Aide du GSheet Plan_TRE_Prév (cas réels avec cat. TVA)

// --- Salariés : CRUD Supabase supprimé en Phase F ---
// Source de vérité = GSheet "Masse_salariale" (montants mensuels) + "Salaires" (metadata employés).
// Pour consulter la liste des employés : GET /api/scenarios/baseline/salaries.
// Pour le détail mensuel : consommé via fetchAndParseMasseSalarialeDetailed() dans la chaîne de projection.

// --- Fonction réutilisable : buildPrevisionnel() ---
// Extrait la logique de projection pour réutiliser dans les scénarios
// Helper : retourne le slot baseline d'un mois depuis le GSheet Masse_salariale.
// Extrapolation : si mKey est au-delà du dernier mois connu, on duplique le dernier ; si avant le premier, on retourne vide.
function getBaselineMasseSlot(masseSalarialeData, mKey) {
  if (!masseSalarialeData || !masseSalarialeData.byMonth) return { total: 0, detail: [] };
  const direct = masseSalarialeData.byMonth[mKey];
  if (direct) return direct;
  const months = Object.keys(masseSalarialeData.byMonth).sort();
  if (months.length === 0) return { total: 0, detail: [] };
  const lastKey = months[months.length - 1];
  if (mKey > lastKey) return masseSalarialeData.byMonth[lastKey];
  return { total: 0, detail: [] };
}

// --- TVA helpers (Phase E complète) ---
// Defaults par type d'override. Peut être surchargé par data.tva_taux côté frontend.
// direction: 'encaissement' (TVA collectée) | 'decaissement' (TVA déductible) | 'none' (hors TVA).
const OVERRIDE_TVA_DEFAULTS = {
  charges_fixes:         { taux: 0.20, direction: 'decaissement' },
  ca_estimatif:          { taux: 0.20, direction: 'encaissement' },
  revenu_recurrent:      { taux: 0.20, direction: 'encaissement' },
  revenu_exceptionnel:   { taux: 0,    direction: 'encaissement' }, // par défaut taux=0 (indemnités/dommages hors TVA). Si l'user saisit un taux > 0, la TVA collectée est trackée.
  pret:                  { taux: 0,    direction: 'none' }, // ni l'entrée ni les remb. ne portent TVA
  salaire:               { taux: 0,    direction: 'none' },
  salaire_augmentation:  { taux: 0,    direction: 'none' },
  subvention_annoncee:   { taux: 0,    direction: 'none' },
  pipeline:              { taux: 0.20, direction: 'encaissement' }, // deals fictifs = CA
  ligne_gsheet_override: { taux: 0.20, direction: 'decaissement' }, // heuristique : défaut charges
};

// Résout { taux, direction, ht, ttc, tva } pour un override donné.
// - data.tva_taux (décimal, ex. 0.20) override le défaut si fourni
// - data.montant_mode ('HT' | 'TTC', défaut 'HT') indique l'unité de saisie du montant
// - montant : champ selon le type (montant / montant_mensuel / montant_annuel)
// - categoriesTva : { nom: taux } depuis fetchAndParseCategoriesTVA(). Si data.categorie_tva est fournie,
//                   le taux de cette catégorie override le défaut.
function getOverrideTvaInfo(type, data, montant, categoriesTva = {}) {
  const defaults = OVERRIDE_TVA_DEFAULTS[type] || { taux: 0, direction: 'none' };
  // Taux : priorité explicit data.tva_taux > taux catégorie > défaut type
  let taux = defaults.taux;
  if (data.categorie_tva && categoriesTva[data.categorie_tva] != null) {
    taux = categoriesTva[data.categorie_tva];
  }
  if (typeof data.tva_taux === 'number' && data.tva_taux >= 0 && data.tva_taux < 1) {
    taux = data.tva_taux;
  }
  const mode = data.montant_mode === 'TTC' ? 'TTC' : 'HT';
  const m = Number(montant) || 0;
  let ht, ttc;
  if (mode === 'HT') { ht = m; ttc = m * (1 + taux); }
  else               { ttc = m; ht = taux > 0 ? m / (1 + taux) : m; }
  return {
    taux,
    direction: defaults.direction,
    mode,
    ht: Math.round(ht * 100) / 100,
    ttc: Math.round(ttc * 100) / 100,
    tva: Math.round((ttc - ht) * 100) / 100,
  };
}

// Calcule la masse salariale d'un mois donné :
// - baseline : lue directement depuis l'onglet GSheet "Masse_salariale" (source de vérité)
// - overrides scénario : add/modify/remove (par nom) + salaire_augmentation (par nom, depuis une date)
// Retourne { total, detail, baseline: { total, detail }, delta } où delta = total - (baseline si includeBaseline).
// Le delta est ce qu'il faut ajouter aux décaissements (la baseline est déjà dans CR_Prev "Frais de personnel").
function masseSalarialeMois(annee, mois, masseSalarialeData, masseOverrides = {}, includeBaseline = true) {
  const mKey = `${annee}-${String(mois).padStart(2, '0')}`;
  const mDate = new Date(annee, mois - 1, 15);
  const baseline = getBaselineMasseSlot(masseSalarialeData, mKey);
  const baselineTotal = baseline.total || 0;

  // Map keyée par nom d'employé. Chaque entrée : { nom, net, charges, prime, aide, remuneration, gratification, cout, source }
  const detailMap = new Map();
  if (includeBaseline) {
    for (const d of (baseline.detail || [])) {
      detailMap.set(d.nom, { ...d, source: 'baseline' });
    }
  }

  // Removals & modifications par nom (rétrocompat : si un override utilise salarie_id d'un ancien uuid Supabase,
  // on essaie aussi de matcher contre .nom de l'override — voir applyOverrides).
  const removedNames = masseOverrides.removedNames || [];
  for (const nom of removedNames) detailMap.delete(nom);

  for (const mod of (masseOverrides.modifications || [])) {
    const existing = detailMap.get(mod.nom);
    if (!existing) continue;
    const net = mod.net_mensuel != null ? mod.net_mensuel : existing.net;
    const charges = mod.charges_mensuelles != null ? mod.charges_mensuelles : existing.charges;
    const cout = net + charges + (existing.prime || 0) + (existing.aide || 0) + (existing.remuneration || 0) + (existing.gratification || 0);
    detailMap.set(mod.nom, { ...existing, net, charges, cout, source: 'override-modify' });
  }

  // Additions (new employees). Dates d'entrée/sortie à respecter.
  for (const add of (masseOverrides.additions || [])) {
    if (add.date_entree && new Date(add.date_entree) > mDate) continue;
    if (add.date_sortie && new Date(add.date_sortie) < new Date(annee, mois - 1, 1)) continue;
    const net = add.net_mensuel || 0;
    const charges = add.charges_mensuelles || 0;
    detailMap.set(add.nom, {
      nom: add.nom,
      net, charges,
      prime: 0, aide: 0, remuneration: 0, gratification: 0,
      cout: net + charges,
      source: 'override-add',
    });
  }

  // Augmentations multiplicatives, cumulatives, uniquement si date_debut <= mDate.
  for (const aug of (masseOverrides.augmentations || [])) {
    if (aug.date_debut && new Date(aug.date_debut) > mDate) continue;
    const multiplier = 1 + (aug.percent || 0) / 100;
    const targets = aug.targetNames || [];
    const applyAll = !targets || targets.length === 0;
    for (const [nom, entry] of detailMap) {
      if (!applyAll && !targets.includes(nom)) continue;
      detailMap.set(nom, {
        ...entry,
        net:           (entry.net || 0) * multiplier,
        charges:       (entry.charges || 0) * multiplier,
        prime:         (entry.prime || 0) * multiplier,
        aide:          (entry.aide || 0) * multiplier,
        remuneration:  (entry.remuneration || 0) * multiplier,
        gratification: (entry.gratification || 0) * multiplier,
        cout:          (entry.cout || 0) * multiplier,
        source: entry.source === 'baseline' ? 'baseline-aug' : entry.source,
      });
    }
  }

  const detail = Array.from(detailMap.values())
    .sort((a, b) => (b.cout || 0) - (a.cout || 0))
    .map(e => ({
      nom: e.nom,
      net: Math.round(e.net || 0),
      charges: Math.round(e.charges || 0),
      prime: Math.round(e.prime || 0),
      aide: Math.round(e.aide || 0),
      remuneration: Math.round(e.remuneration || 0),
      gratification: Math.round(e.gratification || 0),
      cout: Math.round(e.cout || 0),
      source: e.source,
    }));
  const total = detail.reduce((s, e) => s + e.cout, 0);

  return {
    total: Math.round(total),
    detail,
    baseline: { total: Math.round(baselineTotal), detail: baseline.detail || [] },
    delta: Math.round(total - (includeBaseline ? baselineTotal : 0)),
  };
}

// buildPrevisionnel — paramètres de composition baseline :
// - includeGSheet           : si false, les charges futures retombent sur la moyenne Qonto au lieu des valeurs GSheet CR_Prev (défaut true)
// - includePipeline         : si false, le pipeline pondéré HubSpot n'est pas calculé ni distribué (défaut true)
// - includeCaNotion         : si false, les encaissements factures Notion sont à 0 (défaut true).
//                             Utile pour un scénario "estimation CA annuelle from scratch" sans le CA déjà facturé.
// - includeSalariesBaseline : si false, masse salariale = 0 (ignore complètement la baseline Supabase `salaries`).
//                             Permet de recomposer une équipe fictive via les overrides `salaire`. Défaut true.
// Nouveaux leviers scénarios (Phase B) :
// - revenusRecurrentsExtras : [{ libelle, montant_mensuel, mois_debut, mois_fin }]
// - subventionsAnnoncees    : [{ libelle, montant, mois }] — catégorisées subv pour l'EBE, pas dans CA P&L
// - gsheetOverrides         : [{ categorie, mois_debut, mois_fin, montant_mensuel }]
// caSource :
//   'factures' (défaut, utilisé par /api/tresorerie) → CA = factures Pennylane émises + prévisionnelles Notion + pipeline
//   'crprev'   (utilisé par /api/scenarios/*)       → CA = CR_Prev `Enc. Acompte` + `Enc. Solde` (HT, missions signées Notion) + pipeline si toggle
// pastMode :
//   'real'  (défaut) → mois clos : charges Qonto réel (TTC), pas de subv/aides Plan_TRE_Prév (déjà dans Qonto)
//   'previ'          → mois clos : charges CR_Prev HT + subv/aides Plan_TRE_Prév (vue 100% budget annuel,
//                      aligne avec les lignes cumulées de CR_Prev). Le soldeDebutFirstMonth reste ancré Qonto,
//                      mais le cumul intermédiaire projette le budget au lieu de la réalité bancaire.
async function buildPrevisionnel({ qontoData, pipelineDeals, notionMissions, masseSalarialeData, masseOverrides = {}, revenus, chargesFixesExtras, pipelineFactor, fictionalDeals, crPrevData, caEstimatif, customerInvoices = [], caSource = 'factures', pastMode = 'real', includeGSheet = true, includePipeline = true, includeCaNotion = true, includeSalariesBaseline = true, revenusRecurrentsExtras = [], subventionsAnnoncees = [], gsheetOverrides = [] }) {
  // --- A encaisser : deux sources ---
  // 1) Factures ÉMISES depuis Pennylane (source de vérité pour late/upcoming, avec deadline et remaining_amount réels)
  // 2) Factures PRÉVISIONNELLES depuis Notion (missions dont la facture n'est pas encore émise)
  // Règle de déduplication : une mission Notion avec statut "Solde envoye" / "Acompte envoye" est IGNORÉE
  // ici car sa facture doit exister côté Pennylane. Si le statut Notion n'est pas à jour (facture émise
  // mais statut Notion resté "a envoyer"), la facture sera comptée une seule fois côté Pennylane,
  // pas en double. Propriété volontaire : discipline Notion ↔ vérité Pennylane.
  const facturesAEncaisser = [];
  const now = new Date();
  // Phase 1 (Pilot ↔ Penny réconciliation) : matching link Notion = source of truth.
  // Pour chaque (mission, acompte|solde) : si liens Pennylane existent → projeter chaque invoice liée
  // (montant + due_date réels). Sinon → projection Notion HT × 1.2 (estimation, status-based historique).
  // Pennylane unpaid orphans (non liés à aucune mission) → projetés en `pennylane-orphan` séparément.
  const notionWarnings = [];
  const pennylaneOrphans = [];
  const linkedInvoiceNumbersLower = new Set();
  const invoiceByNumberLower = new Map();
  for (const inv of (customerInvoices || [])) {
    if (inv.invoiceNumber) invoiceByNumberLower.set(inv.invoiceNumber.toLowerCase(), inv);
  }
  function echeanceJ45outer(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr); d.setDate(d.getDate() + 45);
    return d.toISOString().split('T')[0];
  }
  function projectLinkedInvoices(m, type, links) {
    let pushedAny = false;
    let allPaid = links.length > 0;
    let allCancelledOrMissing = links.length > 0;
    for (const num of links) {
      linkedInvoiceNumbersLower.add(num.toLowerCase());
      const inv = invoiceByNumberLower.get(num.toLowerCase());
      if (!inv) {
        notionWarnings.push({ missionNom: m.nom, type, code: 'linked-not-found',
          message: 'Lien vers "' + num + '" mais introuvable dans Pennylane' });
        allPaid = false;
        continue;
      }
      if (inv.paid) { allCancelledOrMissing = false; continue; }
      allPaid = false;
      if (inv.status === 'cancelled' || inv.status === 'incomplete') continue;
      allCancelledOrMissing = false;
      if (inv.status !== 'upcoming' && inv.status !== 'late') continue;
      if (!inv.remainingAmount || inv.remainingAmount <= 0) continue;
      const isLate2 = inv.status === 'late' || (inv.dueDate && new Date(inv.dueDate) < now);
      facturesAEncaisser.push({
        client: m.client || m.nom,
        mission: m.nom,
        type: type === 'acompte' ? 'Acompte' : 'Solde',
        montant: inv.remainingAmount,
        dateEmission: inv.date,
        dateEcheance: inv.dueDate,
        status: isLate2 ? 'late' : 'upcoming',
        previsionnel: false,
        source: 'pennylane-linked',
        invoiceNumber: inv.invoiceNumber,
      });
      pushedAny = true;
    }
    return { pushedAny, allPaid, allCancelledOrMissing };
  }
  function pushNotionForecast(m, type) {
    const isAcompte = type === 'acompte';
    const montantHT = isAcompte ? (m.montantAcompte || 0) : ((m.ca || 0) - (m.montantAcompte || 0));
    if (montantHT < 5) return;
    const dateEmission = isAcompte ? m.dateFactureAcompte : m.dateFactureFinale;
    facturesAEncaisser.push({
      client: m.client || m.nom,
      mission: m.nom,
      type: isAcompte ? 'Acompte' : 'Solde',
      montant: Math.round(montantHT * 1.2),
      montantHT,
      dateEmission,
      dateEcheance: echeanceJ45outer(dateEmission),
      status: 'previsionnel',
      previsionnel: true,
      source: 'notion',
    });
  }

  // --- 2) Pour chaque mission Notion : projection acompte/solde via matching link OU Notion forecast ---
  for (const m of notionMissions) {
    if (m.ca <= 0) continue;
    const status = (m.facturation || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (status.includes('solde paye')) continue; // mission close, Qonto a tout
    const oneShot = (m.montantAcompte || 0) < 5;

    // === ACOMPTE === : matching link prime sur status Notion
    if (!oneShot && (m.montantAcompte || 0) >= 5) {
      const acompteLinks = parseLinkedInvoiceList(m.factAcptPenny);
      const acompteState = acompteLinks.length > 0 ? projectLinkedInvoices(m, 'acompte', acompteLinks) : null;
      if (!acompteState) {
        const acompteEnvoye = status.includes('acompte envoye');
        const acomptePaye   = status.includes('acompte paye');
        const acompteAEnvoyer = status.includes('acompte a envoyer') || status === 'non defini' || status === '';
        if (!acompteEnvoye && !acomptePaye && acompteAEnvoyer) pushNotionForecast(m, 'acompte');
        if (acompteEnvoye) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'unmatched-issued',
            message: 'Notion "Acompte envoye" sans matching Pennylane — a matcher pour precision TRE' });
        }
      } else {
        if (acompteState.allPaid && (status.includes('acompte a envoyer') || status === 'non defini' || status === '')) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'notion-late-update',
            message: 'Notion "Acompte a envoyer" mais toutes les factures liees sont payees' });
        }
        if (status.includes('acompte paye') && !acompteState.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'notion-overdue',
            message: 'Notion "Acompte paye" mais une facture liee n est pas payee — Penny prime' });
        }
        if (acompteState.allCancelledOrMissing && !acompteState.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'acompte', code: 'linked-cancelled',
            message: 'Toutes les factures acompte liees sont annulees — re-projection Notion forecast' });
          pushNotionForecast(m, 'acompte');
        }
      }
    }

    // === SOLDE === : matching link prime sur status Notion
    const montantSoldeHT = (m.ca || 0) - (m.montantAcompte || 0);
    if (montantSoldeHT > 5) {
      const soldeLinks = parseLinkedInvoiceList(m.factSoldePenny);
      const soldeState = soldeLinks.length > 0 ? projectLinkedInvoices(m, 'solde', soldeLinks) : null;
      if (!soldeState) {
        const soldeEnvoye2 = status.includes('solde envoye');
        const acompteEnvoye2 = status.includes('acompte envoye');
        const soldeProjetable = status.includes('acompte paye') || status.includes('solde a envoyer')
                              || acompteEnvoye2 || status.includes('acompte a envoyer') || status === 'non defini' || status === '';
        if (!soldeEnvoye2 && soldeProjetable) pushNotionForecast(m, 'solde');
        if (soldeEnvoye2) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'unmatched-issued',
            message: 'Notion "Solde envoye" sans matching Pennylane — a matcher pour precision TRE' });
        }
      } else {
        if (soldeState.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'notion-late-update',
            message: 'Toutes les factures solde liees sont payees mais Notion non a jour' });
        }
        if (status.includes('solde a envoyer') && soldeState.pushedAny) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'notion-late-update',
            message: 'Notion "Solde a envoyer" mais factures Pennylane deja emises' });
        }
        if (soldeState.allCancelledOrMissing && !soldeState.allPaid) {
          notionWarnings.push({ missionNom: m.nom, type: 'solde', code: 'linked-cancelled',
            message: 'Toutes les factures solde liees sont annulees — re-projection Notion forecast' });
          pushNotionForecast(m, 'solde');
        }
      }
    }
  }

  // === ORPHANS Pennylane === : factures unpaid non liees a aucune mission Notion
  for (const inv of (customerInvoices || [])) {
    if (inv.paid) continue;
    if (inv.status === 'cancelled' || inv.status === 'incomplete') continue;
    if (!inv.remainingAmount || inv.remainingAmount <= 0) continue;
    if (inv.status !== 'upcoming' && inv.status !== 'late') continue;
    if (linkedInvoiceNumbersLower.has((inv.invoiceNumber || '').toLowerCase())) continue;
    const isLateO = inv.status === 'late' || (inv.dueDate && new Date(inv.dueDate) < now);
    facturesAEncaisser.push({
      client: inv.customerName || inv.label || '-',
      mission: inv.invoiceNumber || inv.label || 'Orphan',
      type: 'Facture',
      montant: inv.remainingAmount,
      dateEmission: inv.date,
      dateEcheance: inv.dueDate,
      status: isLateO ? 'late' : 'upcoming',
      previsionnel: false,
      source: 'pennylane-orphan',
      invoiceNumber: inv.invoiceNumber,
    });
    pennylaneOrphans.push({
      invoiceNumber: inv.invoiceNumber || '',
      customerName: inv.customerName || '',
      label: inv.label || '',
      amount: inv.remainingAmount,
      date: inv.date,
      dueDate: inv.dueDate,
      status: inv.status,
      isLate: isLateO,
    });
  }

  // Phase 2 UX : Pennylane factures DÉJÀ PAYÉES par mois (paid_at). Permet d'afficher dans modale
  // Tréso un section "Réels validés" + d'inclure dans encForSolde du mois courant pour solde précis.
  const pennylanePaidByMonth = {};
  const pennylanePaidDetailByMonth = {};
  for (const inv of (customerInvoices || [])) {
    // Filtre : booleen `inv.paid` Pennylane (source de verite "money in"), MAIS exclut explicitement
    // les avoirs/annulees (status cancelled/incomplete) et exige un `paidAt` reel pour eviter de
    // bucketer dans un mois futur via dueDate/date. Montant > 0 pour ecarter avoirs zero/negatifs.
    if (!inv.paid) continue;
    if (inv.status === 'cancelled' || inv.status === 'incomplete') continue;
    if (!inv.paidAt) continue;
    if ((inv.amount || 0) <= 0) continue;
    const dPaid = new Date(inv.paidAt);
    if (isNaN(dPaid.getTime())) continue;
    const mKeyPaid = `${dPaid.getFullYear()}-${String(dPaid.getMonth() + 1).padStart(2, '0')}`;
    pennylanePaidByMonth[mKeyPaid] = (pennylanePaidByMonth[mKeyPaid] || 0) + (inv.amount || 0);
    if (!pennylanePaidDetailByMonth[mKeyPaid]) pennylanePaidDetailByMonth[mKeyPaid] = [];
    pennylanePaidDetailByMonth[mKeyPaid].push({
      invoiceNumber: inv.invoiceNumber,
      customerName: inv.customerName,
      amount: inv.amount,
      paidAt: inv.paidAt,
      date: inv.date,
    });
  }

  facturesAEncaisser.sort((a, b) => {
    if (a.previsionnel !== b.previsionnel) return a.previsionnel ? 1 : -1;
    return new Date(a.dateEcheance || '2099-12-31') - new Date(b.dateEcheance || '2099-12-31');
  });

  const totalEnvoye = facturesAEncaisser.filter(f => !f.previsionnel).reduce((s, f) => s + f.montant, 0);
  const totalPrevisionnel = facturesAEncaisser.filter(f => f.previsionnel).reduce((s, f) => s + f.montant, 0);
  const totalAEncaisserNotion = totalEnvoye + totalPrevisionnel;

  // Calcul du pipeline pondéré HubSpot (désactivable via includePipeline=false)
  // Distribué dans pipelinePondereEncaissements[mKey] selon closedate + 45j de délai client.
  // Si pas de closedate, fallback sur le mois courant + 1.
  const factor = includePipeline ? (pipelineFactor != null ? pipelineFactor : 1) : 0;
  let pipelinePondere = 0;
  const pipelineDetail = [];
  const pipelinePondereEncaissements = {};
  if (includePipeline) {
    const fallbackDate = new Date(); fallbackDate.setMonth(fallbackDate.getMonth() + 1);
    for (const stage of KANBAN_STAGES) {
      const deals = pipelineDeals[stage.label] || [];
      for (const deal of deals) {
        const weighted = deal.amount * (deal.probability / 100) * factor;
        pipelinePondere += weighted;
        pipelineDetail.push({
          name: deal.name, amount: deal.amount,
          probability: deal.probability, weighted: Math.round(weighted), stage: stage.label,
          closedate: deal.closedate,
        });
        // Distribuer le poids dans le mois d'encaissement attendu (= closedate + 45j)
        const closing = deal.closedate ? new Date(deal.closedate) : fallbackDate;
        const cashDate = new Date(closing); cashDate.setDate(cashDate.getDate() + 45);
        const mKey = `${cashDate.getFullYear()}-${String(cashDate.getMonth() + 1).padStart(2, '0')}`;
        pipelinePondereEncaissements[mKey] = (pipelinePondereEncaissements[mKey] || 0) + weighted;
      }
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

    // Bucketing : les prévisionnelles ne sont jamais classées "En retard" — elles n'ont pas été émises,
    // donc aucune échéance de paiement. Leur mKey est forcé sur le mois courant si la date planifiée est
    // passée (retard de facturation interne → on l'affiche comme à encaisser ce mois-ci).
    if (f.previsionnel) {
      encaissementsPrev[mKey] = (encaissementsPrev[mKey] || 0) + f.montant;
    } else if (f.status === 'late' || isRetard) {
      encaissementsRetard[mKey] = (encaissementsRetard[mKey] || 0) + f.montant;
    } else {
      encaissementsEnvoye[mKey] = (encaissementsEnvoye[mKey] || 0) + f.montant;
    }
  }

  // --- Revenus exceptionnels ---
  // --- TVA tracking (Phase E complète) : overrides uniquement, ne double pas la TVA baseline
  //     déjà dans "Décaissement de TVA" de Plan_TRE_Prév. Collectée = overrides CA, Déductible = overrides charges.
  const tvaCollecteeByMonth = {};
  const tvaDeductibleByMonth = {};
  const trackTva = (mKey, tvaInfo) => {
    if (!tvaInfo || !tvaInfo.tva) return;
    const v = Math.abs(tvaInfo.tva);
    if (tvaInfo.direction === 'encaissement') tvaCollecteeByMonth[mKey] = (tvaCollecteeByMonth[mKey] || 0) + v;
    else if (tvaInfo.direction === 'decaissement') tvaDeductibleByMonth[mKey] = (tvaDeductibleByMonth[mKey] || 0) + v;
  };

  const revenusParMois = {};
  const revenusDetailParMois = {};
  for (const r of revenus) {
    revenusParMois[r.mois] = (revenusParMois[r.mois] || 0) + r.montant;
    if (!revenusDetailParMois[r.mois]) revenusDetailParMois[r.mois] = [];
    revenusDetailParMois[r.mois].push(r);
    trackTva(r.mois, r._tva);
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
          trackTva(mKey, cf._tva);
        }
      }
    }
  }

  // --- Revenus récurrents (scénarios) — analog à chargesFixesExtras côté encaissements ---
  const revenusRecurrentsParMois = {};
  if (revenusRecurrentsExtras && revenusRecurrentsExtras.length > 0) {
    for (const rr of revenusRecurrentsExtras) {
      for (const mois of qontoData.previsionnel) {
        const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
        if (mKey >= rr.mois_debut && mKey <= rr.mois_fin) {
          revenusRecurrentsParMois[mKey] = (revenusRecurrentsParMois[mKey] || 0) + rr.montant_mensuel;
          trackTva(mKey, rr._tva);
        }
      }
    }
  }

  // --- Subventions annoncées (scénarios) — one-shot, catégorisées subv pour remonter dans l'EBE ---
  const subvAnnonceesParMois = {};
  const subvAnnonceesDetailParMois = {};
  if (subventionsAnnoncees && subventionsAnnoncees.length > 0) {
    for (const s of subventionsAnnoncees) {
      subvAnnonceesParMois[s.mois] = (subvAnnonceesParMois[s.mois] || 0) + (s.montant || 0);
      if (!subvAnnonceesDetailParMois[s.mois]) subvAnnonceesDetailParMois[s.mois] = [];
      subvAnnonceesDetailParMois[s.mois].push(s);
      trackTva(s.mois, s._tva);
    }
  }

  // --- Deals fictifs (scénarios) ---
  // Le mois saisi par l'user = mois de signature/closing. L'encaissement effectif est
  // décalé de delai_encaissement_jours (défaut 45j, cohérent avec /api/charges convention)
  // pour modéliser le délai client réaliste.
  const fictionalEncaissements = {};
  if (fictionalDeals && fictionalDeals.length > 0) {
    for (const fd of fictionalDeals) {
      const closingKey = fd.mois;
      const delaiJours = (fd.delai_encaissement_jours != null) ? fd.delai_encaissement_jours : 45;
      let mKey = closingKey;
      if (closingKey && delaiJours) {
        const [y, m] = closingKey.split('-').map(Number);
        if (y && m) {
          const d = new Date(y, m - 1, 1);
          d.setDate(d.getDate() + delaiJours);
          mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
      }
      const montant = fd.montant * ((fd.probabilite || 100) / 100);
      fictionalEncaissements[mKey] = (fictionalEncaissements[mKey] || 0) + montant;
      trackTva(mKey, fd._tva);
    }
  }

  // --- Plan_TRE_Prév : source TTC pour charges et financements (redesign Patch 1) ---
  // - Charges : ligne "Total décaissements (€TTC)" → decaissementsTRE
  // - Financements 'in' (cash-in TTC) par catégorie :
  //     subvention / aide        → intégrés dans l'EBE (subventions d'exploitation)
  //     remb_opco                → produit d'exploitation (EBE +)
  //     pret / avance            → encaissement financier hors EBE
  // - Remboursements 'out' (cash-out TTC) par catégorie :
  //     remb_avance              → remboursement dette hors EBE
  // Les encaissements CA (Enc. Acompte + Enc. Solde de Plan_TRE_Prév) ne sont PLUS utilisés :
  // le CA prévi TTC provient désormais de Notion (×1.2) via notionProjectionByMonth.
  // CR_Prev reste la source HT pour la vue P&L / EBE (résultat d'exploitation HT traditionnel).
  // Si includeGSheet=false, tous ces postes sont à 0.
  const subvPlanTreByMonth = {};
  const aidePlanTreByMonth = {};
  const pretPlanTreByMonth = {};
  const avancePlanTreByMonth = {};
  const rembOpcoPlanTreByMonth = {};
  const rembAvancePlanTreByMonth = {};
  const planTreDecByMonth = {};
  const planTreDecDetailByMonth = {}; // { mKey: { 'Frais de personnel': X, 'Logiciels': Y, ... } } — totaux par catégorie
  const planTreDecLinesByMonth = {};  // { mKey: { 'Frais de personnel': { 'Salaires nets': X, 'Primes': Y } } } — lignes individuelles par catégorie
  const financementsDetailByMonth = {}; // { mKey: [{ name, category, direction, inEBE, amount }] } — pour modale validation
  const creditTvaByMonth_local = {};   // { mKey: amount } — Crédit de TVA = encaissement TVA
  if (includeGSheet) {
    try {
      const planData = await fetchAndParsePlanTresorerie();
      for (const fin of (planData.financements || [])) {
        planData.months.forEach((m, i) => {
          const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
          const val = fin.values[i] || 0;
          if (val === 0) return;
          switch (fin.category) {
            case 'subvention':    subvPlanTreByMonth[key]       = (subvPlanTreByMonth[key]       || 0) + val; break;
            case 'aide':          aidePlanTreByMonth[key]       = (aidePlanTreByMonth[key]       || 0) + val; break;
            case 'pret':          pretPlanTreByMonth[key]       = (pretPlanTreByMonth[key]       || 0) + val; break;
            case 'avance':        avancePlanTreByMonth[key]     = (avancePlanTreByMonth[key]     || 0) + val; break;
            case 'remb_opco':     rembOpcoPlanTreByMonth[key]   = (rembOpcoPlanTreByMonth[key]   || 0) + val; break;
            case 'remb_avance':   rembAvancePlanTreByMonth[key] = (rembAvancePlanTreByMonth[key] || 0) + val; break;
          }
          // Détail ligne par ligne pour modale validation
          if (!financementsDetailByMonth[key]) financementsDetailByMonth[key] = [];
          financementsDetailByMonth[key].push({
            name: fin.name,
            category: fin.category,
            direction: fin.direction,
            inEBE: fin.inEBE,
            amount: Math.round(val),
          });
        });
      }
      // Charges TTC par mois (ligne "Total décaissements (€TTC)")
      if (planData.lines) {
        planData.months.forEach((m, i) => {
          const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
          const totalDec = (planData.lines.totalDecaissements || [])[i] || 0;
          planTreDecByMonth[key] = Math.round(totalDec);
        });
      }
      // Phase 2 UX : breakdown charges TTC AUTO (Option 2 user) depuis parser parsePlanTresorerie.
      // Source : planData.chargesParCategorieByMonth (auto-détection cm.X dans le sheet).
      // Avantage : nouvelles lignes ajoutées dans le sheet apparaissent sans changement de code.
      if (planData.chargesParCategorieByMonth) {
        for (const [mKey, sections] of Object.entries(planData.chargesParCategorieByMonth)) {
          const totals = {};
          const lineDetails = {};
          for (const [secName, secData] of Object.entries(sections)) {
            if (Math.abs(secData.total) > 0.01) {
              totals[secName] = Math.round(secData.total);
              // Garde aussi le détail ligne par ligne (pour expansion accordéon)
              lineDetails[secName] = {};
              for (const [lineName, lineVal] of Object.entries(secData.lines)) {
                if (Math.abs(lineVal) > 0.01) lineDetails[secName][lineName] = Math.round(lineVal);
              }
            }
          }
          planTreDecDetailByMonth[mKey] = totals;
          planTreDecLinesByMonth[mKey] = lineDetails;
        }
      }
      // Crédit de TVA (encaissement TVA) — exposé séparément côté encaissements
      if (planData.creditTvaByMonth) {
        for (const [mKey, val] of Object.entries(planData.creditTvaByMonth)) {
          creditTvaByMonth_local[mKey] = Math.round(val);
        }
      }
    } catch (err) {
      console.warn('Plan_TRE_Prév fetch échoué dans buildPrevisionnel:', err.message);
    }
  }

  // Note redesign Patch 1 : le CA prévi TTC est alimenté par `facturesAEncaisser` enrichi TTC
  // (Pennylane émises + Notion prévi converties HT×1.2). Voir `encaissementsFactures` plus bas.

  // --- Charges GSheet par mois (source principale pour mois en cours + futurs, désactivable via includeGSheet=false) ---
  // gsheetOverrides permet de remplacer la valeur d'une catégorie mère sur une plage de mois
  // chargesGSheetDetailParMois : détail par catégorie pour l'affichage dans la modale mois
  const chargesGSheetParMois = {};
  const chargesGSheetDetailParMois = {};
  if (includeGSheet && crPrevData && crPrevData.categories) {
    const findOverride = (cat, mKey) => (gsheetOverrides || []).find(o =>
      o.categorie === cat && mKey >= o.mois_debut && mKey <= o.mois_fin
    );
    for (const [cat, moisData] of Object.entries(crPrevData.categories)) {
      for (const [mKey, val] of Object.entries(moisData)) {
        const override = findOverride(cat, mKey);
        const finalVal = override ? (override.montant_mensuel || 0) : val;
        chargesGSheetParMois[mKey] = (chargesGSheetParMois[mKey] || 0) + finalVal;
        if (!chargesGSheetDetailParMois[mKey]) chargesGSheetDetailParMois[mKey] = {};
        chargesGSheetDetailParMois[mKey][cat] = Math.round(finalVal);
      }
    }
  }

  // --- CA estimatif mensuel HT ---
  const caMensuelHT = caEstimatif
    ? Math.round((caEstimatif.montant_annuel || 0) / (caEstimatif.nb_mois || 12))
    : null;

  // Track la TVA du CA estimatif : applique _tva.tva à chaque mois non-clos où caMensuelHT est utilisé
  if (caEstimatif && caEstimatif._tva && caEstimatif._tva.tva) {
    for (const mois of qontoData.previsionnel) {
      const isClos = mois.isClos === true;
      if (!isClos) {
        const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
        trackTva(mKey, caEstimatif._tva);
      }
    }
  }

  // --- Reversement TVA M+1 (overrides uniquement, avec carry-forward du crédit TVA) ---
  // La baseline Plan_TRE_Prév a déjà sa propre ligne "Décaissement de TVA" remplie manuellement.
  // Ici on n'ajoute QUE le delta overrides : collectée(M) - déductible(M) à payer en M+1 si positif,
  // sinon crédit reporté sur les mois suivants.
  const reversementTvaByMonth = {};
  let tvaCreditBalance = 0;
  for (const mois of qontoData.previsionnel) {
    const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
    const collectee = tvaCollecteeByMonth[mKey] || 0;
    const deductible = tvaDeductibleByMonth[mKey] || 0;
    const netSolde = collectee - deductible;
    const netEffective = netSolde - tvaCreditBalance;
    // M+1 key
    const nextDate = new Date(mois.annee, mois.mois, 1); // mois.mois est 1-indexed → nextDate = M+1 (0-indexed)
    const nextMKey = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
    if (netEffective > 0) {
      reversementTvaByMonth[nextMKey] = (reversementTvaByMonth[nextMKey] || 0) + Math.round(netEffective);
      tvaCreditBalance = 0;
    } else {
      tvaCreditBalance = -netEffective; // accumule (netEffective est négatif → on stocke sa valeur positive)
    }
  }

  const previsionnelFinal = qontoData.previsionnel.map((mois) => {
    const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
    // Régime : isClos (mois passé clos) → encaissements/charges = Qonto réel uniquement.
    //          !isClos (mois en cours + futurs) → CR_Prev pour charges, factures Notion + pipeline pour encaissements.
    const isClos = mois.isClos === true;

    // --- Encaissements ---
    // caSource='crprev' (scenarios) : CA = CR_Prev Enc. Acompte + Enc. Solde (HT, missions signées Notion).
    //                                 Pennylane et prévisionnelles Notion non utilisées ici (doublon avec CR_Prev dérivé Notion).
    //                                 Pipeline pondéré conservé (ADD-ON, deals non signés → pas de doublon).
    // caSource='factures' (/api/tresorerie) : logique actuelle factures Pennylane + Notion prévisionnelles + pipeline.
    const isCaSourceCRPrev = caSource === 'crprev';
    let encaissementsFactures, factEnvoye, factPrev, factRetard, fictionalEnc, pipelineEnc;
    if (isClos) {
      factEnvoye = 0; factPrev = 0; factRetard = 0;
      encaissementsFactures = 0;
      fictionalEnc = 0;
      pipelineEnc = 0;
    } else if (caMensuelHT !== null) {
      // CA estimatif (scénario) : remplace TOUT le CA baseline
      factEnvoye = 0; factPrev = 0; factRetard = 0;
      encaissementsFactures = 0;
      fictionalEnc = 0;
      pipelineEnc = 0;
    } else if (isCaSourceCRPrev) {
      // Scenarios : pas de factures Pennylane/Notion (doublon CR_Prev). Pipeline conservé.
      factEnvoye = 0; factPrev = 0; factRetard = 0;
      encaissementsFactures = 0;
      fictionalEnc = Math.round(fictionalEncaissements[mKey] || 0);
      pipelineEnc = Math.round(pipelinePondereEncaissements[mKey] || 0);
    } else if (!includeCaNotion) {
      // Scénario "sans CA facturé Notion" : zéro les factures Notion, le pipeline et les deals fictifs restent
      factEnvoye = 0; factPrev = 0; factRetard = 0;
      encaissementsFactures = 0;
      fictionalEnc = Math.round(fictionalEncaissements[mKey] || 0);
      pipelineEnc = Math.round(pipelinePondereEncaissements[mKey] || 0);
    } else {
      factEnvoye = Math.round(encaissementsEnvoye[mKey] || 0);
      factPrev = Math.round(encaissementsPrev[mKey] || 0);
      factRetard = Math.round(encaissementsRetard[mKey] || 0);
      encaissementsFactures = factEnvoye + factPrev + factRetard;
      fictionalEnc = Math.round(fictionalEncaissements[mKey] || 0);
      pipelineEnc = Math.round(pipelinePondereEncaissements[mKey] || 0);
    }

    // Revenus exceptionnels / récurrents / subventions : overrides scénario only (0 pour /api/tresorerie)
    // Pour mois clos : on les zéro (les entrées réelles sont déjà dans le cash-in Qonto du mois).
    const revExc            = isClos ? 0 : Math.round(revenusParMois[mKey] || 0);
    const revenusRecurrents = isClos ? 0 : Math.round(revenusRecurrentsParMois[mKey] || 0);
    const subvAnnoncees     = isClos ? 0 : Math.round(subvAnnonceesParMois[mKey] || 0);

    // Masse salariale baseline depuis GSheet Masse_salariale + overrides scénario (add/modify/remove/augmentation).
    // Pour les mois CLOS (passés), on n'expose que la baseline (pas d'override appliqué — les vraies charges
    // sont dans mois.decaissements Qonto).
    const masse = isClos
      ? masseSalarialeMois(mois.annee, mois.mois, masseSalarialeData, {}, includeSalariesBaseline)
      : masseSalarialeMois(mois.annee, mois.mois, masseSalarialeData, masseOverrides, includeSalariesBaseline);
    const chargesFixesExtra = isClos ? 0 : Math.round(chargesFixesParMois[mKey] || 0);

    // --- Décaissements ---
    // pastMode='real' (défaut) : mois clos → Qonto réel, mois non-clos → CR_Prev HT
    // pastMode='previ'          : tous les mois → CR_Prev HT (vue budget annuel)
    // Fallback si includeGSheet=false ou pas de data CR_Prev pour ce mois : garde Qonto réel.
    const useBudgetCharges = !isClos || pastMode === 'previ';
    let decaissementsBase = mois.decaissements; // = Qonto réel pour isClos, 0 pour !isClos (avant override)
    let decaissementsBaseSource = isClos ? 'qonto' : 'none'; // source de decaissementsBase (avant overrides)
    let chargesGSheetDetail = null;
    if (useBudgetCharges && chargesGSheetParMois[mKey] != null) {
      decaissementsBase = Math.round(chargesGSheetParMois[mKey]);
      decaissementsBaseSource = 'crprev';
      chargesGSheetDetail = chargesGSheetDetailParMois[mKey] || {};
    }

    // --- Encaissements base ---
    // caSource='crprev' (scenarios) : CR_Prev Enc.* pour TOUS les mois (passés, courants, futurs).
    //   Pour les mois passés, on préfère CR_Prev (dérivé Notion = source vérité CA) plutôt que Qonto
    //   cash-in (qui peut être en retard d'un mois à cause des délais de paiement).
    //   Les charges des mois passés restent en Qonto réel (cf. decaissementsBase plus haut).
    // caSource='factures' (/api/tresorerie) : Qonto réel pour mois clos, factures+pipeline pour mois en cours/futurs.
    let encBase;
    let encBaseSource; // 'ca-estimatif' | 'crprev' | 'qonto' (mois clos) — sert au wording des tooltips
    if (caMensuelHT !== null && !isClos) {
      encBase = caMensuelHT;
      encBaseSource = 'ca-estimatif';
    } else if (isCaSourceCRPrev) {
      encBase = Math.round((crPrevData && crPrevData.encaissementsCA && crPrevData.encaissementsCA[mKey]) || 0);
      encBaseSource = 'crprev';
    } else {
      encBase = mois.encaissements;
      encBaseSource = isClos ? 'qonto' : 'crprev';
    }

    // Delta masse salariale à appliquer aux décaissements : uniquement pour mois non-clos,
    // car CR_Prev "Frais de personnel" contient déjà la baseline. Le delta reflète les overrides
    // scénario (add/modify/remove/augmentation) + le retrait de baseline si includeSalariesBaseline=false.
    const masseDelta = isClos ? 0 : (masse.delta || 0);

    // Financements Plan_TRE_Prév : après redesign Patch 1, on bascule toujours Qonto pour les mois clos
    // (CA et financements sont dans Qonto cash-in réel). On n'injecte Plan_TRE_Prév que pour les mois non-clos.
    // Ça évite le double-compte et simplifie (pastMode n'a plus d'effet sur les mois clos).
    const showPlanTreFinancements = !isClos;
    const subvPlanTreMois       = showPlanTreFinancements ? Math.round(subvPlanTreByMonth[mKey]       || 0) : 0;
    const aidePlanTreMois       = showPlanTreFinancements ? Math.round(aidePlanTreByMonth[mKey]       || 0) : 0;
    const pretPlanTreMois       = showPlanTreFinancements ? Math.round(pretPlanTreByMonth[mKey]       || 0) : 0;
    const avancePlanTreMois     = showPlanTreFinancements ? Math.round(avancePlanTreByMonth[mKey]     || 0) : 0;
    const rembOpcoPlanTreMois   = showPlanTreFinancements ? Math.round(rembOpcoPlanTreByMonth[mKey]   || 0) : 0;
    const rembAvancePlanTreMois = showPlanTreFinancements ? Math.round(rembAvancePlanTreByMonth[mKey] || 0) : 0;

    // --- Champs TRE TTC (redesign Patch 1) : base Notion+Pennylane TTC (mois non-clos) ou Qonto réel (mois clos) ---
    // Règle :
    // - Mois clos : Qonto cash-in réel (source absolue pour le passé, ignore Notion pour éviter double-compte)
    // - Mois non-clos : somme des factures attendues TTC = facturesAEncaisser (Pennylane non-payées + Notion prévi ×1.2)
    //   → équivalent à (factEnvoye + factPrev + factRetard) du mois
    // - Scénario avec CA estimatif : override complet (remplace Notion)
    let encaissementsTRE, encaissementsTRESource;
    if (isClos) {
      // Mois clos : TOUJOURS Qonto (pastMode n'a plus d'effet sur les mois clos après redesign)
      encaissementsTRE = Math.round(qontoData.encaissementsParMois ? (qontoData.encaissementsParMois[mKey] || 0) : 0);
      encaissementsTRESource = 'qonto';
    } else if (caMensuelHT !== null) {
      // Scénario CA estimatif : remplace le baseline Notion (user-entered, opaque HT/TTC)
      encaissementsTRE = caMensuelHT;
      encaissementsTRESource = 'ca-estimatif';
    } else if (isCaSourceCRPrev) {
      // Mode Scenarios : la vue P&L (encaissementsTotal) utilise CR_Prev via encBase, donc on a
      // zero les factures Pennylane/Notion plus haut pour eviter le doublon en P&L. Mais pour la
      // vue TRE (soldeFin du graphe), on a besoin de la vraie projection cash : memes factures
      // TTC que la page Treso (Pennylane non-payees + Notion previ HT*1.2). On recalcule donc
      // depuis les maps source qui ne sont jamais zero'd.
      const factEnvoyeTRE  = Math.round(encaissementsEnvoye[mKey]  || 0);
      const factPrevTRE    = Math.round(encaissementsPrev[mKey]    || 0);
      const factRetardTRE  = Math.round(encaissementsRetard[mKey]  || 0);
      encaissementsTRE = factEnvoyeTRE + factPrevTRE + factRetardTRE;
      encaissementsTRESource = 'notion';
    } else {
      // Somme des factures TTC attendues ce mois (Pennylane non-payées + Notion prévi HT×1.2)
      encaissementsTRE = Math.round(encaissementsFactures || 0);
      encaissementsTRESource = 'notion';
    }

    // Décaissements TRE TTC (redesign Patch 1) : Qonto pour mois clos, Plan_TRE_Prév pour mois non-clos.
    // pastMode n'a plus d'effet sur les mois clos (Qonto fait foi pour le passé).
    let decaissementsTREBase, decaissementsTRESource;
    if (isClos) {
      decaissementsTREBase = Math.round(mois.decaissements || 0); // Qonto réel TTC (set par buildTresorerieFromQonto)
      decaissementsTRESource = 'qonto';
    } else {
      decaissementsTREBase = Math.round(planTreDecByMonth[mKey] || 0);
      decaissementsTRESource = 'plan-tre';
    }

    // Reversement TVA M+1 (overrides uniquement). S'ajoute aux décaissements TTC de ce mois
    // si overrides CA des mois précédents ont généré un solde TVA positif.
    const tvaReversementM1 = Math.round(reversementTvaByMonth[mKey] || 0);
    const tvaCollecteeMois = Math.round(tvaCollecteeByMonth[mKey] || 0);
    const tvaDeductibleMois = Math.round(tvaDeductibleByMonth[mKey] || 0);

    return {
      ...mois,
      encaissementsFactures,
      encaissementsEnvoye: factEnvoye,
      encaissementsPrev: factPrev,
      encaissementsRetard: factRetard,
      revenusExceptionnels: revExc,
      revenusExceptionnelsDetail: revenusDetailParMois[mKey] || [],
      revenusRecurrents,
      subventionsAnnoncees: subvAnnoncees,
      subventionsAnnonceesDetail: subvAnnonceesDetailParMois[mKey] || [],
      subvPlanTre: subvPlanTreMois,
      aidePlanTre: aidePlanTreMois,
      // Nouveaux champs financements (redesign Patch 1) : Plan_TRE_Prév ventilé par catégorie.
      // Integration EBE : subv + aide + remb_opco → subvention/produit d'exploitation (EBE +)
      //                   pret + avance + remb_avance → flux financier hors EBE
      pretPlanTre: pretPlanTreMois,
      avancePlanTre: avancePlanTreMois,
      rembOpcoPlanTre: rembOpcoPlanTreMois,
      rembAvancePlanTre: rembAvancePlanTreMois,
      pipelinePondereEncaissements: pipelineEnc,
      masseSalariale: masse.total,
      masseSalarialeDetail: masse.detail,
      masseSalarialeBaseline: masse.baseline ? masse.baseline.total : 0,
      masseSalarialeDelta: masseDelta,
      chargesFixesExtra,
      fictionalEncaissements: fictionalEnc,
      decaissements: decaissementsBase + chargesFixesExtra + masseDelta,
      decaissementsBaseSource, // 'qonto' | 'crprev' | 'none' — pour libellé tooltip P&L
      chargesGSheetDetail, // null si decaissementsBaseSource !== 'crprev', { categorie: montant } sinon
      // Champs TRE TTC (Phase E light) : utilisés pour le calcul du solde fin de mois et le tooltip TRE.
      // encaissementsTRE : base TTC (Plan_TRE ou Qonto réel ou CA estimatif).
      // decaissementsTRE : base TTC + chargesFixesExtra (overrides) + masseDelta (overrides, HT).
      encaissementsTRE,
      encaissementsTRESource, // 'plan-tre' | 'qonto' | 'ca-estimatif'
      decaissementsTRE: decaissementsTREBase + chargesFixesExtra + masseDelta + tvaReversementM1,
      decaissementsTREBase,
      decaissementsTRESource, // 'plan-tre' | 'qonto'
      // Phase 2 UX : breakdown TTC par grands postes Plan TRE Prév (utilisé par modale Tréso au lieu du HT CR_Prév)
      chargesPlanTreDetail: planTreDecDetailByMonth[mKey] || {},
      // Phase 2 UX : Pennylane factures payées dans ce mois (paid_at). Pour clos = 0 (Qonto réel les inclut déjà
      // via encaissementsTRE). Pour non-clos (current month) = montant à ajouter à encForSolde pour solde précis.
      pennylanePaidThisMonth: isClos ? 0 : Math.round(pennylanePaidByMonth[mKey] || 0),
      pennylanePaidDetailThisMonth: isClos ? [] : (pennylanePaidDetailByMonth[mKey] || []),
      // Détail individuel des lignes Plan TRE Prév (pour dropdown validation dans modale Tréso)
      financementsDetail: financementsDetailByMonth[mKey] || [],
      // Phase 2 UX : Crédit de TVA = encaissement (remboursement TVA), exposé séparément
      creditTvaPlanTre: showPlanTreFinancements ? Math.round(creditTvaByMonth_local[mKey] || 0) : 0,
      // Détail lignes par catégorie (pour expansion accordéon dans modale)
      chargesPlanTreLines: planTreDecLinesByMonth[mKey] || {},
      // Phase E complète : info TVA overrides du mois + reversement M+1 (delta overrides, pas baseline)
      tvaCollectee: tvaCollecteeMois,
      tvaDeductible: tvaDeductibleMois,
      tvaReversementM1, // payé dans CE mois pour solde des mois précédents
      encaissements: encBase,
      encaissementsSource: encBaseSource,
      encaissementsTotal: encBase + encaissementsFactures + revExc + fictionalEnc + revenusRecurrents + subvAnnoncees + pipelineEnc,
    };
  });

  // Recalculer les soldes en cumulant depuis soldeDebutFirstMonth.
  // Pour les mois CLOS : on utilise le cash-in Qonto réel du mois (indépendamment de caSource)
  //   pour que soldeFin reproduise la réalité bancaire passée.
  // Pour les mois non-clos : soldeFin = projection budget (CR_Prev ou factures selon caSource).
  // decaissements : déjà en Qonto réel pour isClos, CR_Prev pour !isClos — on le réutilise tel quel.
  // Cumul TTC : encaissementsTRE (Plan_TRE ou Qonto réel ou CA estimatif) + subv/aide Plan_TRE + cash-in additionnels
  // (factures Notion/Pennylane en mode /api/tresorerie, pipeline, deals fictifs, revenus récurrents/exceptionnels,
  // subventions annoncées scénario). decaissementsTRE inclut déjà les overrides charges_fixes + masseDelta.
  // Les overrides restent HT par défaut — limite connue Phase E light, à traiter en Phase E complète.
  let soldeCumul = qontoData.soldeDebutFirstMonth != null
    ? qontoData.soldeDebutFirstMonth
    : (qontoData.soldeActuel || 0);
  for (const mois of previsionnelFinal) {
    // Redesign Patch 1 : encaissementsFactures n'est PLUS additionné séparément (double-compte) —
    // pour non-clos, encaissementsTRE = encaissementsFactures (mêmes valeurs TTC).
    // Ajout des nouveaux financements Plan_TRE_Prév : pret + avance + remb_opco (cash-in non-clos),
    // remb_avance (cash-out non-clos).
    // Phase 2 UX : Pennylane paid this month = factures Pennylane déjà payées en réel ce mois.
    // Pour clos = 0 (déjà inclus dans encaissementsTRE Qonto). Pour non-clos = à ajouter pour solde précis.
    const encForSolde = (mois.encaissementsTRE || 0)
                      + (mois.pennylanePaidThisMonth || 0)
                      + (mois.subvPlanTre || 0) + (mois.aidePlanTre || 0)
                      + (mois.pretPlanTre || 0) + (mois.avancePlanTre || 0) + (mois.rembOpcoPlanTre || 0)
                      + (mois.creditTvaPlanTre || 0)
                      + (mois.revenusExceptionnels || 0)
                      + (mois.fictionalEncaissements || 0) + (mois.revenusRecurrents || 0)
                      + (mois.subventionsAnnoncees || 0) + (mois.pipelinePondereEncaissements || 0);
    const decForSolde = (mois.decaissementsTRE || 0) + (mois.rembAvancePlanTre || 0);
    const variation = encForSolde - decForSolde;
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
    notionWarnings,        // [{ missionNom, type, code, message }]
    pennylaneOrphans,      // [{ invoiceNumber, customerName, amount, date, dueDate, status, isLate }]
  };
}

app.get('/api/tresorerie', async (req, res) => {
  try {
    // Toggle "Pipeline pondéré" côté UI (default ON, désactivable via ?includePipeline=false)
    const includePipeline = req.query.includePipeline !== 'false';
    // customerInvoices (Pennylane) : tolère un échec — sans, les factures émises retomberaient sur Notion.
    // Au lieu de faire ça silencieusement, on signale l'échec pour que le frontend puisse afficher un warning.
    let customerInvoices = [];
    let pennylaneError = null;
    let masseSalarialeData = null;
    let masseSalarialeError = null;
    const [qontoData, pipelineDeals, notionMissions, pennylaneRes, masseRes] = await Promise.all([
      buildTresorerieFromQonto(12, { includePreviousMonth: true }),
      fetchOpenDeals(),
      fetchAllNotionMissions(),
      fetchCustomerInvoices().catch(err => { pennylaneError = err.message; return []; }),
      fetchAndParseMasseSalarialeDetailed().catch(err => { masseSalarialeError = err.message; return null; }),
    ]);
    customerInvoices = pennylaneRes;
    masseSalarialeData = masseRes;

    // Revenus exceptionnels Supabase droppée en migration 24 (cf. header section plus haut)
    const revenus = [];

    const crPrevData = await fetchAndParseCRPrev();
    const result = await buildPrevisionnel({
      qontoData, pipelineDeals, notionMissions,
      masseSalarialeData, masseOverrides: {}, revenus,
      chargesFixesExtras: [], pipelineFactor: 1, fictionalDeals: [],
      crPrevData, caEstimatif: null,
      customerInvoices,
      includePipeline,
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
      notionWarnings: result.notionWarnings || [],
      pennylaneOrphans: result.pennylaneOrphans || [],
      pennylaneError,
      masseSalarialeError,
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
  const { nom, description, include_gsheet, include_pipeline, include_ca_notion, include_salaries_baseline } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (typeof nom === 'string') update.nom = nom;
  if (typeof description === 'string' || description === null) update.description = description;
  if (typeof include_gsheet === 'boolean')            update.include_gsheet = include_gsheet;
  if (typeof include_pipeline === 'boolean')          update.include_pipeline = include_pipeline;
  if (typeof include_ca_notion === 'boolean')         update.include_ca_notion = include_ca_notion;
  if (typeof include_salaries_baseline === 'boolean') update.include_salaries_baseline = include_salaries_baseline;
  const { data, error } = await supabase.from('scenarios')
    .update(update)
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
  const validTypes = [
    'salaire', 'pipeline', 'charges_fixes', 'revenu_exceptionnel', 'ca_estimatif',
    'salaire_augmentation', 'revenu_recurrent', 'pret', 'subvention_annoncee', 'ligne_gsheet_override',
  ];
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

// Convertit un preset d'horizon en nombre de mois à projeter (à partir du mois en cours, inclus)
// Utilisé par /api/tresorerie.
function getHorizonMonths(preset) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  let endYear, endMonth;
  if (preset === 's1-np1')       { endYear = currentYear + 1; endMonth = 6;  }
  else if (preset === 'n-plus-1'){ endYear = currentYear + 1; endMonth = 12; }
  else                           { endYear = currentYear;     endMonth = 12; } // fin-annee (défaut)
  return Math.max(1, (endYear - currentYear) * 12 + (endMonth - currentMonth) + 1);
}

// Pour les endpoints scénarios : horizon sur l'année civile complète (Jan → preset end).
// Permet d'aligner "CA cumulé à fin déc 26" sur la ligne "CA cumulé (estimation)" de CR_Prev.
// Retourne { startYear, startMonth (=1), horizonMonths } pour feed buildTresorerieFromQonto.
function getScenarioHorizon(preset) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const startYear = currentYear;
  const startMonth = 1;
  let endYear, endMonth;
  if (preset === 's1-np1')       { endYear = currentYear + 1; endMonth = 6;  }
  else if (preset === 'n-plus-1'){ endYear = currentYear + 1; endMonth = 12; }
  else                           { endYear = currentYear;     endMonth = 12; } // fin-annee
  const horizonMonths = Math.max(1, (endYear - startYear) * 12 + (endMonth - startMonth) + 1);
  return { startYear, startMonth, endYear, endMonth, horizonMonths };
}

// Parse les query params communs aux endpoints de projection (horizon, toggles baseline)
// Les 4 toggles (gsheet, pipeline, caNotion, salariesBaseline) ne servent que pour
// /api/scenarios/baseline/projection. Pour /api/scenarios/:id/projection, les flags sont
// lus directement depuis la ligne `scenarios` du scénario (include_gsheet, etc.).
function parseProjectionQuery(req) {
  const preset = req.query.horizon || 'fin-annee';
  // pastMode : 'previ' (défaut sur scenarios) aligne sur CR_Prev pour l'année entière ;
  // 'real' garde Qonto réel pour les mois clos (charges TTC + pas de subv/aide Plan_TRE sur passé).
  const pastMode = req.query.pastMode === 'real' ? 'real' : 'previ';
  return {
    preset,
    horizonMonths: getHorizonMonths(preset),
    pastMode,
    includeGSheet:           req.query.includeGSheet           !== 'false',
    includePipeline:         req.query.includePipeline         !== 'false',
    includeCaNotion:         req.query.includeCaNotion         !== 'false',
    includeSalariesBaseline: req.query.includeSalariesBaseline !== 'false',
  };
}

// Enrichit chaque mois de la projection avec les champs P&L et EBE cumulé pour les tabs de visualisation.
// Consomme directement les champs subvPlanTre / aidePlanTre déjà exposés par buildPrevisionnel
// (cohérent avec leur usage dans le calcul du solde, pas de second fetch Plan_TRE_Prév).
async function enrichWithPnlEbe(projection, { includeGSheet = true } = {}) {
  let ebeCumul = 0;
  return projection.map((mois) => {
    // Les subventions annoncées (scénario) sont cash-in pour la tréso mais NE sont PAS du CA P&L ;
    // on les retire du pnl_ca et on les ajoute aux subventions pour l'EBE.
    const subvAnnonceesMois = mois.subventionsAnnoncees || 0;
    const encTotal = mois.encaissementsTotal ?? ((mois.encaissements || 0) + (mois.encaissementsFactures || 0) + (mois.revenusExceptionnels || 0) + (mois.fictionalEncaissements || 0) + (mois.revenusRecurrents || 0) + subvAnnonceesMois + (mois.pipelinePondereEncaissements || 0));
    const ca = encTotal - subvAnnonceesMois;
    const charges = mois.decaissements || 0;
    const subvGSheet = includeGSheet ? (mois.subvPlanTre || 0) : 0;
    const aide       = includeGSheet ? (mois.aidePlanTre || 0) : 0;
    // Redesign Patch 1 : Remb. OPCO = produit d'exploitation (EBE +), au même titre que les subventions.
    // Prêt, Avance, Remb. Avance : hors EBE (flux financiers pur).
    const rembOpco   = includeGSheet ? (mois.rembOpcoPlanTre || 0) : 0;
    const subv = subvGSheet + subvAnnonceesMois;
    const marge = ca - charges;
    const ebeMensuel = marge + subv + aide + rembOpco;
    ebeCumul += ebeMensuel;
    return {
      ...mois,
      pnl_ca:       Math.round(ca),
      pnl_charges:  Math.round(charges),
      pnl_marge:    Math.round(marge),
      subventions:  Math.round(subv),
      subvGSheet:   subvGSheet,
      subvAnnoncees: Math.round(subvAnnonceesMois),
      aides:        aide,
      produitsExpl: Math.round(rembOpco),
      ebe_mensuel:  Math.round(ebeMensuel),
      ebe_cumule:   Math.round(ebeCumul),
    };
  });
}

async function fetchBaseData(horizonMonths = 12, qontoOptions = {}) {
  const [qontoData, pipelineDeals, notionMissions, crPrevData, customerInvoices, masseSalarialeData, categoriesTvaData] = await Promise.all([
    buildTresorerieFromQonto(horizonMonths, qontoOptions),
    fetchOpenDeals(),
    fetchAllNotionMissions(),
    fetchAndParseCRPrev(),
    fetchCustomerInvoices().catch(err => { console.warn('Pennylane fetch échoué dans fetchBaseData:', err.message); return []; }),
    fetchAndParseMasseSalarialeDetailed().catch(err => { console.warn('Masse_salariale GSheet échoué dans fetchBaseData:', err.message); return null; }),
    fetchAndParseCategoriesTVA().catch(err => { console.warn('Catégories TVA GSheet échoué:', err.message); return { byCategorie: {} }; }),
  ]);
  // Revenus exceptionnels Supabase droppée en migration 24 → source = overrides de scénario uniquement
  // Masse salariale : Phase F → GSheet Masse_salariale (table Supabase `salaries` dépréciée, migration 25)
  // Catégories TVA : Phase E complète → taux TVA par catégorie pour enrichir les overrides
  return {
    qontoData, pipelineDeals, notionMissions, crPrevData, customerInvoices, masseSalarialeData,
    categoriesTva: categoriesTvaData.byCategorie || {},
    revenus: [],
  };
}

function applyOverrides(baseData, overrides) {
  // masseOverrides : structure consommée par masseSalarialeMois (identification par nom d'employé GSheet).
  // Rétrocompat : si un override utilise salarie_id (ancien uuid Supabase), on le traite comme nom
  //               (le frontend doit maintenant fournir le nom comme identifiant, cf. migration Phase F).
  // Phase E complète : chaque élément distribué porte un champ `_tva` { taux, direction, mode, ht, ttc, tva }
  // calculé pour l'unité du montant (mensuel ou one-shot selon le type).
  const categoriesTva = baseData.categoriesTva || {};
  const masseOverrides = { additions: [], modifications: [], removedNames: [], augmentations: [] };
  let revenus = [...baseData.revenus];
  let chargesFixesExtras = [];
  let pipelineFactor = 1;
  let fictionalDeals = [];
  let caEstimatif = null;
  let revenusRecurrentsExtras = [];
  let subventionsAnnoncees = [];
  let gsheetOverrides = [];

  for (const ov of overrides) {
    const d = ov.data;
    switch (ov.type) {
      case 'salaire':
        if (d.action === 'add') {
          masseOverrides.additions.push({
            nom: d.nom || ('Nouveau ' + ov.id),
            poste: d.poste || null,
            type: d.type || 'salarie',
            net_mensuel: d.net_mensuel || 0,
            charges_mensuelles: d.charges_mensuelles || 0,
            date_entree: d.date_entree || new Date().toISOString().split('T')[0],
            date_sortie: d.date_sortie || null,
          });
        } else if (d.action === 'remove') {
          const nom = d.nom || d.salarie_id;
          if (nom) masseOverrides.removedNames.push(nom);
        } else if (d.action === 'modify') {
          const nom = d.nom || d.salarie_id;
          if (nom) masseOverrides.modifications.push({
            nom,
            net_mensuel: d.net_mensuel,
            charges_mensuelles: d.charges_mensuelles,
          });
        }
        break;
      case 'pipeline':
        if (d.mode === 'factor' && d.facteur != null) {
          pipelineFactor = d.facteur;
        } else if (d.mode === 'deal') {
          const montant = d.montant || 0;
          const proba = d.probabilite != null ? d.probabilite : 100;
          const montantPondere = montant * (proba / 100);
          fictionalDeals.push({
            nom: d.nom || 'Deal fictif',
            montant,
            probabilite: proba,
            mois: d.mois,
            delai_encaissement_jours: d.delai_encaissement_jours,
            _tva: getOverrideTvaInfo('pipeline', d, montantPondere, categoriesTva),
          });
        }
        break;
      case 'ca_estimatif': {
        const montant_annuel = d.montant_annuel || 0;
        const nb_mois = d.nb_mois || 12;
        const monthly = nb_mois > 0 ? montant_annuel / nb_mois : 0;
        // _tva calculé sur le montant MENSUEL (base saisie : montant_annuel HT ou TTC selon data.montant_mode)
        caEstimatif = { montant_annuel, nb_mois, _tva: getOverrideTvaInfo('ca_estimatif', d, monthly, categoriesTva) };
        break;
      }
      case 'charges_fixes': {
        const montant = d.mode === 'oneshot' ? (d.montant || 0) : (d.montant_mensuel || 0);
        const tva = getOverrideTvaInfo('charges_fixes', d, montant, categoriesTva);
        if (d.mode === 'oneshot') {
          chargesFixesExtras.push({ libelle: d.libelle, montant_mensuel: montant, mois_debut: d.mois, mois_fin: d.mois, _tva: tva });
        } else {
          chargesFixesExtras.push({ libelle: d.libelle, montant_mensuel: montant, mois_debut: d.mois_debut, mois_fin: d.mois_fin, _tva: tva });
        }
        break;
      }
      case 'revenu_exceptionnel': {
        const montant = d.montant || 0;
        revenus.push({
          id: 'fictional-' + ov.id,
          libelle: d.libelle,
          montant,
          mois: d.mois,
          _tva: getOverrideTvaInfo('revenu_exceptionnel', d, montant, categoriesTva),
        });
        break;
      }
      case 'salaire_augmentation':
        // % d'augmentation cumulative à partir d'une date. targetNames vide/absent → applique à tous.
        // Rétrocompat : accepte salarie_noms (nouveau) ou salarie_ids (ancien = pré Phase F, interprété comme noms).
        masseOverrides.augmentations.push({
          percent: d.percent || 0,
          date_debut: d.date_debut,
          targetNames: d.salarie_noms || d.salarie_ids || [],
        });
        break;
      case 'revenu_recurrent': {
        const montant_mensuel = d.montant_mensuel || 0;
        revenusRecurrentsExtras.push({
          libelle: d.libelle || 'Revenu récurrent',
          montant_mensuel,
          mois_debut: d.mois_debut,
          mois_fin: d.mois_fin,
          _tva: getOverrideTvaInfo('revenu_recurrent', d, montant_mensuel, categoriesTva),
        });
        break;
      }
      case 'pret': {
        // Décompose en : revenu one-shot (entrée) + charge récurrente (mensualité amortissable)
        // TVA = 0 sur les deux (prêts hors TVA).
        const P = d.montant || 0;
        const tx = (d.taux_annuel || 0) / 100;
        const n = d.duree_mois || 12;
        const mensualite = tx > 0 ? P * (tx / 12) / (1 - Math.pow(1 + tx / 12, -n)) : P / n;
        const tvaZero = getOverrideTvaInfo('pret', d, 0, categoriesTva); // forces taux=0 par défaut
        revenus.push({
          id: 'pret-entry-' + ov.id,
          libelle: (d.libelle || 'Prêt') + ' (entrée)',
          montant: P,
          mois: d.mois_entree,
          _tva: tvaZero,
        });
        const [y, m] = (d.mois_entree || '').split('-').map(Number);
        if (y && m) {
          const startD = new Date(y, m - 1 + 1, 1);
          const endD   = new Date(y, m - 1 + n, 1);
          const startKey = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, '0')}`;
          const endKey   = `${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}`;
          chargesFixesExtras.push({
            libelle: (d.libelle || 'Prêt') + ' (remboursement)',
            montant_mensuel: Math.round(mensualite),
            mois_debut: startKey,
            mois_fin: endKey,
            _tva: tvaZero,
          });
        }
        break;
      }
      case 'subvention_annoncee': {
        const montant = d.montant || 0;
        subventionsAnnoncees.push({
          id: 'fictional-' + ov.id,
          libelle: d.libelle || 'Subvention annoncée',
          montant,
          mois: d.mois,
          _tva: getOverrideTvaInfo('subvention_annoncee', d, montant, categoriesTva),
        });
        break;
      }
      case 'ligne_gsheet_override': {
        const montant_mensuel = d.montant_mensuel || 0;
        // Taux TVA déduit de la catégorie CR_Prev si elle matche une entrée Catégories TVA.
        const enrichedData = { ...d, categorie_tva: d.categorie_tva || d.categorie };
        gsheetOverrides.push({
          categorie: d.categorie,
          mois_debut: d.mois_debut,
          mois_fin: d.mois_fin,
          montant_mensuel,
          _tva: getOverrideTvaInfo('ligne_gsheet_override', enrichedData, montant_mensuel, categoriesTva),
        });
        break;
      }
    }
  }

  return { masseOverrides, revenus, chargesFixesExtras, pipelineFactor, fictionalDeals, caEstimatif, revenusRecurrentsExtras, subventionsAnnoncees, gsheetOverrides };
}

app.get('/api/scenarios/baseline/projection', async (req, res) => {
  try {
    const { preset, pastMode, includeGSheet, includePipeline, includeCaNotion, includeSalariesBaseline } = parseProjectionQuery(req);
    // Scenarios : horizon = année civile complète (Jan → preset end) pour coller aux totaux CR_Prev.
    const { startYear, startMonth, horizonMonths } = getScenarioHorizon(preset);
    const base = await fetchBaseData(horizonMonths, { startYear, startMonth });
    const result = await buildPrevisionnel({
      qontoData: base.qontoData, pipelineDeals: base.pipelineDeals,
      notionMissions: base.notionMissions,
      masseSalarialeData: base.masseSalarialeData, masseOverrides: {},
      revenus: base.revenus, chargesFixesExtras: [], pipelineFactor: 1, fictionalDeals: [],
      crPrevData: base.crPrevData, caEstimatif: null,
      customerInvoices: base.customerInvoices,
      caSource: 'crprev', pastMode,
      includeGSheet, includePipeline, includeCaNotion, includeSalariesBaseline,
    });
    const enriched = await enrichWithPnlEbe(result.previsionnel, { includeGSheet });
    res.json({
      nom: 'Baseline', horizon: preset, pastMode,
      include: { gsheet: includeGSheet, pipeline: includePipeline, caNotion: includeCaNotion, salariesBaseline: includeSalariesBaseline },
      previsionnel: enriched,
    });
  } catch (err) {
    console.error('Erreur baseline projection:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Catégories mères du GSheet CR_Prev avec leurs valeurs par mois (pour le levier ligne_gsheet_override).
// Le frontend s'en sert pour afficher le montant courant moyen sur la période sélectionnée
// et calculer en live la nouvelle valeur si l'utilisateur opte pour un override en %.
app.get('/api/cr-prev/categories', async (req, res) => {
  try {
    const data = await fetchAndParseCRPrev();
    const categories = Object.entries(data.categories || {})
      .map(([name, valuesByMonth]) => ({ name, valuesByMonth }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catégories TVA depuis GSheet Catégories (GID 771195553).
// Utilisé par les formulaires overrides pour dropdown "Catégorie" → taux TVA auto-sélectionné.
app.get('/api/categories-tva', async (req, res) => {
  try {
    const data = await fetchAndParseCategoriesTVA();
    const list = Object.entries(data.byCategorie || {})
      .map(([nom, taux]) => ({ nom, taux, tauxLabel: (taux * 100).toFixed(taux % 0.01 ? 1 : 0) + '%' }))
      .sort((a, b) => a.nom.localeCompare(b.nom));
    res.json({ categories: list, nbDetected: data.nbDetected });
  } catch (err) {
    console.error('Erreur categories-tva:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scenarios/baseline/salaries', async (req, res) => {
  try {
    // Phase F : source = GSheet (onglets "Salaires" pour la metadata + "Masse_salariale" pour les coûts).
    // Rétrocompat frontend : id === nom (les overrides historiques référencent id, désormais traité comme nom).
    const [meta, masseData] = await Promise.all([
      fetchAndParseSalariesMeta().catch(() => []),
      fetchAndParseMasseSalarialeDetailed().catch(() => null),
    ]);
    // Coût mensuel moyen par employé : moyenne des 3 derniers mois connus > 0 dans Masse_salariale.
    const coutByNom = {};
    if (masseData && masseData.byMonth) {
      const recent = Object.keys(masseData.byMonth).sort().slice(-3);
      const seen = {};
      for (const mKey of recent) {
        for (const emp of (masseData.byMonth[mKey].detail || [])) {
          if (!seen[emp.nom]) seen[emp.nom] = { total: 0, count: 0, lastNet: 0, lastCharges: 0 };
          seen[emp.nom].total += emp.cout;
          seen[emp.nom].count += 1;
          seen[emp.nom].lastNet = emp.net;
          seen[emp.nom].lastCharges = emp.charges;
        }
      }
      for (const nom of Object.keys(seen)) {
        const s = seen[nom];
        coutByNom[nom] = { avg: Math.round(s.total / s.count), net: s.lastNet, charges: s.lastCharges };
      }
    }
    const out = meta.map(m => {
      const cout = coutByNom[m.nom] || { avg: 0, net: 0, charges: 0 };
      return {
        id: m.nom, // rétrocompat : les overrides historiques utilisent id, maintenant === nom
        nom: m.nom,
        poste: null,
        type: m.type || (m.isDirigeant ? 'dirigeant' : 'salarie'),
        date_entree: m.date_debut,
        date_sortie: m.date_fin,
        net_mensuel: cout.net,
        charges_mensuelles: cout.charges,
        cout_moyen_mensuel: cout.avg,
        isDirigeant: !!m.isDirigeant,
      };
    });
    res.json(out);
  } catch (err) {
    console.error('Erreur baseline salaries:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scenarios/:id/projection', async (req, res) => {
  try {
    // Vérifier que l'id n'est pas "baseline"
    if (req.params.id === 'baseline') {
      const qs = req.url.split('?')[1] || '';
      return res.redirect('/api/scenarios/baseline/projection' + (qs ? '?' + qs : ''));
    }

    const { data: scenario, error } = await supabase.from('scenarios').select('*').eq('id', req.params.id).single();
    if (error || !scenario) return res.status(404).json({ error: 'Scenario non trouve' });

    const { data: overrides } = await supabase.from('scenario_overrides').select('*').eq('scenario_id', req.params.id).order('created_at');

    // Composition : chaque scénario porte ses 4 flags d'inclusion. Horizon + pastMode viennent du query string.
    const { preset, pastMode } = parseProjectionQuery(req);
    const { startYear, startMonth, horizonMonths } = getScenarioHorizon(preset);
    const includeGSheet           = scenario.include_gsheet !== false;
    const includePipeline         = scenario.include_pipeline !== false;
    const includeCaNotion         = scenario.include_ca_notion !== false;
    const includeSalariesBaseline = scenario.include_salaries_baseline !== false;

    const base = await fetchBaseData(horizonMonths, { startYear, startMonth });
    const applied = applyOverrides(base, overrides || []);

    const result = await buildPrevisionnel({
      qontoData: base.qontoData, pipelineDeals: base.pipelineDeals,
      notionMissions: base.notionMissions,
      masseSalarialeData: base.masseSalarialeData, masseOverrides: applied.masseOverrides,
      revenus: applied.revenus,
      chargesFixesExtras: applied.chargesFixesExtras,
      pipelineFactor: applied.pipelineFactor,
      fictionalDeals: applied.fictionalDeals,
      crPrevData: base.crPrevData, caEstimatif: applied.caEstimatif,
      customerInvoices: base.customerInvoices,
      caSource: 'crprev', pastMode,
      includeGSheet, includePipeline, includeCaNotion, includeSalariesBaseline,
      revenusRecurrentsExtras: applied.revenusRecurrentsExtras,
      subventionsAnnoncees: applied.subventionsAnnoncees,
      gsheetOverrides: applied.gsheetOverrides,
    });
    const enriched = await enrichWithPnlEbe(result.previsionnel, { includeGSheet });
    res.json({
      nom: scenario.nom, horizon: preset, pastMode,
      include: { gsheet: includeGSheet, pipeline: includePipeline, caNotion: includeCaNotion, salariesBaseline: includeSalariesBaseline },
      previsionnel: enriched,
    });
  } catch (err) {
    console.error('Erreur scenario projection:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// --- Qonto API integration ---
const QONTO_ORG_ID = process.env.QONTO_ORG_ID;
const QONTO_API_KEY = process.env.QONTO_API_KEY;
const QONTO_HOST = 'thirdparty.qonto.com';

// Cache par endpoint (URL complète comme clé). La Promise elle-même est cachée pour
// que les requêtes concurrentes partagent le même appel HTTP. En cas d'échec, l'entrée
// est purgée pour permettre une nouvelle tentative immédiate.
// NB : les URLs Qonto qui embarquent `new Date().toISOString()` (ex. fetchQontoTransactions)
// auront une clé différente à chaque ms et ne bénéficieront pas du cache — c'est accepté
// car ces appels sont déjà chapeautés par le cache endpoint de /api/tresorerie.
const qontoCache = new Map();
const QONTO_CACHE_TTL = 5 * 60 * 1000;

function qontoRequest(endpoint) {
  const cached = qontoCache.get(endpoint);
  if (cached && (Date.now() - cached.time) < QONTO_CACHE_TTL) {
    return cached.promise;
  }
  const promise = new Promise((resolve, reject) => {
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
  qontoCache.set(endpoint, { promise, time: Date.now() });
  promise.catch(() => {
    const cur = qontoCache.get(endpoint);
    if (cur && cur.promise === promise) qontoCache.delete(endpoint);
  });
  return promise;
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
    // Clip à aujourd'hui pour éviter de sous-estimer la moyenne quand la période s'étend dans le futur
    // (ex. "Exercice courant" envoie end=YYYY-12-31, mais Qonto n'a que des charges jusqu'à aujourd'hui)
    const clippedEndD = endD > new Date() ? new Date() : endD;
    const nbMois = Math.max(1, Math.round((clippedEndD - startD) / (1000 * 60 * 60 * 24 * 30.5)));
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

    // Le mois en cours est traité comme prévisionnel : les charges de fin de mois (salaires, etc.)
    // ne sont pas encore passées sur Qonto, donc inclure le mois en cours en réel sous-estime le total.
    // → Réel = jusqu'au mois précédent (inclus), Prévisionnel = à partir du mois en cours.
    // En janvier, realEndKey pointe sur décembre de l'année précédente : hasReal devient false et tout passe en GSheet, ce qui est correct (aucun mois clôturé dans l'exercice courant).
    const prevMonth    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthKey = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;

    const realEndKey   = endKey <= prevMonthKey ? endKey : prevMonthKey;
    const hasReal      = start <= realEndKey;
    const prevStartKey = start > todayKey ? start : todayKey;
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
// EBE — Compose CA Facturé, Charges projetées, Financements, Pipeline pour une année
// ============================================================

let planTresoCache = null;
let planTresoCacheTime = 0;
const PLAN_TRESO_CACHE_TTL = 10 * 60 * 1000;

async function fetchAndParsePlanTresorerie() {
  if (planTresoCache && (Date.now() - planTresoCacheTime) < PLAN_TRESO_CACHE_TTL) {
    return planTresoCache;
  }
  const csv = await fetchGoogleSheetCSV(GID_PLAN_TRESORERIE);
  const data = parsePlanTresorerie(csv);
  planTresoCache = data;
  planTresoCacheTime = Date.now();
  return data;
}

async function fetchFinancementsForYear(year) {
  const planData = await fetchAndParsePlanTresorerie();
  if (!planData.financements) return { subventions: [], aides: [] };

  const result = { subventions: [], aides: [] };
  for (const fin of planData.financements) {
    let total = 0;
    planData.months.forEach((m, i) => {
      if (m.year === year) total += fin.values[i] || 0;
    });
    if (total === 0) continue;
    const bucket = fin.category === 'subvention' ? result.subventions
                 : fin.category === 'aide'       ? result.aides
                 : null;
    if (bucket) bucket.push({ label: fin.name, montant: Math.round(total) });
  }
  return result;
}

async function computePipelinePondere() {
  const pipelineDeals = await fetchOpenDeals();
  let total = 0;
  for (const stage of KANBAN_STAGES) {
    const deals = pipelineDeals[stage.label] || [];
    for (const deal of deals) {
      total += deal.amount * (deal.probability / 100);
    }
  }
  return Math.round(total);
}

app.get('/api/ebe', async (req, res) => {
  try {
    const yearParam = parseInt(req.query.year, 10);
    if (!yearParam) return res.status(400).json({ error: 'Paramètre year requis' });

    const start = `${yearParam}-01-01`;
    const end   = `${yearParam}-12-31`;
    const currentYear = new Date().getFullYear();
    const isCurrentYear = yearParam === currentYear;

    // 1) CA Facturé sur l'année (Acompte + Solde des missions Notion dans la plage)
    const missions = await fetchAllNotionMissions();
    const startDate = new Date(start);
    const endDate = new Date(end); endDate.setHours(23, 59, 59, 999);
    let caFacture = 0;
    for (const m of missions) {
      if (m.dateFactureAcompte && m.montantAcompte > 0) {
        const d = new Date(m.dateFactureAcompte);
        if (d >= startDate && d <= endDate) caFacture += m.montantAcompte;
      }
      if (m.dateFactureFinale) {
        const montantSolde = m.ca - m.montantAcompte;
        if (montantSolde > 0) {
          const d = new Date(m.dateFactureFinale);
          if (d >= startDate && d <= endDate) caFacture += montantSolde;
        }
      }
    }
    caFacture = Math.round(caFacture);

    // 2) Charges projetées sur l'année — réutilise la logique /api/charges-hybride via fetch interne
    const chargesRes = await fetch(`http://localhost:${PORT}/api/charges-hybride?start=${start}&end=${end}`);
    const chargesData = await chargesRes.json();
    const totalCharges = Math.round(chargesData.totalCharges || 0);

    // 3) Financements (Subv + Aide) de l'année depuis GSheet Plan_TRE_Prév
    const financements = await fetchFinancementsForYear(yearParam);
    const totalSubv = financements.subventions.reduce((s, f) => s + f.montant, 0);
    const totalAide = financements.aides.reduce((s, f) => s + f.montant, 0);

    // 4) Pipeline pondéré — seulement pour l'année en cours (les années passées n'ont plus de pipeline)
    const pipelinePondere = isCurrentYear ? await computePipelinePondere() : 0;

    // 5) EBE factuel (CA Facturé) et projeté (CA Facturé + Pipeline pondéré)
    const ebeFactuel = caFacture - totalCharges + totalSubv + totalAide;
    const caProjete  = caFacture + pipelinePondere;
    const ebeProjete = caProjete - totalCharges + totalSubv + totalAide;

    res.json({
      year: yearParam,
      ca: { facture: caFacture, pipelinePondere, projete: caProjete },
      charges: { total: totalCharges },
      financements: {
        subventions: financements.subventions,
        aides: financements.aides,
        totalSubv,
        totalAide,
      },
      ebe: { factuel: Math.round(ebeFactuel), projete: Math.round(ebeProjete) },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur /api/ebe:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ACCOUNT CONTEXT MIDDLEWARE
// ============================================================
// Middleware to validate account_id from header or query param
const accountContext = async (req, res, next) => {
  // Priorité 1: JWT Bearer Token (Supabase Auth ou custom PIN JWT)
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');

    try {
      // Essayer d'abord Supabase Auth (Magic Link)
      let user = null;
      const { data: { user: supabaseUser }, error: supabaseError } = await supabaseAdmin.auth.getUser(token);

      if (!supabaseError && supabaseUser) {
        user = supabaseUser;
      } else {
        // Essayer notre JWT custom (PIN auth)
        try {
          const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
          // Trouver le compte par ID (custom JWT a la revendication account_id)
          const { data: userAccount, error: acctError } = await supabaseAdmin
            .from('accounts')
            .select('id, name, slug, email, is_admin')
            .eq('id', decoded.account_id)
            .single();

          if (acctError || !userAccount) {
            return res.status(401).json({ error: 'Token invalide ou compte non trouvé' });
          }

          req.accountId = userAccount.id;
          req.account = userAccount;
          let targetAccountId = userAccount.id;

          // Mode admin switching
          const switchAccountId = req.headers['x-switch-account'];
          if (userAccount.is_admin && switchAccountId) {
            const { data: targetAccount, error: switchError } = await supabaseAdmin
              .from('accounts')
              .select('id, name, slug, email, is_admin')
              .eq('id', switchAccountId)
              .single();

            if (!switchError && targetAccount) {
              targetAccountId = targetAccount.id;
              req.accountId = targetAccount.id;
              req.account = targetAccount;
              req.adminAccount = userAccount;
            }
          } else if (!userAccount.is_admin && switchAccountId) {
            // Non-admin trying to switch accounts
            return res.status(403).json({ error: 'Accès refusé: seuls les admins peuvent switcher de compte' });
          }

          return next();
        } catch (jwtErr) {
          // Aucun token valide trouvé
          return res.status(401).json({ error: 'Token invalide ou expiré' });
        }
      }

      // Si on a un token Supabase Auth valide, continuer
      if (user) {
        const { data: userAccount, error: acctError } = await supabaseAdmin
          .from('accounts')
          .select('id, name, slug, email, is_admin')
          .eq('email', user.email)
          .single();

        if (acctError || !userAccount) {
          return res.status(403).json({ error: 'Aucun compte Releaf associé à cet email' });
        }

        // Mode admin: peut switcher vers un autre compte via X-Switch-Account
        const switchAccountId = req.headers['x-switch-account'];
        if (userAccount.is_admin && switchAccountId) {
          const { data: targetAccount, error: switchError } = await supabaseAdmin
            .from('accounts')
            .select('id, name, slug, email, is_admin')
            .eq('id', switchAccountId)
            .single();

          if (switchError || !targetAccount) {
            return res.status(404).json({ error: 'Compte cible introuvable' });
          }

          req.accountId = targetAccount.id;
          req.account = targetAccount;
          req.adminAccount = userAccount;
          return next();
        } else if (!userAccount.is_admin && switchAccountId) {
          // Non-admin trying to switch accounts
          return res.status(403).json({ error: 'Accès refusé: seuls les admins peuvent switcher de compte' });
        }

        req.accountId = userAccount.id;
        req.account = userAccount;
        return next();
      }
    } catch (err) {
      console.error('Erreur vérification token:', err.message);
      return res.status(401).json({ error: 'Erreur de vérification du token' });
    }
  }

  // No valid auth found — reject
  return res.status(401).json({ error: 'Non authentifié. Bearer token requis.' });
};

// ============================================================
// ACCOUNTS — Routes (public, no auth required)
// ============================================================
// GET /api/accounts/me — Return the authenticated user's account
// Requires Bearer token (Supabase Auth)
// POST /api/accounts/login-pin — Login with email + PIN
app.post('/api/accounts/login-pin', async (req, res) => {
  try {
    const { email, pin } = req.body;
    if (!email || !pin) {
      return res.status(400).json({ error: 'Email et PIN requis' });
    }

    // Find account by email and verify PIN
    const { data: account, error } = await supabaseAdmin
      .from('accounts')
      .select('id, name, email, is_admin, pin')
      .eq('email', email)
      .single();

    if (error || !account) {
      return res.status(401).json({ error: 'Email non trouvé' });
    }

    if (account.pin !== pin) {
      return res.status(401).json({ error: 'PIN incorrect' });
    }

    // Generate JWT token
    const token = generateSupabaseJWT(account.id);
    if (!token) {
      return res.status(500).json({ error: 'Impossible de générer le token' });
    }

    res.json({
      token,
      account_id: account.id,
      account_name: account.name,
      is_admin: account.is_admin,
      expires_in: 86400 // 24h in seconds
    });
  } catch (err) {
    console.error('Erreur POST /api/accounts/login-pin:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts/me', accountContext, (req, res) => {
  res.json({ account: req.account });
});

// GET /api/accounts — List all accounts (admin only)
// Used for the admin account switcher
app.get('/api/accounts', accountContext, async (req, res) => {
  // Check if user is admin (req.adminAccount exists when admin has switched accounts)
  const isAdmin = req.account?.is_admin || req.adminAccount?.is_admin;
  if (!isAdmin) {
    return res.status(403).json({ error: 'Accès réservé à l\'admin' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('accounts')
      .select('id, name, slug, email, is_admin')
      .order('name');
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) {
    console.error('Erreur GET /api/accounts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:slug — Get a specific account by slug (PUBLIC)
app.get('/api/accounts/:slug', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('accounts')
      .select('*')
      .eq('slug', req.params.slug)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Compte non trouvé' });
    res.json(data);
  } catch (err) {
    console.error('Erreur GET /api/accounts/:slug:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts/:id/jwt — Generate a JWT token for RLS policies
// PROTECTED: requires valid auth. Only own account or admin can generate.
app.get('/api/accounts/:id/jwt', accountContext, async (req, res) => {
  try {
    const targetAccountId = req.params.id;
    if (!targetAccountId) return res.status(400).json({ error: 'Account ID required' });

    // Security: only allow JWT generation for own account, or if admin
    const callerIsOwner = req.accountId === targetAccountId;
    const callerIsAdmin = req.account?.is_admin || req.adminAccount?.is_admin;
    if (!callerIsOwner && !callerIsAdmin) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Verify target account exists
    const { data: account, error: accountErr } = await supabaseAdmin
      .from('accounts')
      .select('id, name')
      .eq('id', targetAccountId)
      .single();

    if (accountErr || !account) {
      return res.status(404).json({ error: 'Compte non trouvé' });
    }

    // Generate JWT token with target account_id claim
    const token = generateSupabaseJWT(targetAccountId);
    if (!token) {
      return res.status(500).json({ error: 'Could not generate token' });
    }

    res.json({
      token,
      account_id: targetAccountId,
      account_name: account.name,
      expires_in: 86400
    });
  } catch (err) {
    console.error('Erreur GET /api/accounts/:id/jwt:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// TASK LOCKS — Routes
// ============================================================
app.get('/api/task-locks', async (req, res) => {
  try {
    // Clean up expired locks
    await supabase.from('task_locks').delete().lt('expires_at', new Date().toISOString());

    const { data, error } = await supabase
      .from('task_locks')
      .select(`*, accounts(name)`);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur GET /api/task-locks:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PROSPECTOR — Routes
// ============================================================

// ============================================================
// FRONTEND ROUTING
// ============================================================

// Serve prospector.html with injected Supabase env vars (for Dispatch & Dispatch tasks)
// GET /prospector — Serve Prospector vanilla JS dashboard (with PIN auth support)
// Route: /prospector-login — Serve React login page
app.get('/prospector-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Routes React SPA — servies via le build Vite (dist/index.html)
// React Router gère le routing côté client pour /campaigns/*
app.get('/campaigns/new', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
app.get('/campaigns/edit/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Route: /prospector — Serve dashboard
app.get('/prospector', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'public', 'prospector.html'), 'utf8');
  // Inject Supabase credentials for vanilla JS
  html = html.replace('__SUPABASE_URL__', process.env.SUPABASE_URL || '');
  html = html.replace('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
  // Cache-bust JS files to force browser reload on server restart
  const v = Date.now();
  html = html.replace('/js/prospector-ui.js', `/js/prospector-ui.js?v=${v}`);
  html = html.replace('/js/prospector-db.js', `/js/prospector-db.js?v=${v}`);
  html = html.replace('/js/prospector.js', `/js/prospector.js?v=${v}`);
  res.send(html);
});

// GET /api/prospector/campaigns — List campaigns sorted by priority
app.get('/api/prospector/campaigns', accountContext, async (req, res) => {
  try {
    let q = supabaseAdmin.from('campaigns').select('*').eq('account_id', req.accountId).order('priority', { ascending: true, nullsFirst: false });

    if (req.query.status) {
      q = q.eq('status', req.query.status);
    } else if (req.query.active === 'true') {
      q = q.in('status', ['À lancer', 'En cours', 'En suivi', 'Terminée']);
    }

    const { data: campaigns, error } = await q;
    if (error) throw error;

    // Attach prospect counts + status breakdown in one query
    const campIds = campaigns.map(c => c.id);
    let statusMap = {};
    if (campIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from('prospects')
        .select('campaign_id, status')
        .eq('account_id', req.accountId)
        .in('campaign_id', campIds);
      for (const r of (rows || [])) {
        if (!statusMap[r.campaign_id]) statusMap[r.campaign_id] = {};
        statusMap[r.campaign_id][r.status] = (statusMap[r.campaign_id][r.status] || 0) + 1;
      }
    }

    const result = campaigns.map(c => {
      const sc = statusMap[c.id] || {};
      const total = Object.values(sc).reduce((a, v) => a + v, 0);
      return { ...c, prospects_count: total, status_counts: sc };
    });

    res.json(result);
  } catch (err) {
    console.error('Erreur GET /api/prospector/campaigns:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/campaigns/:id — Single campaign by ID (with account_id check)
app.get('/api/prospector/campaigns/:id', accountContext, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('account_id', req.accountId)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Campaign not found' });
    res.json(data);
  } catch (err) {
    console.error('Erreur GET /api/prospector/campaigns/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/reference/sectors — 136 secteurs LinkedIn (données partagées)
app.get('/api/prospector/reference/sectors', accountContext, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('linkedin_sectors')
      .select('id, label_fr, parent_category, verified')
      .order('label_fr');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur GET /api/prospector/reference/sectors:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/reference/geos — Zones géographiques LinkedIn
app.get('/api/prospector/reference/geos', accountContext, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('linkedin_geos')
      .select('id, label_fr, geo_type, parent_id')
      .order('label_fr');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur GET /api/prospector/reference/geos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/prospects — List prospects (optionally filtered by campaign_id)
app.get('/api/prospector/prospects', accountContext, async (req, res) => {
  try {
    let q = supabaseAdmin
      .from('prospects')
      .select(`
        id, first_name, last_name, linkedin_url, company, job_title, email, phone,
        sector, geography, pending_message, message_versions, created_at, updated_at,
        status, campaign_id, notes, last_contacted_at, added_at,
        campaigns(id, name)
      `)
      .eq('account_id', req.accountId)
      .order('added_at', { ascending: false });

    if (req.query.campaign_id) q = q.eq('campaign_id', req.query.campaign_id);
    if (req.query.status) q = q.eq('status', req.query.status);
    // Exclude scrapping_pending from frontend unless explicitly requested
    if (!req.query.include_pending) q = q.neq('status', 'scrapping_pending');

    const { data, error } = await q;
    if (error) throw error;

    const result = (data || []).map(p => ({
      ...p,
      campaign_name: p.campaigns?.name || null,
    }));
    // Remove nested campaigns object from response
    result.forEach(r => delete r.campaigns);

    res.json(result);
  } catch (err) {
    console.error('Erreur GET /api/prospector/prospects:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: shift priorities to make room for a given priority
async function shiftPriorities(targetPrio, excludeId, accountId) {
  // Get all campaigns with priority >= targetPrio, sorted ascending, for this account
  let q = supabaseAdmin.from('campaigns').select('id, priority')
    .eq('account_id', accountId)
    .gte('priority', targetPrio).order('priority', { ascending: true });
  if (excludeId) q = q.neq('id', excludeId);
  const { data: toShift } = await q;
  if (!toShift?.length) return;

  // Shift each one by +1, starting from the highest to avoid unique constraint conflicts
  for (let i = toShift.length - 1; i >= 0; i--) {
    const c = toShift[i];
    // Only shift if it's actually blocking (contiguous)
    if (i === 0 || toShift[i].priority === toShift[i - 1]?.priority + 1 || toShift[i].priority === targetPrio) {
      await supabaseAdmin.from('campaigns').update({ priority: c.priority + 1 }).eq('id', c.id);
    }
  }
}

// POST /api/prospector/campaigns — Create campaign with priority auto-shift
app.post('/api/prospector/campaigns', accountContext, async (req, res) => {
  try {
    const { name, priority, criteria, daily_quota, sector, geography, details, objectives, message_template, target_count } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const prio = priority != null ? parseInt(priority) : null;
    if (prio != null && (prio < 1 || prio > 5)) return res.status(400).json({ error: 'priority must be between 1 and 5' });

    if (target_count != null && (!Number.isInteger(Number(target_count)) || Number(target_count) < 1)) {
      return res.status(400).json({ error: 'target_count must be a positive integer' });
    }

    // Validation criteria : au moins un filtre non-vide
    const c = criteria || {};
    const hasCriteria = (c.jobTitles?.length || c.seniorities?.length || c.geoIds?.length || c.sectorIds?.length || c.headcounts?.length);
    if (criteria && !hasCriteria) return res.status(400).json({ error: 'criteria must contain at least one non-empty filter (keywords alone are not sufficient)' });

    if (c.keywords && c.keywords.length > 5) return res.status(400).json({ error: 'criteria.keywords maximum 5 entries' });

    // Auto-shift existing priorities if conflict
    if (prio != null) {
      const { data: existing } = await supabaseAdmin.from('campaigns').select('id').eq('priority', prio).eq('account_id', req.accountId);
      if (existing?.length) await shiftPriorities(prio, null, req.accountId);
    }

    // Générer l'URL Sales Navigator si criteria fourni
    const salesNavUrl = hasCriteria ? buildSalesNavUrl(c) : null;

    const row = {
      name,
      status: 'À lancer', // Toujours forcé côté serveur
      priority: prio,
      criteria: c,
      daily_quota: daily_quota != null ? parseInt(daily_quota) : 20,
      sector: sector || null,
      geography: geography || null,
      details: details || null,
      objectives: objectives || [],
      message_template: message_template || null,
      target_count: target_count != null ? parseInt(target_count) : null,
      sales_nav_url: salesNavUrl,
      account_id: req.accountId,
    };

    const { data, error } = await supabaseAdmin.from('campaigns').insert(row).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Erreur POST /api/prospector/campaigns:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prospector/campaigns/:id — Update campaign with priority auto-shift
app.put('/api/prospector/campaigns/:id', accountContext, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    const allowed = ['name', 'status', 'priority', 'criteria', 'daily_quota', 'sector', 'geography', 'details', 'objectives', 'message_template', 'target_count'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }

    // Validations
    if (updates.priority != null) {
      updates.priority = parseInt(updates.priority);
      if (updates.priority < 1 || updates.priority > 5) return res.status(400).json({ error: 'priority must be between 1 and 5' });
      const { data: existing } = await supabaseAdmin.from('campaigns').select('id').eq('priority', updates.priority).eq('account_id', req.accountId).neq('id', id);
      if (existing?.length) await shiftPriorities(updates.priority, id, req.accountId);
    }
    if (updates.daily_quota != null) updates.daily_quota = parseInt(updates.daily_quota);

    if (updates.target_count != null && (!Number.isInteger(Number(updates.target_count)) || Number(updates.target_count) < 1)) {
      return res.status(400).json({ error: 'target_count must be a positive integer' });
    }
    if (updates.target_count != null) updates.target_count = parseInt(updates.target_count);

    if (updates.criteria) {
      const c = updates.criteria;
      if (c.keywords && c.keywords.length > 5) return res.status(400).json({ error: 'criteria.keywords maximum 5 entries' });
      // Régénérer sales_nav_url quand criteria change
      const hasCriteria = (c.jobTitles?.length || c.seniorities?.length || c.geoIds?.length || c.sectorIds?.length || c.headcounts?.length);
      updates.sales_nav_url = hasCriteria ? buildSalesNavUrl(c) : null;
    }

    // Detect transition to "En cours" to trigger automatic enrollment
    let previousStatus = null;
    if (updates.status === 'En cours') {
      const { data: current } = await supabaseAdmin.from('campaigns').select('status').eq('id', id).eq('account_id', req.accountId).single();
      previousStatus = current?.status;

      // Guard rail: max 2 campaigns "En cours" simultaneously
      if (previousStatus !== 'En cours') {
        const { count: enCoursCount } = await supabaseAdmin.from('campaigns')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', req.accountId)
          .eq('status', 'En cours')
          .neq('id', id);
        if ((enCoursCount || 0) >= MAX_ACTIVE_CAMPAIGNS) {
          return res.status(400).json({
            error: `Maximum ${MAX_ACTIVE_CAMPAIGNS} campagnes "En cours" simultanément. Terminez ou archivez une campagne existante.`,
            active_campaigns: enCoursCount,
            limit: MAX_ACTIVE_CAMPAIGNS,
          });
        }
      }
    }

    const { data, error } = await supabaseAdmin.from('campaigns').update(updates).eq('id', id).eq('account_id', req.accountId).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Cette priorité est déjà utilisée.' });
      throw error;
    }

    // Auto-enroll when campaign transitions to "En cours"
    if (updates.status === 'En cours' && previousStatus === 'À lancer') {
      const enrollResult = await enrollCampaignProspects(id, req.accountId);
      if (enrollResult) {
        console.log(`[Auto-enroll] Campaign ${id}: ${enrollResult.enrolled} enrolled, ${enrollResult.skipped_excluded} excluded, ${enrollResult.skipped_already} already enrolled`);
        return res.json({ ...data, auto_enroll: enrollResult });
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Erreur PUT /api/prospector/campaigns/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/import-emelia — Import depuis fichier CSV Emelia
// dry_run=true : analyse uniquement, aucune insertion en DB
app.post('/api/prospector/import-emelia', accountContext, upload.single('file'), async (req, res) => {
  try {
    const campaign_id = req.body.campaign_id;
    const isDryRun = req.body.dry_run === 'true' || req.body.dry_run === true;

    if (!campaign_id) return res.status(400).json({ error: 'campaign_id requis' });
    if (!req.file) return res.status(400).json({ error: 'Fichier requis' });

    const { data: campCheck } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('id', campaign_id)
      .eq('account_id', req.accountId)
      .single();
    if (!campCheck) return res.status(404).json({ error: 'Campagne introuvable' });

    const csvText = req.file.buffer.toString('utf-8');
    const rows = parseCsv(csvText, {
      delimiter: ';',
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const [{ data: existing, error: existingErr }, { data: allCamps }] = await Promise.all([
      supabaseAdmin.from('prospects')
        .select('linkedin_url, first_name, last_name, company, status, campaign_id')
        .eq('account_id', req.accountId),
      supabaseAdmin.from('campaigns')
        .select('id, name')
        .eq('account_id', req.accountId),
    ]);
    if (existingErr) throw existingErr;

    const campNameById = new Map((allCamps || []).map(c => [c.id, c.name]));
    const enrichedExisting = (existing || []).map(p => ({
      ...p,
      campaign_name: p.campaign_id ? (campNameById.get(p.campaign_id) || null) : null,
    }));

    const { accepted, rejections } = cleanEmeliaRows(rows, enrichedExisting);

    if (isDryRun) {
      return res.json({
        imported: accepted.length,
        rejected: rejections.length,
        rejections,
        campaign_name: campNameById.get(campaign_id) || null,
      });
    }

    let insertedCount = 0;
    if (accepted.length > 0) {
      const toInsert = accepted.map(p => ({
        ...p,
        account_id: req.accountId,
        campaign_id,
        status: 'Profil à valider',
      }));
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('prospects')
        .insert(toInsert)
        .select('id');
      if (insertErr) throw insertErr;
      insertedCount = inserted?.length ?? 0;
    }

    // Always log the import attempt
    await supabaseAdmin.from('imports').insert({
      account_id: req.accountId,
      campaign_id,
      filename: req.file.originalname,
      total_rows: rows.length,
      imported: insertedCount,
      duplicates: rejections.filter(r => r.reason.includes('Doublon')).length,
      errors: rejections.filter(r => !r.reason.includes('Doublon')).length,
    });

    res.json({ imported: insertedCount, rejected: rejections.length, rejections });
  } catch (err) {
    console.error('Erreur /api/prospector/import-emelia:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PROSPECTOR — Claude Dispatch endpoints
// ============================================================

const VALID_PROSPECT_STATUSES = [
  'scrapping_pending','Profil incomplet','Profil à valider','Nouveau','Profil restreint',
  'Invitation envoyée','Invitation acceptée',
  'Message à valider','Message à envoyer','Message envoyé',
  'Discussion en cours','Gagné','Perdu','Non pertinent'
];

// Statuses that count toward MAX_PROFILES_PER_CAMPAIGN quota
// Excludes: 'Non pertinent', 'Perdu' (dead-end profiles don't block new scraping)
const ACTIVE_PROSPECT_STATUSES = [
  'scrapping_pending', 'Profil incomplet', 'Profil à valider', 'Nouveau', 'Profil restreint',
  'Invitation envoyée', 'Invitation acceptée',
  'Message à valider', 'Message à envoyer', 'Message envoyé',
  'Discussion en cours', 'Gagné',
];

const MAX_ACTIVE_CAMPAIGNS = 2;

// --- Event logging (prospect_events) ---
const EVENT_MAP = {
  'Invitation envoyée': 'invitation_sent',
  'Invitation acceptée': 'invitation_accepted',
  'Message envoyé': 'message_sent',
  'Discussion en cours': 'response_received',
  'Gagné': 'deal_won',
};

async function logEvent(type, prospectId, campaignId, accountId) {
  try {
    await supabaseAdmin.from('prospect_events').insert({
      type,
      prospect_id: prospectId || null,
      campaign_id: campaignId || null,
      account_id: accountId || null,
    });
  } catch (e) {
    console.error('logEvent error:', e.message);
  }
}

// --- Daily quotas ---
const DAILY_INVITATION_LIMIT = parseInt(process.env.PROSPECTOR_INVITATION_LIMIT) || 23;
const DAILY_MESSAGE_LIMIT = parseInt(process.env.PROSPECTOR_MESSAGE_LIMIT) || 23;

function todayParis() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // "YYYY-MM-DD"
}

async function countTodayInvitations(accountId) {
  const today = todayParis();
  const { count } = await supabaseAdmin.from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'Ajout LinkedIn')
    .eq('date', today)
    .eq('account_id', accountId);
  return count || 0;
}

async function countTodayMessages(accountId) {
  const today = todayParis();
  const { count } = await supabaseAdmin.from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'Message envoyé')
    .eq('date', today)
    .eq('account_id', accountId);
  return count || 0;
}

// GET /api/prospector/daily-stats
app.get('/api/prospector/daily-stats', accountContext, async (req, res) => {
  try {
    const invSent = await countTodayInvitations(req.accountId);
    const msgSent = await countTodayMessages(req.accountId);
    res.json({
      date: todayParis(),
      account_id: req.accountId,
      account_name: req.account.name,
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

// POST /api/prospector/update-status — Update a prospect's status (by linkedin_url or id)
app.post('/api/prospector/update-status', accountContext, async (req, res) => {
  try {
    const { linkedin_url, id, prospect_id, status, pending_message, message_versions, step_order } = req.body;
    if (!status || !VALID_PROSPECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Valid: ' + VALID_PROSPECT_STATUSES.join(', ') });
    }

    let prospectId = id || prospect_id;
    if (!prospectId && linkedin_url) {
      const normalizedUrl = normalizeLinkedinUrl(linkedin_url);
      const { data } = await supabaseAdmin.from('prospects').select('id').eq('linkedin_url', normalizedUrl).limit(1);
      if (!data?.length) return res.status(404).json({ error: 'Prospect not found' });
      prospectId = data[0].id;
    }
    if (!prospectId) return res.status(400).json({ error: 'id or linkedin_url required' });

    // Fetch previous status + campaign_id + pending_message (this account only)
    const { data: prev } = await supabaseAdmin
      .from('prospects')
      .select('status, campaign_id, pending_message')
      .eq('id', prospectId)
      .eq('account_id', req.accountId)
      .limit(1)
      .maybeSingle();

    if (!prev) {
      return res.status(404).json({ error: 'Prospect not found in your account' });
    }

    // Guard: transitioning to "Message à envoyer" requires a non-empty pending_message
    if (status === 'Message à envoyer') {
      if (pending_message !== undefined && !pending_message?.trim()) {
        return res.status(400).json({ error: 'pending_message cannot be empty when setting status to "Message à envoyer"' });
      }
      if (pending_message === undefined) {
        const { data: pRow } = await supabaseAdmin.from('prospects').select('pending_message').eq('id', prospectId).single();
        if (!pRow?.pending_message?.trim()) {
          return res.status(400).json({ error: 'prospect has no pending_message — generate or write a message before validating' });
        }
      }
    }

    // Single UPDATE on prospects (status + message fields)
    const updates = { status, updated_at: new Date().toISOString() };
    if (pending_message !== undefined) updates.pending_message = pending_message;
    if (message_versions !== undefined) updates.message_versions = message_versions;

    const { error } = await supabaseAdmin
      .from('prospects')
      .update(updates)
      .eq('id', prospectId)
      .eq('account_id', req.accountId);

    if (error) throw error;

    // Record in status_history (for Logs page)
    if (prev.status !== status) {
      await supabaseAdmin.from('status_history').insert({
        prospect_id: prospectId,
        old_status: prev.status,
        new_status: status,
        source: 'web_ui',
        account_id: req.accountId,
        campaign_id: prev.campaign_id || null,
      });
    }

    // Record interaction for daily quota tracking
    const today = todayParis();
    if (status === 'Invitation envoyée' && prev.status !== 'Invitation envoyée') {
      const interactionRow = {
        prospect_id: prospectId,
        account_id: req.accountId,
        type: 'Ajout LinkedIn',
        date: today,
        content: 'Invitation LinkedIn envoyée via Dispatch',
      };
      if (step_order != null) interactionRow.step_order = step_order;
      await supabaseAdmin.from('interactions').insert(interactionRow);
    } else if (status === 'Message envoyé' && prev.status !== 'Message envoyé') {
      const interactionRow = {
        prospect_id: prospectId,
        account_id: req.accountId,
        type: 'Message envoyé',
        date: today,
        content: prev.pending_message || 'Message LinkedIn envoyé via Dispatch',
      };
      if (step_order != null) interactionRow.step_order = step_order;
      await supabaseAdmin.from('interactions').insert(interactionRow);
    }

    // Log event
    const campId = prev?.campaign_id;
    if (status === 'Nouveau' && prev?.status === 'Profil à valider') {
      logEvent('prospect_validated', prospectId, campId, req.accountId);
      // Auto-enroll if campaign is active
      enrollProspectIfCampaignActive(prospectId, campId, req.accountId)
        .then(r => { if (r) console.log(`[Auto-enroll] Prospect ${prospectId} enrolled on validation (campaign ${campId})`); })
        .catch(e => console.error('[Auto-enroll] Error:', e.message));
    } else if (EVENT_MAP[status]) {
      logEvent(EVENT_MAP[status], prospectId, campId, req.accountId);
    }

    res.json({ success: true, id: prospectId, status });
  } catch (err) {
    console.error('Erreur /api/prospector/update-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/pending-messages — Get prospects with status "Message à envoyer" (validated by user)
// Claude Dispatch polls this to know which messages to send on LinkedIn
app.get('/api/prospector/pending-messages', accountContext, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('prospects')
      .select('id, first_name, last_name, linkedin_url, pending_message, message_versions')
      .eq('status', 'Message à envoyer')
      .eq('account_id', req.accountId);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur /api/prospector/pending-messages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/message-sent — Mark a message as sent (called by Dispatch after sending on LinkedIn)
app.post('/api/prospector/message-sent', accountContext, async (req, res) => {
  try {
    // Quota check
    const msgSent = await countTodayMessages(req.accountId);
    if (msgSent >= DAILY_MESSAGE_LIMIT) {
      return res.status(429).json({
        error: 'Quota journalier de messages atteint',
        quota: { sent_today: msgSent, limit: DAILY_MESSAGE_LIMIT, remaining: 0 },
      });
    }

    const { linkedin_url, id, step_order } = req.body;
    let prospectId = id;
    if (!prospectId && linkedin_url) {
      const normalizedUrl = normalizeLinkedinUrl(linkedin_url);
      const { data } = await supabaseAdmin.from('prospects').select('id').eq('linkedin_url', normalizedUrl).limit(1);
      if (!data?.length) return res.status(404).json({ error: 'Prospect not found' });
      prospectId = data[0].id;
    }
    if (!prospectId) return res.status(400).json({ error: 'id or linkedin_url required' });

    // Verify prospect belongs to this account and get campaign_id + current status + message content
    const { data: pa } = await supabaseAdmin
      .from('prospects')
      .select('campaign_id, status, pending_message')
      .eq('id', prospectId)
      .eq('account_id', req.accountId)
      .single();

    if (!pa) {
      return res.status(404).json({ error: 'Prospect not found in your account' });
    }

    // Single UPDATE: status + clear pending_message
    await supabaseAdmin.from('prospects').update({
      status: 'Message envoyé',
      pending_message: null,
      updated_at: new Date().toISOString(),
    }).eq('id', prospectId).eq('account_id', req.accountId);

    // Record in status_history (for Logs page)
    if (pa.status !== 'Message envoyé') {
      await supabaseAdmin.from('status_history').insert({
        prospect_id: prospectId,
        old_status: pa.status,
        new_status: 'Message envoyé',
        source: 'dispatch',
        account_id: req.accountId,
        campaign_id: pa.campaign_id || null,
      });
    }

    const interactionRow = {
      prospect_id: prospectId,
      account_id: req.accountId,
      type: 'Message envoyé',
      date: new Date().toISOString().split('T')[0],
      content: pa.pending_message || 'Message LinkedIn envoyé via Claude Dispatch',
    };
    if (step_order != null) interactionRow.step_order = step_order;
    await supabaseAdmin.from('interactions').insert(interactionRow);

    // Log event
    logEvent('message_sent', prospectId, pa?.campaign_id, req.accountId);

    res.json({ success: true, id: prospectId });
  } catch (err) {
    console.error('Erreur /api/prospector/message-sent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/validated-profiles — Prospects validated, ready for LinkedIn add
app.get('/api/prospector/validated-profiles', accountContext, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('prospects')
      .select('id, first_name, last_name, linkedin_url, sales_nav_url, company, job_title, campaign_id, campaigns(name)')
      .eq('status', 'Nouveau')
      .eq('account_id', req.accountId)
      .not('linkedin_url', 'is', null);

    if (error) throw error;

    const result = (data || []).map(p => ({
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      linkedin_url: p.linkedin_url,
      company: p.company,
      job_title: p.job_title,
      sales_nav_url: p.sales_nav_url || null,
      campaign_id: p.campaign_id,
      campaign_name: p.campaigns?.name || null,
    }));

    res.json(result);
  } catch (err) {
    console.error('Erreur /api/prospector/validated-profiles:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/bulk-update-status — Bulk update with status_history tracking
app.post('/api/prospector/bulk-update-status', accountContext, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!ids?.length || !status) return res.status(400).json({ error: 'ids (array) and status required' });
    if (!VALID_PROSPECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Valid: ' + VALID_PROSPECT_STATUSES.join(', ') });
    }

    const bulkOperationId = crypto.randomUUID();

    // Verify all prospects belong to this account
    const { data: ownedProspects, error: checkErr } = await supabaseAdmin
      .from('prospects')
      .select('id, campaign_id, status')
      .eq('account_id', req.accountId)
      .in('id', ids);

    if (checkErr) throw checkErr;
    if (!ownedProspects?.length || ownedProspects.length !== ids.length) {
      return res.status(403).json({ error: 'One or more prospects do not belong to your account' });
    }

    // Update prospects status
    const { error: updateErr } = await supabaseAdmin
      .from('prospects')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('account_id', req.accountId)
      .in('id', ids);

    if (updateErr) throw updateErr;

    // Record in status_history for each changed prospect (for Logs page)
    const historyRows = ownedProspects
      .filter(p => p.status !== status)
      .map(p => ({
        prospect_id: p.id,
        old_status: p.status,
        new_status: status,
        source: 'bulk_update',
        bulk_operation_id: bulkOperationId,
        account_id: req.accountId,
        campaign_id: p.campaign_id || null,
      }));
    if (historyRows.length > 0) {
      await supabaseAdmin.from('status_history').insert(historyRows);
    }

    // Record interactions for daily quota tracking (bulk)
    const today = todayParis();
    if (status === 'Invitation envoyée' || status === 'Message envoyé') {
      const interactionType = status === 'Invitation envoyée' ? 'Ajout LinkedIn' : 'Message envoyé';
      const interactionContent = status === 'Invitation envoyée'
        ? 'Invitation LinkedIn envoyée via Dispatch (bulk)'
        : 'Message LinkedIn envoyé via Dispatch (bulk)';
      const interactionRows = ownedProspects
        .filter(p => p.status !== status)
        .map(p => ({
          prospect_id: p.id,
          account_id: req.accountId,
          type: interactionType,
          date: today,
          content: interactionContent,
        }));
      if (interactionRows.length > 0) {
        await supabaseAdmin.from('interactions').insert(interactionRows);
      }
    }

    // Log prospect_events for each changed prospect + auto-enroll on validation
    for (const p of (ownedProspects || [])) {
      if (p.status === status) continue;
      if (status === 'Nouveau' && p.status === 'Profil à valider') {
        logEvent('prospect_validated', p.id, p.campaign_id, req.accountId);
        enrollProspectIfCampaignActive(p.id, p.campaign_id, req.accountId)
          .then(r => { if (r) console.log(`[Auto-enroll] Prospect ${p.id} enrolled on bulk validation (campaign ${p.campaign_id})`); })
          .catch(e => console.error('[Auto-enroll] Error:', e.message));
      } else if (EVENT_MAP[status]) {
        logEvent(EVENT_MAP[status], p.id, p.campaign_id, req.accountId);
      }
    }

    res.json({ success: true, updated: ownedProspects.length, bulk_operation_id: bulkOperationId });
  } catch (err) {
    console.error('Erreur /api/prospector/bulk-update-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/undo-bulk — Undo a bulk operation
app.post('/api/prospector/undo-bulk', accountContext, async (req, res) => {
  try {
    const { bulk_operation_id } = req.body;
    if (!bulk_operation_id) return res.status(400).json({ error: 'bulk_operation_id required' });

    const { data: history, error: histErr } = await supabaseAdmin
      .from('status_history')
      .select('prospect_id, old_status, new_status')
      .eq('bulk_operation_id', bulk_operation_id)
      .eq('account_id', req.accountId);

    if (histErr) throw histErr;
    if (!history?.length) return res.status(404).json({ error: 'Operation not found or already undone' });

    let restored = 0;
    for (const row of history) {
      if (row.old_status) {
        await supabaseAdmin.from('prospects')
          .update({ status: row.old_status, updated_at: new Date().toISOString() })
          .eq('id', row.prospect_id)
          .eq('account_id', req.accountId);

        // Record the undo in status_history
        await supabaseAdmin.from('status_history').insert({
          prospect_id: row.prospect_id,
          old_status: row.new_status,
          new_status: row.old_status,
          source: 'undo_bulk',
          account_id: req.accountId,
        });

        restored++;
      }
    }

    res.json({ success: true, restored });
  } catch (err) {
    console.error('Erreur /api/prospector/undo-bulk:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospector/regenerate-icebreaker — Regenerate icebreaker from cached LinkedIn posts via Claude API
// Then re-resolve the sequence template message with the new icebreaker
app.post('/api/prospector/regenerate-icebreaker', accountContext, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    // Verify prospect belongs to this account
    const { data: pa, error: checkErr } = await supabaseAdmin
      .from('prospects')
      .select('id, campaign_id')
      .eq('id', id)
      .eq('account_id', req.accountId)
      .single();

    if (checkErr || !pa) {
      return res.status(403).json({ error: 'Prospect not found in your account' });
    }

    // Fetch cached LinkedIn activity
    const { data: activity } = await supabaseAdmin.from('prospect_activity')
      .select('*')
      .eq('prospect_id', id)
      .single();

    if (!activity || !activity.raw_posts || activity.raw_posts.length === 0) {
      return res.json({ success: false, needs_scraping: true, message: 'Aucune donnée LinkedIn en cache. Prochain passage Dispatch nécessaire.' });
    }

    // Generate new icebreaker via Claude API
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });

    const postsText = activity.raw_posts.map(p => `- "${p.text}" (${p.date || 'date inconnue'})`).join('\n');

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: `Voici les derniers posts LinkedIn d'un prospect :\n${postsText}\n\nCes posts ont-ils un lien avec le développement durable et la transition écologique ?\nThèmes pertinents : bilan carbone, ACV, CSRD, RSE, loi climat, résilience, environnement.\n\nSi pertinent : génère une phrase d'accroche de 10-15 mots basée sur le post le plus pertinent, commençant par une minuscule, sans "j'ai vu que".\nSi aucun lien : réponds exactement "NOT_RELEVANT".\n\nRéponds UNIQUEMENT la phrase d'accroche ou "NOT_RELEVANT".` }],
      }),
    });

    if (!claudeResp.ok) {
      const errBody = await claudeResp.text();
      console.error('Claude API error:', claudeResp.status, errBody);
      return res.status(502).json({ error: `Claude API error: ${claudeResp.status}` });
    }

    const claudeData = await claudeResp.json();
    const icebreakerText = (claudeData.content?.[0]?.text || '').trim();
    const isRelevant = icebreakerText !== 'NOT_RELEVANT' && icebreakerText.length > 5;

    // Update prospect_activity with new icebreaker
    await supabaseAdmin.from('prospect_activity').upsert({
      prospect_id: id,
      raw_posts: activity.raw_posts,
      icebreaker_generated: isRelevant ? icebreakerText : null,
      icebreaker_mode: isRelevant ? 'personalized' : 'generic',
      is_relevant: isRelevant,
      scraped_at: activity.scraped_at // Keep original scrape date
    }, { onConflict: 'prospect_id' });

    // Now re-resolve the sequence message template with the new icebreaker
    let resolvedMessage = null;
    if (pa.campaign_id) {
      // Get active sequence and its current step for this prospect
      const { data: seqState } = await supabaseAdmin.from('prospect_sequence_state')
        .select('sequence_id, current_step_order')
        .eq('prospect_id', id)
        .eq('account_id', req.accountId)
        .eq('status', 'active')
        .single();

      if (seqState) {
        const { data: step } = await supabaseAdmin.from('sequence_steps')
          .select('message_content')
          .eq('sequence_id', seqState.sequence_id)
          .eq('step_order', seqState.current_step_order)
          .single();

        if (step?.message_content) {
          // Fetch prospect + campaign + account for placeholder resolution
          const [prospResp, campResp, acctResp] = await Promise.all([
            supabaseAdmin.from('prospects').select('first_name, last_name, company, job_title').eq('id', id).single(),
            supabaseAdmin.from('campaigns').select('name').eq('id', pa.campaign_id).single(),
            supabaseAdmin.from('accounts').select('name').eq('id', req.accountId).single(),
          ]);

          const p = prospResp.data || {};
          const replacements = {
            '{{prospect_first_name}}': p.first_name || '',
            '{{prospect_last_name}}': p.last_name || '',
            '{{prospect_company}}': p.company || '',
            '{{prospect_job_title}}': p.job_title || '',
            '{{user_first_name}}': acctResp.data?.name || '',
            '{{campaign_name}}': campResp.data?.name || '',
            '{{icebreaker}}': isRelevant ? icebreakerText : '(icebreaker générique)',
          };

          resolvedMessage = Object.entries(replacements).reduce(
            (msg, [key, val]) => msg.replaceAll(key, val), step.message_content
          );

          // Update pending_message on prospect
          await supabaseAdmin.from('prospects').update({
            pending_message: resolvedMessage,
            updated_at: new Date().toISOString(),
          }).eq('id', id);
        }
      }
    }

    res.json({
      success: true,
      icebreaker: isRelevant ? icebreakerText : null,
      icebreaker_mode: isRelevant ? 'personalized' : 'generic',
      is_relevant: isRelevant,
      resolved_message: resolvedMessage,
    });
  } catch (err) {
    console.error('Erreur /api/prospector/regenerate-icebreaker:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/dashboard-stats?from=YYYY-MM-DD&to=YYYY-MM-DD — Aggregated stats for dashboard cards
app.get('/api/prospector/dashboard-stats', accountContext, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to query params required (YYYY-MM-DD)' });

    const fromTs = `${from}T00:00:00`;
    const toTs = `${to}T23:59:59`;

    const [campaignsResp, enrolledResp, acceptedResp, totalResp] = await Promise.all([
      // Active campaigns: "En cours" or "En suivi"
      supabaseAdmin.from('campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', req.accountId)
        .in('status', ['En cours', 'En suivi']),
      // Prospects enrolled in a campaign during the period
      supabaseAdmin.from('prospect_sequence_state')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', req.accountId)
        .gte('enrolled_at', fromTs)
        .lte('enrolled_at', toTs),
      // Invitations accepted during the period (from prospect_events — most reliable)
      supabaseAdmin.from('prospect_events')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', req.accountId)
        .eq('type', 'invitation_accepted')
        .gte('created_at', fromTs)
        .lte('created_at', toTs),
      // Total prospects (no date filter)
      supabaseAdmin.from('prospects')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', req.accountId)
        .not('status', 'in', '("Non pertinent","Profil restreint","scrapping_pending")'),
    ]);

    res.json({
      active_campaigns: campaignsResp.count || 0,
      prospects_enrolled: enrolledResp.count || 0,
      invitations_accepted: acceptedResp.count || 0,
      total_prospects: totalResp.count || 0,
    });
  } catch (err) {
    console.error('Erreur /api/prospector/dashboard-stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospector/daily-activity — événements par jour sur N jours
app.get('/api/prospector/daily-activity', accountContext, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    // Build date list
    const today = new Date();
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }
    const fromDate = dates[0];

    // Query events grouped by day + type (timezone Paris), filtered by account
    const { data: events } = await supabaseAdmin
      .from('prospect_events')
      .select('type, created_at')
      .eq('account_id', req.accountId)
      .gte('created_at', fromDate + 'T00:00:00+01:00');

    // Aggregate by day (Paris timezone) + type
    const EVENT_TYPES = ['invitation_accepted', 'message_sent', 'response_received', 'deal_won'];
    const series = {};
    for (const t of EVENT_TYPES) {
      series[t] = new Array(dates.length).fill(0);
    }

    for (const ev of (events || [])) {
      const dayStr = new Date(ev.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
      const idx = dates.indexOf(dayStr);
      if (idx >= 0 && series[ev.type]) {
        series[ev.type][idx]++;
      }
    }

    // Remove types that have all zeros
    const filtered = {};
    for (const [type, data] of Object.entries(series)) {
      if (data.some(v => v > 0)) filtered[type] = data;
    }

    res.json({ dates, series: filtered });
  } catch (err) {
    console.error('Erreur /api/prospector/daily-activity:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   SEQUENCES — API endpoints
// ============================================================

// Simple in-memory rate limiter for message generation
const _genRateMap = new Map();
function checkGenRateLimit(ip, maxPerMin = 10) {
  const now = Date.now();
  const window = 60000;
  const hits = (_genRateMap.get(ip) || []).filter(t => now - t < window);
  if (hits.length >= maxPerMin) return false;
  hits.push(now);
  _genRateMap.set(ip, hits);
  return true;
}

// GET /api/sequences?campaign_id=X — Get active sequence with steps
app.get('/api/sequences', accountContext, async (req, res) => {
  try {
    const { campaign_id } = req.query;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    const { data, error } = await supabaseAdmin
      .from('sequences')
      .select('*, sequence_steps(*)')
      .eq('campaign_id', campaign_id)
      .eq('account_id', req.accountId)
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return res.json(null);

    data.sequence_steps.sort((a, b) => a.step_order - b.step_order);
    res.json(data);
  } catch (err) {
    console.error('Erreur GET /api/sequences:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sequences — Create new sequence (with versioning)
app.post('/api/sequences', accountContext, async (req, res) => {
  try {
    const { campaign_id, name } = req.body;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    // Get the highest version for this campaign
    const { data: allSeqs } = await supabaseAdmin
      .from('sequences')
      .select('version, id')
      .eq('campaign_id', campaign_id)
      .eq('account_id', req.accountId)
      .order('version', { ascending: false });

    const newVersion = (allSeqs && allSeqs.length > 0) ? allSeqs[0].version + 1 : 1;

    // Deactivate ALL active sequences for this campaign
    await supabaseAdmin.from('sequences')
      .update({ is_active: false })
      .eq('campaign_id', campaign_id)
      .eq('account_id', req.accountId);

    // Create new sequence with the new version
    const { data, error } = await supabaseAdmin
      .from('sequences')
      .insert({ campaign_id, account_id: req.accountId, name: name || 'Séquence principale', version: newVersion, is_active: true })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Erreur POST /api/sequences:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sequences/:id — Update sequence name
app.put('/api/sequences/:id', accountContext, async (req, res) => {
  try {
    const { name } = req.body;
    const { data, error } = await supabaseAdmin
      .from('sequences')
      .update({ name })
      .eq('id', req.params.id)
      .eq('account_id', req.accountId)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Erreur PUT /api/sequences:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sequences/:id — Delete sequence (CASCADE on steps)
app.delete('/api/sequences/:id', accountContext, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('sequences').delete().eq('id', req.params.id).eq('account_id', req.accountId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur DELETE /api/sequences:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sequences/:sid/steps — Add step
app.post('/api/sequences/:sid/steps', accountContext, async (req, res) => {
  try {
    const { sid } = req.params;
    const { type, delay_days, message_mode, message_content, message_params, message_label } = req.body;

    const validTypes = ['send_invitation', 'send_message'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid type. Valid: ' + validTypes.join(', ') });
    if (type === 'send_message' && !message_mode) return res.status(400).json({ error: 'message_mode required for send_message' });
    if (type === 'send_message' && (delay_days || 0) < 1) return res.status(400).json({ error: 'delay_days minimum 1 for send_message' });

    // Only one send_invitation per sequence
    if (type === 'send_invitation') {
      const { data: existing } = await supabaseAdmin.from('sequence_steps').select('id').eq('sequence_id', sid).eq('type', 'send_invitation');
      if (existing?.length) return res.status(400).json({ error: 'Une seule étape invitation par séquence' });
    }

    const { data: lastStep } = await supabaseAdmin
      .from('sequence_steps')
      .select('step_order')
      .eq('sequence_id', sid)
      .order('step_order', { ascending: false })
      .limit(1)
      .single();

    const step_order = lastStep ? lastStep.step_order + 1 : 1;

    const { data, error } = await supabaseAdmin
      .from('sequence_steps')
      .insert({ sequence_id: sid, step_order, type, delay_days: delay_days || 0, message_mode: message_mode || null, message_content: message_content || null, message_params: message_params || null, message_label: message_label || null })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    console.error('Erreur POST /api/sequences/:sid/steps:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/sequences/:sid/steps/:id — Update step
app.put('/api/sequences/:sid/steps/:id', accountContext, async (req, res) => {
  try {
    const allowed = ['type', 'delay_days', 'message_mode', 'message_content', 'message_params', 'message_label', 'selected_message', 'selected_mode', 'has_note', 'note_content'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }

    const { data, error } = await supabaseAdmin
      .from('sequence_steps')
      .update(updates)
      .eq('id', req.params.id)
      .eq('sequence_id', req.params.sid)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Erreur PUT /api/sequences/:sid/steps/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sequences/:sid/steps/:id — Delete step and reorder
app.delete('/api/sequences/:sid/steps/:id', accountContext, async (req, res) => {
  try {
    const { sid, id } = req.params;

    const { data: deleted } = await supabaseAdmin.from('sequence_steps').select('step_order').eq('id', id).single();
    const { error } = await supabaseAdmin.from('sequence_steps').delete().eq('id', id);
    if (error) throw error;

    if (deleted) {
      const { data: remaining } = await supabaseAdmin.from('sequence_steps')
        .select('id, step_order')
        .eq('sequence_id', sid)
        .gt('step_order', deleted.step_order)
        .order('step_order', { ascending: true });

      for (const step of (remaining || [])) {
        await supabaseAdmin.from('sequence_steps').update({ step_order: step.step_order - 1 }).eq('id', step.id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur DELETE /api/sequences/:sid/steps/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sequences/:sid/steps/reorder — Reorder steps after drag & drop
app.post('/api/sequences/:sid/steps/reorder', accountContext, async (req, res) => {
  try {
    const { ordered_ids } = req.body;
    if (!Array.isArray(ordered_ids)) return res.status(400).json({ error: 'ordered_ids must be an array' });

    for (let i = 0; i < ordered_ids.length; i++) {
      await supabaseAdmin.from('sequence_steps').update({ step_order: i + 1 }).eq('id', ordered_ids[i]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur POST /api/sequences/:sid/steps/reorder:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sequences/generate-message — Generate full personalized message via Claude API
// Used for: (1) preview in sequence editor (with fake data), (2) Dispatch execution (with real data)
app.post('/api/sequences/generate-message', accountContext, async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress;
    if (!checkGenRateLimit(ip)) return res.status(429).json({ error: 'Rate limit: max 10 requêtes/minute' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });

    const { campaign, message_params, prospect, icebreaker, regen_instructions } = req.body;
    if (!message_params) return res.status(400).json({ error: 'message_params required' });

    const maxChars = message_params.max_chars || 300;

    // Load account style prompt if configured
    const { data: accountData } = await supabaseAdmin
      .from('accounts')
      .select('style_prompt')
      .eq('id', req.accountId)
      .single();
    const stylePrompt = accountData?.style_prompt || null;

    // Build prospect context (real data from Dispatch, or fake data for preview)
    const prospectInfo = prospect
      ? `Prospect : ${prospect.first_name} ${prospect.last_name}, ${prospect.job_title || 'poste inconnu'} chez ${prospect.company || 'entreprise inconnue'}`
      : `Prospect : [Prénom] [Nom], [Poste] chez [Entreprise] (données fictives pour prévisualisation)`;

    const icebreakerInfo = icebreaker
      ? `Icebreaker disponible (phrase d'accroche personnalisée basée sur l'activité LinkedIn) : "${icebreaker}"\nIntègre cet icebreaker naturellement dans le message.`
      : 'Pas d\'icebreaker disponible. Utilise une accroche générique liée au secteur/poste du prospect.';

    const systemPrompt = `Tu es un expert en prospection LinkedIn. Tu génères un message de prospection personnalisé.

${prospectInfo}${stylePrompt ? '\n\n' + stylePrompt : ''}
Campagne : secteur ${campaign?.sector || campaign?.criteria?.sector || 'non défini'}, zone ${campaign?.geography || campaign?.criteria?.geography || 'non définie'}
${icebreakerInfo}

Contraintes :
- Maximum ${maxChars} caractères
- Le message DOIT commencer par "Bonjour ${prospect?.first_name || '[Prénom]'},"
- Angle : ${message_params.angle || 'problème'}
${message_params.objective ? `- Objectif : ${message_params.objective}` : ''}
${message_params.context ? `- Contexte/thématique : ${message_params.context}` : ''}
${message_params.instructions ? `- Instructions spécifiques : ${message_params.instructions}` : ''}
${regen_instructions ? `- Feedback utilisateur (à intégrer pour cette regénération) : ${regen_instructions}` : ''}

Retourne UNIQUEMENT le message, rien d'autre. Pas de guillemets autour, pas d'explication.`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: Math.min(1024, maxChars), system: systemPrompt, messages: [{ role: 'user', content: 'Génère le message.' }] }),
    });

    if (!claudeResp.ok) {
      const errBody = await claudeResp.text();
      console.error('Claude API error:', claudeResp.status, errBody);
      return res.status(502).json({ error: `Claude API error: ${claudeResp.status}` });
    }

    const claudeData = await claudeResp.json();
    const text = (claudeData.content?.[0]?.text || '').trim();
    res.json({ content: text, char_count: text.length });
  } catch (err) {
    console.error('Erreur POST /api/sequences/generate-message:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sequences/preview?campaign_id=X&prospect_id=X — Preview with placeholder replacement
app.get('/api/sequences/preview', accountContext, async (req, res) => {
  try {
    const { campaign_id, prospect_id } = req.query;
    if (!campaign_id || !prospect_id) return res.status(400).json({ error: 'campaign_id and prospect_id required' });

    // Fetch sequence + prospect + campaign + account
    const [seqResp, prospResp, campResp, acctResp] = await Promise.all([
      supabaseAdmin.from('sequences').select('*, sequence_steps(*)').eq('campaign_id', campaign_id).eq('account_id', req.accountId).eq('is_active', true).order('version', { ascending: false }).limit(1).single(),
      supabaseAdmin.from('prospects').select('*').eq('id', prospect_id).single(),
      supabaseAdmin.from('campaigns').select('*').eq('id', campaign_id).single(),
      supabaseAdmin.from('accounts').select('name').eq('id', req.accountId).single(),
    ]);

    if (!seqResp.data) return res.json({ steps: [], status: 'no_sequence' });

    const prospect = prospResp.data || {};
    const campaign = campResp.data || {};
    const account = acctResp.data || {};
    const steps = (seqResp.data.sequence_steps || []).sort((a, b) => a.step_order - b.step_order);

    // Fetch sequence state, activity, and sent messages for real-time status
    const [seqStateResp, activityResp, sentMsgsResp] = await Promise.all([
      supabaseAdmin.from('prospect_sequence_state')
        .select('status, current_step_order, next_action_at, enrolled_at')
        .eq('prospect_id', prospect_id)
        .eq('account_id', req.accountId)
        .maybeSingle(),
      supabaseAdmin.from('prospect_activity')
        .select('icebreaker_generated, icebreaker_mode, is_relevant, scraped_at')
        .eq('prospect_id', prospect_id)
        .maybeSingle(),
      supabaseAdmin.from('interactions')
        .select('content, date, created_at, step_order')
        .eq('prospect_id', prospect_id)
        .eq('account_id', req.accountId)
        .eq('type', 'Message envoyé')
        .order('created_at', { ascending: true }),
    ]);

    const replacements = {
      '{{prospect_first_name}}': prospect.first_name || '',
      '{{prospect_last_name}}': prospect.last_name || '',
      '{{prospect_company}}': prospect.company || '',
      '{{prospect_job_title}}': prospect.job_title || '',
      '{{user_first_name}}': account.name || 'Votre prénom',
      '{{campaign_name}}': campaign.name || '',
    };

    // Also fetch custom placeholders
    const { data: customPh } = await supabaseAdmin.from('placeholders').select('key').eq('source', 'custom');
    for (const ph of (customPh || [])) {
      if (!replacements[`{{${ph.key}}}`]) replacements[`{{${ph.key}}}`] = '';
    }

    const preview = steps.map(step => ({
      ...step,
      message_preview: step.message_content
        ? Object.entries(replacements).reduce((msg, [key, val]) => msg.replaceAll(key, val || `⚠️${key}`), step.message_content)
        : null,
    }));

    res.json({
      steps: preview,
      status: 'not_started',
      sequence: { id: seqResp.data.id, name: seqResp.data.name, version: seqResp.data.version },
      sequence_state: seqStateResp.data || null,
      activity: activityResp.data || null,
      sent_messages: (sentMsgsResp.data || []).filter(m => m.content && m.content !== 'Message LinkedIn envoyé via Claude Dispatch' && m.content !== 'Message LinkedIn envoyé via Dispatch'),
    });
  } catch (err) {
    console.error('Erreur GET /api/sequences/preview:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   PLACEHOLDERS — CRUD
// ============================================================

// GET /api/placeholders
app.get('/api/placeholders', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('placeholders').select('*').order('source').order('label');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur GET /api/placeholders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/placeholders
app.post('/api/placeholders', async (req, res) => {
  try {
    const { key, label, description } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'key and label required' });
    if (!/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ error: 'key must contain only lowercase letters, digits, and underscores' });

    const { data, error } = await supabaseAdmin.from('placeholders')
      .insert({ key, label, description: description || null, source: 'custom', is_system: false })
      .select().single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'This key already exists' });
      throw error;
    }
    res.status(201).json(data);
  } catch (err) {
    console.error('Erreur POST /api/placeholders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/placeholders/:id
app.put('/api/placeholders/:id', async (req, res) => {
  try {
    const { data: existing } = await supabaseAdmin.from('placeholders').select('is_system').eq('id', req.params.id).single();
    if (existing?.is_system) return res.status(403).json({ error: 'Cannot modify system placeholders' });

    const { label, description } = req.body;
    const { data, error } = await supabaseAdmin.from('placeholders')
      .update({ label, description })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Erreur PUT /api/placeholders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/placeholders/:id
app.delete('/api/placeholders/:id', async (req, res) => {
  try {
    const { data: existing } = await supabaseAdmin.from('placeholders').select('is_system').eq('id', req.params.id).single();
    if (existing?.is_system) return res.status(403).json({ error: 'Cannot delete system placeholders' });

    const { error } = await supabaseAdmin.from('placeholders').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur DELETE /api/placeholders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   TASK LOCKS (Sprint 2 Part 3)
// ============================================================

// POST /api/task-locks/acquire — Acquire a lock to prevent concurrent execution
app.post('/api/task-locks/acquire', accountContext, async (req, res) => {
  try {
    const { lock_type, task_name } = req.body;
    if (!lock_type || !task_name) {
      return res.status(400).json({ error: 'lock_type and task_name required' });
    }

    // Try to insert a new lock
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min expiry
    const lockedBy = `worker_${Date.now()}`; // Use timestamp as unique identifier
    const { data: lock, error: insertError } = await supabaseAdmin.from('task_locks')
      .insert({
        account_id: req.accountId,
        lock_type,
        task_name,
        locked_by: lockedBy,
        expires_at: expiresAt
      })
      .select()
      .single();

    if (insertError && insertError.code === '23505') {
      // Unique constraint violated — lock already exists
      const { data: existing } = await supabaseAdmin.from('task_locks')
        .select('locked_by, acquired_at')
        .eq('account_id', req.accountId)
        .eq('lock_type', lock_type)
        .single();

      return res.json({
        acquired: false,
        locked_by: existing?.locked_by,
        acquired_at: existing?.acquired_at
      });
    }

    if (insertError) throw insertError;

    res.json({ acquired: true, lock_id: lock.id, expires_at: expiresAt });
  } catch (err) {
    console.error('Erreur POST /api/task-locks/acquire:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/task-locks/release — Release a lock
app.post('/api/task-locks/release', accountContext, async (req, res) => {
  try {
    const { lock_type } = req.body;
    if (!lock_type) {
      return res.status(400).json({ error: 'lock_type required' });
    }

    const { error } = await supabaseAdmin.from('task_locks')
      .delete()
      .eq('account_id', req.accountId)
      .eq('lock_type', lock_type);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur POST /api/task-locks/release:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   SEQUENCE EXECUTION ENGINE (Sprint 2)
// ============================================================

// POST /api/sequences/enroll — Enroll prospect in active campaign sequence
app.post('/api/sequences/enroll', accountContext, async (req, res) => {
  try {
    const { prospect_id, campaign_id, start_step_order } = req.body;
    if (!prospect_id || !campaign_id) {
      return res.status(400).json({ error: 'prospect_id and campaign_id required' });
    }

    // 1. Get active sequence for campaign
    const { data: sequence } = await supabaseAdmin.from('sequences')
      .select('id')
      .eq('campaign_id', campaign_id)
      .eq('account_id', req.accountId)
      .eq('is_active', true)
      .single();

    if (!sequence) {
      return res.json({ enrolled: false, reason: 'no_active_sequence' });
    }

    // 2. Check if already enrolled
    const { data: existing } = await supabaseAdmin.from('prospect_sequence_state')
      .select('id')
      .eq('prospect_id', prospect_id)
      .eq('sequence_id', sequence.id)
      .single();

    if (existing) {
      return res.json({ enrolled: false, reason: 'already_enrolled' });
    }

    // 3. Determine start step
    const stepOrder = start_step_order || 1;

    // 4. Get the target step to calculate next_action_at
    const { data: targetStep } = await supabaseAdmin.from('sequence_steps')
      .select('type, delay_days')
      .eq('sequence_id', sequence.id)
      .eq('step_order', stepOrder)
      .single();

    // Calculate next_action_at with delay if joining mid-sequence
    const jitter = 0.83 + Math.random() * 0.34;
    const delayMs = targetStep && stepOrder > 1
      ? targetStep.delay_days * jitter * 24 * 60 * 60 * 1000
      : 0;
    const nextActionAt = new Date(Date.now() + delayMs);

    // 5. Insert into prospect_sequence_state
    const { data: state, error: insertError } = await supabaseAdmin.from('prospect_sequence_state')
      .insert({
        prospect_id,
        sequence_id: sequence.id,
        account_id: req.accountId,
        current_step_order: stepOrder,
        status: 'active',
        next_action_at: nextActionAt,
        enrolled_at: new Date()
      })
      .select();

    if (insertError) throw insertError;

    res.json({
      enrolled: true,
      sequence_id: sequence.id,
      state_id: state[0].id,
      start_step: targetStep,
      start_step_order: stepOrder,
      next_action_at: nextActionAt
    });
  } catch (err) {
    console.error('Erreur POST /api/sequences/enroll:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Internal helper — Enroll a single prospect if campaign is active and prospect not yet enrolled
// Used when a prospect transitions from "Profil à valider" → "Nouveau" on an active campaign
async function enrollProspectIfCampaignActive(prospect_id, campaign_id, account_id) {
  if (!campaign_id) return null;

  // Check campaign status
  const { data: campaign } = await supabaseAdmin.from('campaigns')
    .select('status')
    .eq('id', campaign_id)
    .eq('account_id', account_id)
    .single();

  if (!campaign || !['En cours', 'En suivi'].includes(campaign.status)) return null;

  // Get active sequence
  const { data: sequence } = await supabaseAdmin.from('sequences')
    .select('id, sequence_steps(step_order, type, delay_days)')
    .eq('campaign_id', campaign_id)
    .eq('account_id', account_id)
    .eq('is_active', true)
    .single();

  if (!sequence) return null;

  const steps = (sequence.sequence_steps || []).sort((a, b) => a.step_order - b.step_order);
  if (!steps.length) return null;

  // Check not already enrolled
  const { data: existing } = await supabaseAdmin.from('prospect_sequence_state')
    .select('id')
    .eq('prospect_id', prospect_id)
    .eq('sequence_id', sequence.id)
    .maybeSingle();

  if (existing) return null; // already enrolled

  // New prospect → first invitation step
  const firstStep = steps.find(s => s.type === 'send_invitation') || steps[0];

  const { error } = await supabaseAdmin.from('prospect_sequence_state').insert({
    prospect_id,
    sequence_id: sequence.id,
    account_id,
    current_step_order: firstStep.step_order,
    status: 'active',
    next_action_at: new Date(),
    enrolled_at: new Date()
  });

  if (error) {
    console.error('[Auto-enroll single] Error:', error.message);
    return null;
  }

  return { enrolled: true, step: firstStep.step_order };
}

// Internal helper — Bulk enroll all eligible prospects of a campaign into its active sequence
// Returns { enrolled, skipped_excluded, skipped_already, skipped_no_step, details }
// Returns null if no active sequence exists for this campaign
async function enrollCampaignProspects(campaign_id, account_id) {
  const { data: sequence } = await supabaseAdmin.from('sequences')
    .select('id, sequence_steps(step_order, type)')
    .eq('campaign_id', campaign_id)
    .eq('account_id', account_id)
    .eq('is_active', true)
    .single();

  if (!sequence) return null;

  const steps = (sequence.sequence_steps || []).sort((a, b) => a.step_order - b.step_order);
  if (steps.length === 0) return null;

  const firstInvitationStep = steps.find(s => s.type === 'send_invitation');
  const firstMessageStep = steps.find(s => s.type === 'send_message');
  const secondMessageStep = steps.filter(s => s.type === 'send_message')[1];

  const { data: prospects } = await supabaseAdmin.from('prospects')
    .select('id, status')
    .eq('campaign_id', campaign_id)
    .eq('account_id', account_id);

  const { data: enrolled } = await supabaseAdmin.from('prospect_sequence_state')
    .select('prospect_id')
    .eq('sequence_id', sequence.id);
  const enrolledSet = new Set((enrolled || []).map(e => e.prospect_id));

  const EXCLUDED = ['Profil à valider', 'Gagné', 'Perdu', 'Non pertinent', 'Profil restreint'];
  const results = { enrolled: 0, skipped_excluded: 0, skipped_already: 0, skipped_no_step: 0, details: {} };

  for (const pa of (prospects || [])) {
    if (EXCLUDED.includes(pa.status)) { results.skipped_excluded++; continue; }
    if (enrolledSet.has(pa.id)) { results.skipped_already++; continue; }

    let targetStepOrder = null;
    switch (pa.status) {
      case 'Nouveau':
        targetStepOrder = firstInvitationStep?.step_order || steps[0].step_order;
        break;
      case 'Invitation envoyée':
        targetStepOrder = firstInvitationStep
          ? (firstMessageStep?.step_order || firstInvitationStep.step_order)
          : steps[0].step_order;
        break;
      case 'Invitation acceptée':
      case 'Message à valider':
      case 'Message à envoyer':
        targetStepOrder = firstMessageStep?.step_order || steps[0].step_order;
        break;
      case 'Message envoyé':
      case 'Discussion en cours':
        targetStepOrder = secondMessageStep?.step_order || null;
        break;
      default:
        targetStepOrder = null;
    }

    if (!targetStepOrder) { results.skipped_no_step++; continue; }

    const { data: stepData } = await supabaseAdmin.from('sequence_steps')
      .select('delay_days')
      .eq('sequence_id', sequence.id)
      .eq('step_order', targetStepOrder)
      .single();

    const jitter = 0.83 + Math.random() * 0.34;
    const delayMs = targetStepOrder > 1 && stepData
      ? stepData.delay_days * jitter * 24 * 60 * 60 * 1000
      : 0;
    const nextActionAt = new Date(Date.now() + delayMs);

    const { error: insertErr } = await supabaseAdmin.from('prospect_sequence_state')
      .insert({
        prospect_id: pa.id,
        sequence_id: sequence.id,
        account_id: account_id,
        current_step_order: targetStepOrder,
        status: 'active',
        next_action_at: nextActionAt,
        enrolled_at: new Date()
      });

    if (!insertErr) {
      results.enrolled++;
      const key = `step_${targetStepOrder}`;
      results.details[key] = (results.details[key] || 0) + 1;
    }
  }

  return results;
}

// POST /api/sequences/enroll-campaign — Bulk enroll all prospects of a campaign based on their status
app.post('/api/sequences/enroll-campaign', accountContext, async (req, res) => {
  try {
    const { campaign_id } = req.body;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    const results = await enrollCampaignProspects(campaign_id, req.accountId);
    if (!results) return res.status(400).json({ error: 'Aucune séquence active pour cette campagne' });

    res.json(results);
  } catch (err) {
    console.error('Erreur POST /api/sequences/enroll-campaign:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sequences/due-actions — Get actions ready to execute now
app.get('/api/sequences/due-actions', accountContext, async (req, res) => {
  try {
    // 1. Get due prospect_sequence_state
    const { data: dueStates, error: statesError } = await supabaseAdmin
      .from('prospect_sequence_state')
      .select('id, prospect_id, current_step_order, sequence_id')
      .eq('account_id', req.accountId)
      .eq('status', 'active')
      .lte('next_action_at', new Date().toISOString())
      .order('next_action_at', { ascending: true });

    if (statesError) throw statesError;

    // 2. For each state, get the step details
    const dueActions = [];
    for (const state of dueStates || []) {
      const { data: step } = await supabaseAdmin.from('sequence_steps')
        .select('*')
        .eq('sequence_id', state.sequence_id)
        .eq('step_order', state.current_step_order)
        .single();

      const { data: prospect } = await supabaseAdmin.from('prospects')
        .select('id, first_name, last_name, company, job_title, linkedin_url, pending_message, status, campaign_id')
        .eq('id', state.prospect_id)
        .eq('account_id', req.accountId)
        .single();

      if (step && prospect) {
        dueActions.push({ ...state, step, prospect, prospect_account: { status: prospect.status, campaign_id: prospect.campaign_id, pending_message: prospect.pending_message } });
      }
    }

    // 3. Also get pending messages to send
    const { data: pendingMessages, error: msgError } = await supabaseAdmin
      .from('prospects')
      .select('id, first_name, last_name, company, job_title, linkedin_url, pending_message, status, campaign_id, account_id')
      .eq('account_id', req.accountId)
      .eq('status', 'Message à envoyer');

    if (msgError) throw msgError;

    res.json({
      sequence_actions: dueActions,
      pending_messages: (pendingMessages || []).map(pa => ({
        ...pa,
        action_type: 'send_pending_message'
      }))
    });
  } catch (err) {
    console.error('Erreur GET /api/sequences/due-actions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sequences/complete-step — Mark step as done, calculate next action
app.post('/api/sequences/complete-step', accountContext, async (req, res) => {
  try {
    const { state_id, completed_step_order } = req.body;
    if (!state_id || completed_step_order === undefined) {
      return res.status(400).json({ error: 'state_id and completed_step_order required' });
    }

    // Get current state
    const { data: state } = await supabaseAdmin.from('prospect_sequence_state')
      .select('*')
      .eq('id', state_id)
      .eq('account_id', req.accountId)
      .single();

    if (!state) return res.status(404).json({ error: 'State not found' });

    // Get next step
    const { data: nextStep } = await supabaseAdmin.from('sequence_steps')
      .select('*')
      .eq('sequence_id', state.sequence_id)
      .eq('step_order', completed_step_order + 1)
      .single();

    let updateData = { last_action_at: new Date() };

    if (!nextStep) {
      // No more steps → completed
      updateData.status = 'completed';
    } else {
      // Calculate next action with ±17% jitter
      const jitter = 0.83 + Math.random() * 0.34;
      const delayMs = nextStep.delay_days * jitter * 24 * 60 * 60 * 1000;
      const nextActionAt = new Date(Date.now() + delayMs);

      updateData.current_step_order = completed_step_order + 1;
      updateData.next_action_at = nextActionAt;
    }

    const { error: updateError } = await supabaseAdmin.from('prospect_sequence_state')
      .update(updateData)
      .eq('id', state_id);

    if (updateError) throw updateError;

    res.json({ success: true, next_step: nextStep, next_action_at: updateData.next_action_at });
  } catch (err) {
    console.error('Erreur POST /api/sequences/complete-step:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/:id/linkedin-activity — Get cached activity or trigger scraping
app.get('/api/prospects/:id/linkedin-activity', accountContext, async (req, res) => {
  try {
    const { data: activity } = await supabaseAdmin.from('prospect_activity')
      .select('*')
      .eq('prospect_id', req.params.id)
      .single();

    if (activity) {
      const age = Date.now() - new Date(activity.scraped_at).getTime();
      if (age < 120 * 3600 * 1000) { // 5 days (≈ 3 business days)
        // Cache is fresh
        return res.json(activity);
      }
    }

    // Cache missing or stale → trigger scraping via Task 2
    res.json({ needs_scraping: true, prospect_id: req.params.id });
  } catch (err) {
    console.error('Erreur GET /api/prospects/:id/linkedin-activity:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospects/:id/linkedin-activity — Save scraped activity + icebreaker
app.post('/api/prospects/:id/linkedin-activity', accountContext, async (req, res) => {
  try {
    const { raw_posts, icebreaker_generated, icebreaker_mode, is_relevant } = req.body;

    const { error } = await supabaseAdmin.from('prospect_activity')
      .upsert({
        prospect_id: req.params.id,
        raw_posts,
        icebreaker_generated,
        icebreaker_mode,
        is_relevant,
        scraped_at: new Date()
      }, { onConflict: 'prospect_id' });

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Erreur POST /api/prospects/:id/linkedin-activity:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sequences/stop — Manually stop a prospect's sequence
app.post('/api/sequences/stop', accountContext, async (req, res) => {
  try {
    const { prospect_id, reason } = req.body;
    if (!prospect_id || !['manual', 'reply', 'error'].includes(reason)) {
      return res.status(400).json({ error: 'prospect_id and valid reason required' });
    }

    const status = reason === 'error' ? 'paused' : 'stopped_reply';

    const { error } = await supabaseAdmin.from('prospect_sequence_state')
      .update({ status, updated_at: new Date() })
      .eq('prospect_id', prospect_id)
      .eq('account_id', req.accountId)
      .eq('status', 'active');

    if (error) throw error;
    res.json({ success: true, status });
  } catch (err) {
    console.error('Erreur POST /api/sequences/stop:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   LOGS ENDPOINT
// ============================================================

// GET /api/logs — Activity log (status changes + interactions)
app.get('/api/logs', accountContext, async (req, res) => {
  try {
    const { campaign_id, from, to, type } = req.query;
    const limit = 100;

    let query = supabaseAdmin.from('status_history').select(`
      created_at,
      prospect:prospects(id, first_name, last_name, company),
      old_status,
      new_status,
      source,
      bulk_operation_id
    `).eq('account_id', req.accountId);

    // Filter by campaign if provided
    if (campaign_id) {
      query = query.eq('campaign_id', campaign_id);
    }

    // Filter by date range
    if (from) {
      query = query.gte('created_at', from);
    }
    if (to) {
      query = query.lte('created_at', to);
    }

    // Type filter
    if (type === 'sequence') {
      let seqQuery = supabaseAdmin.from('prospect_sequence_state')
        .select('updated_at, prospect_id, status, current_step_order, prospects(first_name, last_name, company)')
        .eq('account_id', req.accountId)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (from) seqQuery = seqQuery.gte('updated_at', from);
      if (to) seqQuery = seqQuery.lte('updated_at', to);
      const { data: seqData, error: seqError } = await seqQuery;
      if (seqError) throw seqError;
      return res.json((seqData || []).map(row => ({
        created_at: row.updated_at,
        prospect: row.prospects,
        action_category: 'sequence',
        status: row.status,
        current_step_order: row.current_step_order,
      })));
    }

    if (type === 'dispatch') {
      let dQuery = supabaseAdmin.from('dispatch_summaries')
        .select('*')
        .eq('account_id', req.accountId)
        .order('ran_at', { ascending: false })
        .limit(limit);
      if (from) dQuery = dQuery.gte('ran_at', from);
      if (to) dQuery = dQuery.lte('ran_at', to);
      const { data: dData, error: dError } = await dQuery;
      if (dError) throw dError;
      return res.json(dData || []);
    }

    if (type && type !== 'status_change') {
      return res.json([]);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Erreur GET /api/logs:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/summary — Store a Task 2 execution report
app.post('/api/dispatch/summary', accountContext, async (req, res) => {
  try {
    const {
      ran_at, duration_seconds,
      invitations_sent = 0, invitations_accepted = 0,
      messages_submitted = 0, messages_sent = 0,
      replies_detected = 0,
      quota_invitations_remaining, quota_messages_remaining,
      stopped_reason = null, errors = [],
    } = req.body;

    const { data, error } = await supabaseAdmin
      .from('dispatch_summaries')
      .insert({
        account_id: req.accountId,
        ran_at: ran_at || new Date().toISOString(),
        duration_seconds: duration_seconds || null,
        invitations_sent, invitations_accepted,
        messages_submitted, messages_sent, replies_detected,
        quota_invitations_remaining: quota_invitations_remaining ?? null,
        quota_messages_remaining: quota_messages_remaining ?? null,
        stopped_reason,
        errors,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Erreur POST /api/dispatch/summary:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sequences/bulk-generate-messages — Generate AND save messages for multiple prospects
// Atomic: generates via Claude then writes pending_message + sets status "Message à valider"
// The Dispatch only needs to call this — no separate save step required
// Body: { prospects: [{ id, first_name, last_name, job_title, company, campaign_id, icebreaker? }], step_order: 2 }
app.post('/api/sequences/bulk-generate-messages', accountContext, async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });

    const { prospects, step_order } = req.body;
    if (!prospects?.length) return res.status(400).json({ error: 'prospects[] required' });
    if (!step_order) return res.status(400).json({ error: 'step_order required' });

    // Load account style prompt once
    const { data: accountData } = await supabaseAdmin
      .from('accounts').select('style_prompt').eq('id', req.accountId).single();
    const stylePrompt = accountData?.style_prompt || null;

    // Collect unique campaign_ids to load campaigns + steps in bulk
    const campaignIds = [...new Set(prospects.map(p => p.campaign_id).filter(Boolean))];
    const prospectIds = prospects.map(p => p.id);

    // Load the actual enrolled sequence_id for each prospect (may differ from active sequence if versioning)
    const { data: enrolledStates } = await supabaseAdmin
      .from('prospect_sequence_state')
      .select('prospect_id, sequence_id')
      .in('prospect_id', prospectIds)
      .eq('account_id', req.accountId)
      .eq('status', 'active');

    const enrolledSequenceIds = [...new Set((enrolledStates || []).map(s => s.sequence_id))];
    const prospectToSequence = Object.fromEntries((enrolledStates || []).map(s => [s.prospect_id, s.sequence_id]));

    const [{ data: campaigns }, { data: sequences }] = await Promise.all([
      supabaseAdmin.from('campaigns').select('id, sector, geography, criteria').in('id', campaignIds),
      enrolledSequenceIds.length > 0
        ? supabaseAdmin.from('sequences')
            .select('id, campaign_id, sequence_steps!inner(step_order, message_params, message_mode, icebreaker_mode)')
            .in('id', enrolledSequenceIds)
        : Promise.resolve({ data: [] }),
    ]);

    const campaignMap = Object.fromEntries((campaigns || []).map(c => [c.id, c]));
    // Map sequence_id → step at step_order
    const stepOrderInt = parseInt(step_order, 10);
    const stepBySeqId = {};
    for (const seq of (sequences || [])) {
      const step = seq.sequence_steps?.find(s => s.step_order === stepOrderInt);
      if (step) stepBySeqId[seq.id] = { step, campaign_id: seq.campaign_id };
    }
    // Map prospect_id → step (via enrolled sequence_id)
    const stepMap = {};
    for (const prospect of prospects) {
      const seqId = prospectToSequence[prospect.id];
      if (seqId && stepBySeqId[seqId]) {
        stepMap[prospect.id] = stepBySeqId[seqId].step;
      }
    }

    // Load prospect statuses to skip those in invalid states (not yet connected, etc.)
    const { data: paRows } = await supabaseAdmin
      .from('prospects')
      .select('id, status')
      .eq('account_id', req.accountId)
      .in('id', prospectIds)
      .limit(prospectIds.length);
    const statusMap = Object.fromEntries((paRows || []).map(r => [r.id, r.status]));
    const BLOCKED_STATUSES = ['Profil à valider', 'Nouveau', 'Non pertinent', 'Perdu', 'Invitation envoyée'];

    const results = [];

    for (const prospect of prospects) {
      try {
        const prospectStatus = statusMap[prospect.id];
        if (BLOCKED_STATUSES.includes(prospectStatus)) {
          results.push({ prospect_id: prospect.id, error: 'invalid_status', status: prospectStatus });
          continue;
        }

        const campaign = campaignMap[prospect.campaign_id] || {};
        const step = stepMap[prospect.id];
        if (!step?.message_params) {
          results.push({ prospect_id: prospect.id, error: 'no_step_params' });
          continue;
        }

        const message_params = step.message_params;
        const maxChars = message_params.max_chars || 300;
        const icebreaker = prospect.icebreaker || null;

        const prospectInfo = `Prospect : ${prospect.first_name} ${prospect.last_name}, ${prospect.job_title || 'poste inconnu'} chez ${prospect.company || 'entreprise inconnue'}`;
        const icebreakerInfo = icebreaker
          ? `Icebreaker disponible (phrase d'accroche personnalisée basée sur l'activité LinkedIn) : "${icebreaker}"\nIntègre cet icebreaker naturellement dans le message.`
          : 'Pas d\'icebreaker disponible. Utilise une accroche générique liée au secteur/poste du prospect.';

        const systemPrompt = `Tu es un expert en prospection LinkedIn. Tu génères un message de prospection personnalisé.

${prospectInfo}${stylePrompt ? '\n\n' + stylePrompt : ''}
Campagne : secteur ${campaign.sector || campaign.criteria?.sector || 'non défini'}, zone ${campaign.geography || campaign.criteria?.geography || 'non définie'}
${icebreakerInfo}

Contraintes :
- Maximum ${maxChars} caractères
- Le message DOIT commencer par "Bonjour ${prospect.first_name},"
- Angle : ${message_params.angle || 'problème'}
${message_params.objective ? `- Objectif : ${message_params.objective}` : ''}
${message_params.context ? `- Contexte/thématique : ${message_params.context}` : ''}
${message_params.instructions ? `- Instructions spécifiques : ${message_params.instructions}` : ''}

Retourne UNIQUEMENT le message, rien d'autre. Pas de guillemets autour, pas d'explication.`;

        const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: Math.min(1024, maxChars), system: systemPrompt, messages: [{ role: 'user', content: 'Génère le message.' }] }),
        });

        if (!claudeResp.ok) {
          results.push({ prospect_id: prospect.id, error: `claude_error_${claudeResp.status}` });
          continue;
        }

        const claudeData = await claudeResp.json();
        const text = (claudeData.content?.[0]?.text || '').trim();
        if (!text) {
          results.push({ prospect_id: prospect.id, error: 'empty_response' });
          continue;
        }

        // Atomic write: save pending_message + set status "Message à valider"
        await supabaseAdmin.from('prospects').update({
          pending_message: text,
          message_versions: null,
          status: 'Message à valider',
          updated_at: new Date().toISOString(),
        }).eq('id', prospect.id).eq('account_id', req.accountId);

        results.push({ prospect_id: prospect.id, content: text, char_count: text.length, saved: true });
      } catch (err) {
        results.push({ prospect_id: prospect.id, error: err.message });
      }
    }

    res.json({ results, total: prospects.length, generated: results.filter(r => r.saved).length });
  } catch (err) {
    console.error('Erreur POST /api/sequences/bulk-generate-messages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/diagnostic/fix-issues — Apply bulk fixes for known inconsistency types
app.post('/api/diagnostic/fix-issues', accountContext, async (req, res) => {
  try {
    const { type } = req.body;

    if (type === 'status_valider_no_message') {
      // Find all prospects with status='Message à valider' but no pending_message
      const { data: rows } = await supabaseAdmin
        .from('prospects')
        .select('id, pending_message')
        .eq('account_id', req.accountId)
        .eq('status', 'Message à valider');

      const toFix = (rows || []).filter(p => !p.pending_message).map(p => p.id);

      if (!toFix.length) return res.json({ fixed: 0, message: 'Nothing to fix' });

      const { error } = await supabaseAdmin
        .from('prospects')
        .update({ status: 'Invitation acceptée' })
        .eq('account_id', req.accountId)
        .in('id', toFix);

      if (error) throw error;
      return res.json({ fixed: toFix.length, prospect_ids: toFix });
    }

    if (type === 'status_envoyer_no_message') {
      // Find all prospects with status='Message à envoyer' but no pending_message
      const { data: rows } = await supabaseAdmin
        .from('prospects')
        .select('id, first_name, last_name, pending_message, message_versions')
        .eq('account_id', req.accountId)
        .eq('status', 'Message à envoyer');

      const toFix = (rows || []).filter(p => !p.pending_message?.trim());

      if (!toFix.length) return res.json({ fixed: 0, message: 'Nothing to fix' });

      const promoted = [];
      const reset = [];

      for (const p of toFix) {
        const versions = p.message_versions;
        const firstVersion = Array.isArray(versions) && versions.length > 0 ? versions[0]?.content : null;

        if (firstVersion?.trim()) {
          await supabaseAdmin.from('prospects').update({
            pending_message: firstVersion.trim(),
            updated_at: new Date().toISOString(),
          }).eq('id', p.id);
          promoted.push(p.id);
        } else {
          await supabaseAdmin.from('prospects').update({
            status: 'Message à valider',
            updated_at: new Date().toISOString(),
          }).eq('id', p.id).eq('account_id', req.accountId);
          reset.push(p.id);
        }
      }

      return res.json({
        fixed: toFix.length,
        promoted_from_versions: promoted.length,
        reset_to_valider: reset.length,
        promoted_ids: promoted,
        reset_ids: reset,
      });
    }

    res.status(400).json({ error: `Unknown fix type: ${type}` });
  } catch (err) {
    console.error('Erreur POST /api/diagnostic/fix-issues:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diagnostic/prospect-audit — Cross-check prospect status vs sequence state vs pending_message
app.get('/api/diagnostic/prospect-audit', accountContext, async (req, res) => {
  try {
    // Fetch all data in parallel
    const [{ data: paRows }, { data: seqStates }, { data: campaigns }] = await Promise.all([
      supabaseAdmin
        .from('prospects')
        .select('id, first_name, last_name, company, pending_message, message_versions, status, campaign_id')
        .eq('account_id', req.accountId),
      supabaseAdmin
        .from('prospect_sequence_state')
        .select('prospect_id, status, current_step_order, sequence_id, enrolled_at')
        .eq('account_id', req.accountId),
      supabaseAdmin
        .from('campaigns')
        .select('id, name')
        .eq('account_id', req.accountId),
    ]);

    const seqStateMap = Object.fromEntries((seqStates || []).map(s => [s.prospect_id, s]));
    const campaignMap = Object.fromEntries((campaigns || []).map(c => [c.id, c.name]));

    const STATUSES_NOT_CONNECTED = ['Profil à valider', 'Nouveau', 'Invitation envoyée'];
    const STATUSES_WITH_MESSAGE  = ['Message à valider', 'Message à envoyer'];

    const issues = [];

    for (const p of (paRows || [])) {
      const seq = seqStateMap[p.id];
      const base = {
        prospect_id: p.id,
        name: `${p.first_name} ${p.last_name}`,
        company: p.company,
        campaign: campaignMap[p.campaign_id] || p.campaign_id,
        pa_status: p.status,
        pending_message: p.pending_message ? p.pending_message.slice(0, 60) + '…' : null,
        seq_step: seq?.current_step_order ?? null,
        seq_status: seq?.status ?? null,
        enrolled_at: seq?.enrolled_at ?? null,
      };

      // Case 1 — pending_message exists but status doesn't reflect it
      if (p.pending_message && !STATUSES_WITH_MESSAGE.includes(p.status)) {
        issues.push({ ...base, issue: 'pending_message_wrong_status', fix: 'set status → Message à valider' });
      }

      // Case 2 — status = Message à valider but no pending_message
      if (p.status === 'Message à valider' && !p.pending_message) {
        issues.push({ ...base, issue: 'status_valider_no_message', fix: 'set status → Invitation acceptée' });
      }

      // Case 2b — status = Message à envoyer but no pending_message (validated but nothing to send)
      if (p.status === 'Message à envoyer' && !p.pending_message?.trim()) {
        const hasVersions = Array.isArray(p.message_versions) && p.message_versions.length > 0;
        issues.push({ ...base, issue: 'status_envoyer_no_message', fix: hasVersions ? 'promote first version → pending_message' : 'set status → Message à valider' });
      }

      // Case 3 — advanced in sequence (step ≥ 2) but not connected on LinkedIn
      if (seq && seq.current_step_order >= 2 && STATUSES_NOT_CONNECTED.includes(p.status)) {
        issues.push({ ...base, issue: 'sequence_ahead_not_connected', fix: 'reset sequence or fix status' });
      }

      // Case 4 — enrolled in sequence but status is terminal (Non pertinent / Perdu)
      if (seq && ['Non pertinent', 'Perdu'].includes(p.status)) {
        issues.push({ ...base, issue: 'enrolled_but_disqualified', fix: 'unenroll from sequence' });
      }
    }

    // Group by issue type
    const grouped = {};
    for (const issue of issues) {
      if (!grouped[issue.issue]) grouped[issue.issue] = [];
      grouped[issue.issue].push(issue);
    }

    res.json({
      total_prospects: (paRows || []).length,
      total_issues: issues.length,
      grouped,
      all: issues,
    });
  } catch (err) {
    console.error('Erreur GET /api/diagnostic/prospect-audit:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Emelia API ---
const EMELIA_API_KEY = process.env.EMELIA_API_KEY;

// Cache simple en mémoire { value, expiresAt }
const _cache = {};
function cacheGet(key) {
  const e = _cache[key];
  return e && e.expiresAt > Date.now() ? e.value : null;
}
function cacheSet(key, value, ttlMs) {
  _cache[key] = { value, expiresAt: Date.now() + ttlMs };
}

function emeliRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.emelia.io',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': EMELIA_API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) reject(new Error(json.errors[0].message));
          else resolve(json.data);
        } catch (e) { reject(new Error('Réponse Emelia invalide')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function emeliRestRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.emelia.io',
      path,
      method: 'GET',
      headers: { 'Authorization': EMELIA_API_KEY },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Réponse Emelia invalide')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchEmeliaCampaignList() {
  const listData = await emeliRequest({
    operationName: 'GetCampaignsStat',
    query: `query GetCampaignsStat($options: JSON) {
      all_campaigns(options: $options) { _id name status createdAt }
    }`,
    variables: { options: { withArchived: false } },
  });
  const campaigns = (listData && listData.all_campaigns) || [];
  const active = campaigns.filter(c => c.status !== 'DRAFT');
  active.sort((a, b) => {
    const parse = s => { const [d, m, y] = s.split('/'); return new Date(y, m - 1, d); };
    return parse(b.createdAt) - parse(a.createdAt);
  });
  return active.slice(0, 5);
}

async function fetchEmeliaCampaignById(campaignId) {
  const [statsData, detailData] = await Promise.all([
    emeliRestRequest(`/stats?campaignId=${campaignId}&detailed=true`),
    emeliRequest({
      operationName: 'GetCampaignData',
      query: `query GetCampaignData($id: ID!) {
        campaign(id: $id) {
          _id name status createdAt
          steps { delay { amount unit } versions { subject disabled } }
        }
      }`,
      variables: { id: campaignId },
    }),
  ]);

  const c = detailData.campaign;
  const steps = (c.steps || []).map((step, i) => {
    const v = step.versions.find(v => !v.disabled) || step.versions[0] || {};
    return {
      index: i + 1,
      subject: v.subject || '',
      delay: step.delay,
      ...(statsData.steps && statsData.steps[i] && statsData.steps[i][0] ? {
        sent: statsData.steps[i][0].sent,
        first_open: statsData.steps[i][0].first_open,
        first_open_percent: statsData.steps[i][0].first_open_percent,
        replied: statsData.steps[i][0].replied,
        replied_percent: statsData.steps[i][0].replied_percent,
        bounced: statsData.steps[i][0].bounced,
      } : {}),
    };
  });

  return { ...c, steps, stats: statsData.global };
}

// GET /api/emelia-campaigns — liste des 5 dernières campagnes (cache 3 min)
app.get('/api/emelia-campaigns', async (req, res) => {
  try {
    const cached = cacheGet('emelia-campaigns');
    if (cached) return res.json({ campaigns: cached });
    const list = await fetchEmeliaCampaignList();
    cacheSet('emelia-campaigns', list, 3 * 60 * 1000);
    res.json({ campaigns: list });
  } catch (err) {
    console.error('Erreur Emelia list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emelia-campaign?id=xxx — stats d'une campagne (cache 2 min par id)
app.get('/api/emelia-campaign', async (req, res) => {
  try {
    let campaignId = req.query.id;
    if (!campaignId) {
      const cached = cacheGet('emelia-campaigns');
      const list = cached || await fetchEmeliaCampaignList();
      if (!cached) cacheSet('emelia-campaigns', list, 3 * 60 * 1000);
      if (!list.length) return res.json({ campaign: null });
      campaignId = list[0]._id;
    }
    const cacheKey = `emelia-campaign-${campaignId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ campaign: cached });
    const campaign = await fetchEmeliaCampaignById(campaignId);
    cacheSet(cacheKey, campaign, 2 * 60 * 1000);
    res.json({ campaign });
  } catch (err) {
    console.error('Erreur Emelia:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/emelia-labels', async (req, res) => {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return res.status(500).json({ error: 'GMAIL non configuré' });
  const cached = cacheGet('emelia-labels');
  if (cached) return res.json({ labels: cached });
  const imap = createImapConnection();
  const SYSTEM_SKIP = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'all mail', 'important',
    'starred', '[gmail]', 'sent mail', 'bin', 'junk', 'notes', 'brouillons', 'corbeille',
    'messages envoyés', 'suivis', 'tous les messages'];
  try {
    const labels = await new Promise((resolve, reject) => {
      imap.once('ready', () => {
        imap.getBoxes((err, boxes) => {
          if (err) { imap.end(); return reject(err); }
          const candidates = [];
          const walk = (obj, prefix = '') => {
            for (const [name, box] of Object.entries(obj)) {
              const fullName = prefix ? `${prefix}/${name}` : name;
              if (!SYSTEM_SKIP.includes(name.toLowerCase())) candidates.push({ name, fullName });
              if (box.children) walk(box.children, fullName);
            }
          };
          walk(boxes);
          const results = [];
          let i = 0;
          const next = () => {
            if (i >= candidates.length) { imap.end(); return resolve(results); }
            const { name, fullName } = candidates[i++];
            imap.openBox(fullName, true, (err, box) => {
              if (err || !box.messages.total) { results.push({ name, fullName, count: 0 }); return next(); }
              imap.search(['ALL'], (err, uids) => {
                if (err || !uids.length) { results.push({ name, fullName, count: 0 }); return next(); }
                const f = imap.fetch(uids, { bodies: 'HEADER.FIELDS (FROM)', struct: false });
                const senders = new Set();
                f.on('message', (msg) => {
                  msg.on('body', (stream) => {
                    let raw = '';
                    stream.on('data', d => raw += d);
                    stream.on('end', () => {
                      const match = raw.match(/From:\s*.*?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
                      if (match) senders.add(match[1].toLowerCase());
                    });
                  });
                });
                f.once('error', () => { results.push({ name, fullName, count: 0 }); next(); });
                f.once('end', () => { results.push({ name, fullName, count: senders.size }); next(); });
              });
            });
          };
          next();
        });
      });
      imap.once('error', reject);
      imap.connect();
    });
    cacheSet('emelia-labels', labels, 10 * 60 * 1000); // cache 10 min
    res.json({ labels });
  } catch (err) {
    console.error('Erreur IMAP labels:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/emelia-label-contacts', async (req, res) => {
  const labelName = req.query.label;
  if (!labelName) return res.status(400).json({ error: 'label requis' });
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return res.status(500).json({ error: 'GMAIL non configuré' });
  const imap = createImapConnection();
  try {
    const contacts = await new Promise((resolve, reject) => {
      imap.once('ready', () => {
        imap.openBox(labelName, true, (err) => {
          if (err) { imap.end(); return reject(err); }
          imap.search(['ALL'], (err, uids) => {
            if (err || !uids.length) { imap.end(); return resolve([]); }
            const f = imap.fetch(uids, { bodies: 'HEADER.FIELDS (FROM)', struct: false });
            const seen = new Map();
            f.on('message', (msg) => {
              msg.on('body', (stream) => {
                let raw = '';
                stream.on('data', d => raw += d);
                stream.on('end', () => {
                  const match = raw.match(/From:\s*(.*)/i);
                  if (!match) return;
                  const full = match[1].trim();
                  const detailed = full.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
                  let name, email;
                  if (detailed) { name = detailed[1].trim(); email = detailed[2].trim().toLowerCase(); }
                  else { email = full.replace(/[<>]/g, '').trim().toLowerCase(); name = email; }
                  if (!seen.has(email)) {
                    const domain = email.split('@')[1] || '';
                    const company = domain.replace(/\.(com|fr|io|net|org|co\.uk|eu)$/i, '').replace(/[-_]/g, ' ');
                    seen.set(email, { name, email, company });
                  }
                });
              });
            });
            f.once('error', () => { imap.end(); resolve([]); });
            f.once('end', () => { imap.end(); resolve([...seen.values()]); });
          });
        });
      });
      imap.once('error', reject);
      imap.connect();
    });
    contacts.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ contacts });
  } catch (err) {
    console.error('Erreur IMAP contacts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// PROPOSAL ENGINE — recherche deals HubSpot
// =============================================================================

// GET /api/proposal/deals
// Retourne tous les deals open du pipeline (filtrés côté client pour le "commence par")
// retourne id + dealname + company + stage
app.get('/api/proposal/deals', async (req, res) => {
  try {
    const stageIds = KANBAN_STAGES.map(s => s.id);
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_is_closed', operator: 'EQ',  value: 'false' },
          { propertyName: 'pipeline',     operator: 'EQ',  value: 'default' },
          { propertyName: 'dealstage',    operator: 'IN',  values: stageIds },
        ],
      }],
      properties: ['dealname', 'dealstage', 'amount'],
      associations: ['companies'],
      limit: 100,
    };

    const result = await hubspotSearch(body);
    const deals  = result.results || [];

    // Résoudre les noms d'entreprises associées
    const companyIds = [];
    const dealToCompanyId = {};
    for (const deal of deals) {
      const assoc = deal.associations?.companies?.results?.[0];
      if (assoc) {
        dealToCompanyId[deal.id] = assoc.id;
        companyIds.push(assoc.id);
      }
    }

    // Batch fetch des entreprises (une seule requête)
    const companyNames = {};
    if (companyIds.length > 0) {
      const batchPayload = JSON.stringify({ inputs: companyIds.map(id => ({ id })), properties: ['name'] });
      const companyData  = await new Promise((resolve, reject) => {
        let reqPath = '/crm/v3/objects/companies/batch/read';
        const options = {
          hostname: HUBSPOT_HOST,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(batchPayload) },
        };
        reqPath = addAuth(options, reqPath);
        options.path = reqPath;
        const req = https.request(options, (r) => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ results: [] }); }
          });
        });
        req.on('error', reject);
        req.write(batchPayload);
        req.end();
      });
      for (const c of (companyData.results || [])) {
        companyNames[c.id] = c.properties?.name || '';
      }
    }

    const stageLabel = {};
    for (const s of KANBAN_STAGES) stageLabel[s.id] = s.label;

    const output = deals.map(deal => ({
      id:       deal.id,
      dealname: deal.properties.dealname || '',
      company:  companyNames[dealToCompanyId[deal.id]] || '',
      stage:    stageLabel[deal.properties.dealstage] || deal.properties.dealstage || '',
      amount:   deal.properties.amount ? parseFloat(deal.properties.amount) : null,
    }));

    res.json(output);
  } catch (e) {
    console.error('[Proposal search]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// PROPOSAL ENGINE — génération PPTX en Node.js (adm-zip)
// =============================================================================

const PROPOSAL_TEMPLATE_PATH = process.env.PROPOSAL_TEMPLATE_PATH ||
  path.join(__dirname, 'proposal_engine', 'Template master proposition v3.pptx');
const PROPOSAL_CONFIG_PATH = path.join(__dirname, 'proposal_engine', 'slide_config.json');

const PROPOSAL_MISSION_MAP = {
  'Bilan Carbone':   { section: 'Bilan_Carbone', cal: 'Bilan Carbone', fin: 'Bilan_Carbone',   intitule: "Mesure de l'empreinte carbone",  nature: 'Standard',        langueAuto: 'FR' },
  'ACV':             { section: 'ACV',            cal: 'ACV',           fin: 'ACV',             intitule: 'Analyse de Cycle de Vie',         nature: 'Standard',        langueAuto: 'FR' },
  'FDES / PEP':      { section: 'FDES_PEP',       cal: 'FDES_PEP',      fin: 'FDES_PEP',        intitule: 'FDES / PEP',                      nature: 'Standard',        langueAuto: 'FR' },
  'EPD':             { section: 'EPD',             cal: 'EPD',           fin: 'EPD',             intitule: 'Environmental Product Declaration',nature: 'Standard',        langueAuto: 'EN' },
  'Outil sur-mesure':{ section: null,              cal: null,            fin: 'Outil_sur_mesure', intitule: 'Outil sur-mesure',                nature: 'Outil_sur_mesure', langueAuto: 'FR' },
};

const PROPOSAL_SUBVENTION = {
  Rev3_50pct: { label: 'Booster Transformation – Rev3 (50%)',       programme: 'Booster Transformation',  operateur: 'Rev3',      pct: '50%' },
  BPI_40pct:  { label: "Diag Décarbon'Action – Bpifrance (40%)",   programme: "Diag Décarbon'Action",    operateur: 'Bpifrance', pct: '40%' },
  Rev3_30pct: { label: 'Booster Transformation – Rev3 (30%)',       programme: 'Booster Transformation',  operateur: 'Rev3',      pct: '30%' },
  BPI_70pct:  { label: 'Diag Ecoconception – Bpifrance (70%)',      programme: 'Diag Ecoconception',      operateur: 'Bpifrance', pct: '70%' },
  BPI_60pct:  { label: 'Diag Ecoconception – Bpifrance (60%)',      programme: 'Diag Ecoconception',      operateur: 'Bpifrance', pct: '60%' },
  standard:   { label: 'Sans subvention',                           programme: '',                        operateur: '',          pct: '' },
};

function proposalSlidesToKeep(mission, subKey, langue, config) {
  const m    = PROPOSAL_MISSION_MAP[mission];
  const keep = new Set();

  // Slide 1 — couverture
  keep.add(0);

  // Intro : FR → slides 2-9, EN → slides 10-17
  const introSlides = config.sections.introduction.slides_per_langue[langue];
  introSlides.forEach(s => keep.add(s - 1));

  // Contexte : header slide 18 + slide 19 (FR) ou 20 (EN)
  keep.add(config.sections.contexte.section_header_slide - 1);
  keep.add(config.sections.contexte.slide_per_langue[langue] - 1);

  // Méthodo
  if (m.nature === 'Outil_sur_mesure') {
    config.sections.methodo.blocs.Outil_sur_mesure.slides.forEach(s => keep.add(s - 1));
  } else {
    config.sections.methodo.blocs[m.section].slides.forEach(s => keep.add(s - 1));
  }

  // Calendrier : seulement pour les missions Standard
  if (m.nature === 'Standard') {
    keep.add(config.sections.calendrier.section_header_slide - 1);
    keep.add(config.sections.calendrier.slides_per_mission[m.cal] - 1);
  }

  // Proposition financière : header + slide selon combinaison
  keep.add(config.sections.proposition_financiere.section_header_slide - 1);
  const finEntry = config.sections.proposition_financiere.slides_per_combinaison[m.fin];
  if (typeof finEntry === 'object' && finEntry.slide) {
    keep.add(finEntry.slide - 1);
  } else if (finEntry && finEntry.options) {
    const slideNum = finEntry.options[subKey] || Object.values(finEntry.options)[0];
    keep.add(slideNum - 1);
  }

  return keep;
}

function proposalDeleteSlides(zip, keepIndices) {
  const presXml    = zip.readAsText('ppt/presentation.xml');
  const presRels   = zip.readAsText('ppt/_rels/presentation.xml.rels');
  let   ctypes     = zip.readAsText('[Content_Types].xml');

  // Ordered rIds from sldIdLst
  const listMatch = presXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (!listMatch) return;
  const rIds = [], sldEntries = [];
  const sldPat = /<p:sldId\b[^>]*\/>/g;
  let m;
  while ((m = sldPat.exec(listMatch[1])) !== null) {
    const rIdM = m[0].match(/r:id="([^"]+)"/);
    if (rIdM) { rIds.push(rIdM[1]); sldEntries.push(m[0]); }
  }

  // rId → slide file target
  const rIdToTarget = {};
  const relPat = /<Relationship\b[^>]*\/>/g;
  while ((m = relPat.exec(presRels)) !== null) {
    const rel = m[0];
    const id  = (rel.match(/\bId="([^"]+)"/) || [])[1];
    const tgt = (rel.match(/\bTarget="([^"]+)"/) || [])[1];
    const typ = (rel.match(/\bType="([^"]+)"/) || [])[1];
    if (id && tgt && typ && typ.endsWith('/slide')) rIdToTarget[id] = tgt;
  }

  let newPres = presXml, newRels = presRels;
  rIds.forEach((rId, idx) => {
    if (keepIndices.has(idx)) return;
    const tgt = rIdToTarget[rId];
    if (!tgt) return;
    const slidePath = `ppt/${tgt}`;
    const slideName = tgt.split('/').pop();
    const relsPath  = `ppt/slides/_rels/${slideName}.rels`;
    try { zip.deleteFile(slidePath); }  catch(_) {}
    try { zip.deleteFile(relsPath); }   catch(_) {}
    newPres = newPres.replace(sldEntries[idx], '');
    newRels = newRels.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${rId}"[^>]*\\/>`, 'g'), '');
    ctypes  = ctypes.replace(new RegExp(`<Override[^>]*PartName="/ppt/slides/${slideName.replace('.', '\\.')}"[^>]*\\/>`, 'g'), '');
  });

  zip.updateFile('ppt/presentation.xml',          Buffer.from(newPres,  'utf8'));
  zip.updateFile('ppt/_rels/presentation.xml.rels', Buffer.from(newRels, 'utf8'));
  zip.updateFile('[Content_Types].xml',            Buffer.from(ctypes,   'utf8'));
}

function proposalReplaceText(zip, replacements) {
  zip.getEntries().forEach(entry => {
    const name = entry.entryName;
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) return;
    let content = zip.readAsText(name), changed = false;
    for (const [k, v] of Object.entries(replacements)) {
      if (content.includes(k)) { content = content.split(k).join(v || ''); changed = true; }
    }
    if (changed) zip.updateFile(name, Buffer.from(content, 'utf8'));
  });
}

function getLogoPixelDims(buf) {
  // PNG : dimensions aux octets 16-23
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG : chercher marqueur SOF0/SOF1/SOF2
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const mk = buf[i + 1];
      if (mk === 0xC0 || mk === 0xC1 || mk === 0xC2) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Corrige le ratio de toutes les p:pic référençant un rId donné dans un XML
function _fixPicRatio(xml, rId, imgAR) {
  const picPat = /<p:pic\b[\s\S]*?<\/p:pic>/g;
  let picM, count = 0;
  while ((picM = picPat.exec(xml)) !== null) {
    if (!picM[0].includes(`r:embed="${rId}"`)) continue;
    const offM = picM[0].match(/<a:off\b[^>]*x="(-?\d+)"[^>]*y="(-?\d+)"/);
    const extM = picM[0].match(/<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (!offM || !extM) continue;
    const origX = parseInt(offM[1]), origY = parseInt(offM[2]);
    const origCx = parseInt(extM[1]), origCy = parseInt(extM[2]);
    const boxAR = origCx / origCy;
    let newCx, newCy, newX, newY;
    if (imgAR > boxAR) {
      newCx = origCx; newCy = Math.round(origCx / imgAR);
      newX = origX;   newY  = origY + Math.round((origCy - newCy) / 2);
    } else {
      newCy = origCy; newCx = Math.round(origCy * imgAR);
      newY  = origY;  newX  = origX + Math.round((origCx - newCx) / 2);
    }
    const updated = picM[0]
      .replace(/<a:off\b[^>]*x="-?\d+"[^>]*y="-?\d+"/, `<a:off x="${newX}" y="${newY}"`)
      .replace(/<a:ext\b[^>]*cx="\d+"[^>]*cy="\d+"/, `<a:ext cx="${newCx}" cy="${newCy}"`);
    xml = xml.replace(picM[0], updated);
    count++;
  }
  return { xml, count };
}

function proposalReplaceLogo(zip, logoBuffer) {
  try {
    let slide1Xml    = zip.readAsText('ppt/slides/slide1.xml');
    const slide1Rels = zip.readAsText('ppt/slides/_rels/slide1.xml.rels');

    // Dernier r:embed dans slide1 = logo client
    const blipPat = /<a:blip\b[^>]*r:embed="([^"]+)"/g;
    let bm, lastRId;
    while ((bm = blipPat.exec(slide1Xml)) !== null) lastRId = bm[1];
    if (!lastRId) { console.warn('[Proposal] Logo: aucun blip trouvé'); return; }

    // Résoudre le fichier média via les rels de slide1
    const relEntries = slide1Rels.match(/<Relationship\b[^>]*\/>/g) || [];
    let slideTarget = null;
    for (const rel of relEntries) {
      if (rel.includes(`Id="${lastRId}"`)) {
        const m = rel.match(/Target="([^"]+)"/);
        if (m) { slideTarget = m[1]; break; }
      }
    }
    if (!slideTarget) { console.warn('[Proposal] Logo: relation introuvable pour', lastRId); return; }

    // Chemin absolu ZIP du fichier média (ex: ppt/media/image2.png)
    const mediaPath = `ppt/${slideTarget.replace(/^\.\.\//, '')}`;
    const entry = zip.getEntry(mediaPath);
    if (!entry) { console.warn('[Proposal] Logo: entrée ZIP introuvable:', mediaPath); return; }

    // Remplacer les bytes de l'image (affecte toutes les shapes qui référencent ce fichier)
    zip.updateFile(mediaPath, logoBuffer);

    const dims = getLogoPixelDims(logoBuffer);
    if (!dims) { console.log('[Proposal] Logo: remplacé (format non reconnu, pas de resize)'); return; }
    const imgAR = dims.w / dims.h;

    // --- Corriger slide1.xml ---
    const r1 = _fixPicRatio(slide1Xml, lastRId, imgAR);
    slide1Xml = r1.xml;
    zip.updateFile('ppt/slides/slide1.xml', Buffer.from(slide1Xml, 'utf8'));

    // --- Corriger slideMaster1.xml (le logo peut aussi apparaître dans le master) ---
    const masterXmlPath = 'ppt/slideMasters/slideMaster1.xml';
    const masterRelsPath = 'ppt/slideMasters/_rels/slideMaster1.xml.rels';
    try {
      let masterXml  = zip.readAsText(masterXmlPath);
      const masterRels = zip.readAsText(masterRelsPath);
      // Trouver le rId du master qui pointe vers le même fichier média
      const mediaFilename = mediaPath.replace('ppt/media/', '');
      const masterRelEntries = masterRels.match(/<Relationship\b[^>]*\/>/g) || [];
      let masterRId = null;
      for (const rel of masterRelEntries) {
        if (rel.includes(mediaFilename)) {
          const m = rel.match(/Id="([^"]+)"/);
          if (m) { masterRId = m[1]; break; }
        }
      }
      if (masterRId) {
        const r2 = _fixPicRatio(masterXml, masterRId, imgAR);
        masterXml = r2.xml;
        zip.updateFile(masterXmlPath, Buffer.from(masterXml, 'utf8'));
        console.log(`[Proposal] Logo: ratio corrigé slide1(${r1.count}) + master(${r2.count}) ✓`);
      } else {
        console.log(`[Proposal] Logo: ratio corrigé slide1(${r1.count}) [pas dans master] ✓`);
      }
    } catch(_) {
      console.log(`[Proposal] Logo: ratio corrigé slide1(${r1.count}) [master inaccessible] ✓`);
    }
  } catch(e) { console.warn('[Proposal] Logo erreur:', e.message); }
}

// Enrichissement SIRENE via API Data.gouv (gratuit, sans clé)
async function fetchSireneData(siren) {
  if (!siren || !/^\d{9}$/.test(siren.replace(/\s/g, ''))) return null;
  const cleanSiren = siren.replace(/\s/g, '');
  try {
    const resp = await fetch(
      `https://recherche-entreprises.api.gouv.fr/search?q=${cleanSiren}&page=1&per_page=1`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const r = data?.results?.[0];
    if (!r) return null;
    const naf    = r.activite_principale || '';
    const libNaf = r.libelle_activite_principale || '';
    const taille = r.tranche_effectif_salarie || '';
    const TAILLE_MAP = {
      '00':'0 salarié','01':'1-2','02':'3-5','03':'6-9','11':'10-19','12':'20-49',
      '21':'50-99','22':'100-199','31':'200-249','32':'250-499','41':'500-999',
      '42':'1000-1999','51':'2000-4999','52':'5000-9999','53':'10000+',
    };
    const tailleLib = TAILLE_MAP[taille] ? `${TAILLE_MAP[taille]} salariés` : '';
    const lines = [
      `Raison sociale : ${r.nom_complet || ''}`,
      naf     ? `Code NAF : ${naf} — ${libNaf}` : '',
      tailleLib ? `Effectif : ${tailleLib}` : '',
      r.siege?.code_postal ? `Siège : ${r.siege.libelle_commune || ''} (${r.siege.code_postal})` : '',
    ].filter(Boolean);
    console.log('[Proposal SIRENE] données récupérées pour', cleanSiren);
    return lines.join('\n');
  } catch(e) {
    console.warn('[Proposal SIRENE] Erreur:', e.message);
    return null;
  }
}

// Appel Claude API pour générer les placeholders de contexte client
async function proposalGenerateAIContext({ nom_entreprise, mission, nature, langue, contexte_consultant, siren_data, config }) {
  const fallback = config.ai_personalization.fallback_si_erreur;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Proposal AI] ANTHROPIC_API_KEY absente — fallback');
    return fallback;
  }

  const userPrompt = config.ai_personalization.prompt_utilisateur_template
    .replace('{nom_entreprise}',     nom_entreprise       || '')
    .replace('{type_mission}',       mission              || '')
    .replace('{nature_mission}',     nature               || 'Standard')
    .replace('{langue}',             langue               || 'FR')
    .replace('{siren_data}',         siren_data           || 'Non renseigné')
    .replace('{contexte_consultant}',contexte_consultant  || '');

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      config.ai_personalization.model_recommande,
        max_tokens: config.ai_personalization.max_tokens,
        system:     config.ai_personalization.prompt_systeme,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      console.warn('[Proposal AI] HTTP', resp.status, '— fallback');
      return fallback;
    }

    const data = await resp.json();
    let text = data?.content?.[0]?.text?.trim() || '';
    // Claude entoure parfois le JSON de backticks malgré l'instruction — on les retire
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!text) throw new Error('Réponse vide');
    const parsed = JSON.parse(text);
    console.log('[Proposal AI] contexte généré ✓', Object.keys(parsed));
    return { ...fallback, ...parsed };
  } catch(e) {
    console.warn('[Proposal AI] Erreur:', e.message, '— fallback');
    return fallback;
  }
}

// Conversion PPTX → PDF via PowerPoint COM automation (PowerShell)
const PROPOSAL_TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(PROPOSAL_TMP_DIR)) fs.mkdirSync(PROPOSAL_TMP_DIR);

async function convertPptxToPdfCloudConvert(pptxBuffer) {
  const apiKey = process.env.CLOUDCONVERT_API_KEY;
  if (!apiKey) throw new Error('CLOUDCONVERT_API_KEY non configurée');

  // Créer un job : upload → convert → export
  const jobRes = await fetch('https://api.cloudconvert.com/v2/jobs', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tasks: {
        'upload':  { operation: 'import/upload' },
        'convert': { operation: 'convert', input: 'upload', input_format: 'pptx', output_format: 'pdf' },
        'export':  { operation: 'export/url', input: 'convert' },
      },
    }),
  });
  if (!jobRes.ok) throw new Error('CloudConvert: erreur création job (' + jobRes.status + ')');
  const job = await jobRes.json();
  const jobId = job.data.id;
  const uploadTask = job.data.tasks.find(t => t.name === 'upload');

  // Uploader le PPTX vers l'URL presignée
  const { url: uploadUrl, parameters: uploadParams } = uploadTask.result.form;
  const form = new FormData();
  for (const [k, v] of Object.entries(uploadParams)) form.append(k, v);
  form.append('file', new Blob([pptxBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }), 'presentation.pptx');
  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error('CloudConvert: erreur upload (' + uploadRes.status + ')');

  // Attendre la fin du job (poll toutes les 2s, max 60s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await fetch(`https://api.cloudconvert.com/v2/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const status = await statusRes.json();
    if (status.data.status === 'error') throw new Error('CloudConvert: conversion échouée');
    const exportTask = status.data.tasks.find(t => t.name === 'export');
    if (exportTask?.status === 'finished') {
      const pdfUrl = exportTask.result.files[0].url;
      const pdfRes = await fetch(pdfUrl);
      const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
      console.log('[Proposal PDF] CloudConvert OK', Math.round(pdfBuf.length / 1024), 'KB');
      return pdfBuf;
    }
  }
  throw new Error('CloudConvert: timeout');
}

async function convertPptxToPdf(pptxBuffer) {
  const id       = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const pptxPath = path.join(PROPOSAL_TMP_DIR, `${id}.pptx`);
  const pdfPath  = path.join(PROPOSAL_TMP_DIR, `${id}.pdf`);

  if (process.platform === 'win32') {
    // Windows : PowerShell + COM PowerPoint
    fs.writeFileSync(pptxPath, pptxBuffer);
    try {
      const pptxEsc = pptxPath.replace(/\\/g, '\\\\');
      const pdfEsc  = pdfPath.replace(/\\/g, '\\\\');
      const psScript = `
$ErrorActionPreference = 'Stop'
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open('${pptxEsc}', $true, $false, $false)
  $pres.SaveAs('${pdfEsc}', 32)
  $pres.Close()
} finally {
  $ppt.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
}
`.trim();
      await new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { timeout: 45000 },
          (err, stdout, stderr) => {
            if (err) reject(new Error(stderr?.trim() || err.message));
            else resolve();
          }
        );
      });
      const pdf = fs.readFileSync(pdfPath);
      console.log('[Proposal PDF] conversion OK', Math.round(pdf.length / 1024), 'KB');
      return pdf;
    } finally {
      try { fs.unlinkSync(pptxPath); } catch(_) {}
      try { fs.unlinkSync(pdfPath);  } catch(_) {}
    }
  } else {
    // Linux : CloudConvert API
    return convertPptxToPdfCloudConvert(pptxBuffer);
  }
}

// GET /api/proposal/siren-search?q=... — autocomplete SIREN ou raison sociale (Data.gouv, 5 résultats)
app.get('/api/proposal/siren-search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Requête trop courte' });
  const TAILLE_MAP = {
    '00':'0 salarié','01':'1-2 sal.','02':'3-5 sal.','03':'6-9 sal.',
    '11':'10-19 sal.','12':'20-49 sal.','21':'50-99 sal.','22':'100-199 sal.',
    '31':'200-249 sal.','32':'250-499 sal.','41':'500-999 sal.',
    '42':'1 000-1 999 sal.','51':'2 000-4 999 sal.','52':'5 000-9 999 sal.','53':'10 000+ sal.',
  };
  try {
    const resp = await fetch(
      `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(q.trim())}&page=1&per_page=5`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return res.status(502).json({ error: 'Data.gouv indisponible' });
    const data = await resp.json();
    const results = (data?.results || []).map(r => ({
      siren:     r.siren || '',
      nom:       r.nom_complet || '',
      naf_code:  r.activite_principale || '',
      naf_label: r.libelle_activite_principale || '',
      effectif:  TAILLE_MAP[r.tranche_effectif_salarie || ''] || '',
      ville:     r.siege?.libelle_commune || '',
      code_postal: r.siege?.code_postal || '',
      adresse:   r.siege?.adresse || '',
    }));
    res.json({ results });
  } catch(e) {
    console.warn('[Proposal SIRENE search]', e.message);
    res.status(504).json({ error: 'Timeout ou erreur réseau' });
  }
});

// POST /api/proposal/ai-context — prévisualisation du contexte IA sans générer le PPTX
app.post('/api/proposal/ai-context', express.json(), async (req, res) => {
  try {
    const { mission, langue: langueInput, contexte_consultant, siren, nom_entreprise } = req.body || {};
    const mInf = PROPOSAL_MISSION_MAP[mission];
    if (!mInf) return res.status(400).json({ error: `Mission inconnue : ${mission}` });

    const langue = (langueInput === 'FR' || langueInput === 'EN') ? langueInput : mInf.langueAuto;
    const config = JSON.parse(fs.readFileSync(PROPOSAL_CONFIG_PATH, 'utf8'));

    const siren_data = await fetchSireneData(siren);

    const aiCtx = await proposalGenerateAIContext({
      nom_entreprise: nom_entreprise || '',
      mission, nature: mInf.nature, langue,
      contexte_consultant: contexte_consultant || '',
      siren_data,
      config,
    });

    res.json({ ok: true, context: aiCtx, langue });
  } catch(e) {
    console.error('[Proposal AI context]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/proposal/config
app.get('/api/proposal/config', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(PROPOSAL_CONFIG_PATH, 'utf8'));
    const result = {};
    for (const mission of Object.keys(PROPOSAL_MISSION_MAP)) {
      const m = PROPOSAL_MISSION_MAP[mission];
      if (m.nature === 'Outil_sur_mesure') {
        result[mission] = [{ key: 'standard', label: 'Sans subvention' }];
        continue;
      }
      const finEntry = config.sections.proposition_financiere.slides_per_combinaison[m.fin];
      const subKeys = (finEntry && typeof finEntry === 'object' && finEntry.options)
        ? Object.keys(finEntry.options)
        : ['standard'];
      result[mission] = subKeys.map(k => ({ key: k, label: (PROPOSAL_SUBVENTION[k] || {}).label || k }));
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/proposal/generate
app.post('/api/proposal/generate', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const {
      nom_entreprise, mission, subvention = 'standard', logo_base64,
      langue: langueInput, montant_ht, deal_id,
      contexte_consultant, siren,
      ai_context,
      format = 'pptx',
    } = req.body || {};

    if (!nom_entreprise?.trim()) return res.status(400).json({ error: "Nom de l'entreprise requis" });
    const mInf = PROPOSAL_MISSION_MAP[mission];
    if (!mInf) return res.status(400).json({ error: `Mission inconnue : ${mission}` });
    if (!fs.existsSync(PROPOSAL_TEMPLATE_PATH))
      return res.status(500).json({ error: `Template PPTX introuvable. Définir PROPOSAL_TEMPLATE_PATH dans .env` });

    // Langue : forcée par l'utilisateur ou auto selon la mission
    const langue = (langueInput === 'FR' || langueInput === 'EN') ? langueInput : mInf.langueAuto;

    const config = JSON.parse(fs.readFileSync(PROPOSAL_CONFIG_PATH, 'utf8'));

    // Contexte IA : utiliser le contexte pré-calculé si fourni, sinon appeler Claude
    const keep = proposalSlidesToKeep(mission, subvention, langue, config);
    let aiCtx;
    if (ai_context) {
      aiCtx = ai_context;
    } else {
      const siren_data = await fetchSireneData(siren);
      aiCtx = await proposalGenerateAIContext({
        nom_entreprise: nom_entreprise.trim(),
        mission, nature: mInf.nature, langue,
        contexte_consultant: contexte_consultant || '',
        siren_data,
        config,
      });
    }

    const zip = new AdmZip(PROPOSAL_TEMPLATE_PATH);
    proposalDeleteSlides(zip, keep);

    const sub = PROPOSAL_SUBVENTION[subvention] || PROPOSAL_SUBVENTION.standard;
    const pctNum = parseInt(sub.pct) || 0;
    const complementPct = pctNum > 0 ? String(100 - pctNum) : '';

    proposalReplaceText(zip, {
      '{{NOM_ENTREPRISE}}':          nom_entreprise.trim(),
      '{{TYPE_MISSION}}':            mission,
      '{{PROGRAMME_SUBVENTION}}':    sub.programme,
      '{{OPERATEUR_SUBVENTION}}':    sub.operateur,
      '{{POURCENTAGE_SUBVENTION}}':  sub.pct,
      '{{COMPLEMENT_POURCENTAGE}}':  complementPct,
      '{{MONTANT_SUBVENTION}}':      '',
      '{{PRIX_APRES_SUBVENTION}}':   '',
      '{{INTITULE_MISSION}}':        mInf.intitule,
      '{{MONTANT}}':                 montant_ht ? String(montant_ht) : '',
      '{{CONTEXTE_CLIENT}}':         aiCtx.CONTEXTE_CLIENT         || '',
      '{{ENJEU_1}}':                 aiCtx.ENJEU_1                 || '',
      '{{ENJEU_2}}':                 aiCtx.ENJEU_2                 || '',
      '{{ENJEU_3}}':                 aiCtx.ENJEU_3                 || '',
      '{{POURQUOI_MAINTENANT}}':     aiCtx.POURQUOI_MAINTENANT     || '',
      '{{NOTE_CONTEXTE}}':           aiCtx.NOTE_CONTEXTE           || '',
      '{{CONTEXTE_METIER}}':         aiCtx.CONTEXTE_METIER         || '',
      '{{ENJEUX_DATA}}':             aiCtx.ENJEUX_DATA             || '',
      '{{PERIMETRE_OUTIL}}':         aiCtx.PERIMETRE_OUTIL         || '',
    });

    if (logo_base64) proposalReplaceLogo(zip, Buffer.from(logo_base64, 'base64'));

    const safeName = nom_entreprise.trim().replace(/[^a-zA-Z0-9 _\-éèêëàâùûüôîïç]/gi, '').trim();
    const pptxBuf  = zip.toBuffer();

    // Sauvegarde automatique dans deal_metadata + Supabase Storage si un deal est lié
    if (deal_id) {
      const storagePath = `${deal_id}.pptx`;
      (async () => {
        // Créer le bucket s'il n'existe pas
        try {
          const { error: bucketErr } = await supabaseAdmin.storage.createBucket('proposals', { public: false });
          if (bucketErr && !bucketErr.message.includes('already exists')) {
            console.warn('[Proposal] Storage createBucket:', bucketErr.message);
          }
        } catch(e) {}

        let uploadOk = false;
        try {
          const { error: upErr } = await supabaseAdmin.storage
            .from('proposals')
            .upload(storagePath, pptxBuf, {
              contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              upsert: true,
            });
          if (upErr) console.warn('[Proposal] Storage upload:', upErr.message);
          else uploadOk = true;
        } catch(e) { console.warn('[Proposal] Storage upload exception:', e.message); }

        const { error: dbErr } = await supabaseAdmin.from('deal_metadata').upsert({
          deal_id,
          proposal_sent_at:      new Date().toISOString(),
          proposal_mission:      mission,
          proposal_nom:          nom_entreprise.trim(),
          proposal_storage_path: uploadOk ? storagePath : null,
          updated_at:            new Date().toISOString(),
        }, { onConflict: 'deal_id' });
        if (dbErr) console.warn('[Proposal] deal_metadata upsert:', dbErr.message);
      })();
    }

    if (format === 'pdf') {
      const pdfBuf = await convertPptxToPdf(pptxBuf);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Proposition_${safeName}.pdf"`);
      res.send(pdfBuf);
    } else {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      res.setHeader('Content-Disposition', `attachment; filename="Proposition_${safeName}.pptx"`);
      res.send(pptxBuf);
    }
  } catch(e) {
    console.error('[Proposal]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/proposal/redownload/:deal_id?format=pptx|pdf
app.get('/api/proposal/redownload/:deal_id', async (req, res) => {
  try {
    const { deal_id } = req.params;
    const format = req.query.format === 'pdf' ? 'pdf' : 'pptx';

    const { data: meta, error: metaErr } = await supabaseAdmin
      .from('deal_metadata')
      .select('proposal_storage_path, proposal_nom, proposal_mission')
      .eq('deal_id', deal_id)
      .single();

    if (metaErr || !meta?.proposal_storage_path) {
      return res.status(404).json({ error: 'Aucune propale stockée pour ce deal' });
    }

    const { data: fileData, error: dlErr } = await supabaseAdmin.storage
      .from('proposals')
      .download(meta.proposal_storage_path);

    if (dlErr || !fileData) return res.status(404).json({ error: 'Fichier introuvable dans le storage' });

    const pptxBuf = Buffer.from(await fileData.arrayBuffer());
    const safeName = (meta.proposal_nom || 'Proposition').replace(/[^a-zA-Z0-9 _\-éèêëàâùûüôîïç]/gi, '').trim();

    if (format === 'pdf') {
      const pdfBuf = await convertPptxToPdf(pptxBuf);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Proposition_${safeName}.pdf"`);
      res.send(pdfBuf);
    } else {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      res.setHeader('Content-Disposition', `attachment; filename="Proposition_${safeName}.pptx"`);
      res.send(pptxBuf);
    }
  } catch(e) {
    console.error('[Proposal redownload]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/regenerate-sales-nav-urls — Force-regenerate all campaign URLs (admin only)
app.post('/api/admin/regenerate-sales-nav-urls', accountContext, async (req, res) => {
  try {
    if (!req.account?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const { data: campaigns } = await supabaseAdmin
      .from('campaigns')
      .select('id, name, criteria, sales_nav_url')
      .not('criteria', 'is', null);

    const results = [];
    for (const camp of (campaigns || [])) {
      try {
        const c = camp.criteria;
        if (!c || typeof c !== 'object') continue;
        const hasCriteria = (c.jobTitles?.length || c.seniorities?.length || c.geoIds?.length || c.sectorIds?.length || c.headcounts?.length);
        const newUrl = hasCriteria ? buildSalesNavUrl(c) : null;
        if (newUrl !== camp.sales_nav_url) {
          await supabaseAdmin.from('campaigns').update({ sales_nav_url: newUrl }).eq('id', camp.id);
          results.push({ id: camp.id, name: camp.name, old_had_keywords: (camp.sales_nav_url || '').includes('keywords:'), updated: true });
        }
      } catch (e) {
        results.push({ id: camp.id, name: camp.name, error: e.message });
      }
    }
    res.json({ total: (campaigns || []).length, updated: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/purge-incomplete-prospects — Bulk delete incomplete prospects (admin only)
app.delete('/api/admin/purge-incomplete-prospects', accountContext, async (req, res) => {
  try {
    if (!req.account?.is_admin) return res.status(403).json({ error: 'Admin only' });

    const { campaign_id, created_after, created_before, dry_run } = req.query;

    let query = supabaseAdmin.from('prospects')
      .select('id, first_name, last_name, sales_nav_url, campaign_id, created_at', { count: 'exact' })
      .eq('account_id', req.accountId)
      .eq('status', 'Profil incomplet');

    if (campaign_id) query = query.eq('campaign_id', campaign_id);
    if (created_after) query = query.gte('created_at', created_after);
    if (created_before) query = query.lte('created_at', created_before);

    const { data: targets, count, error: selectErr } = await query;
    if (selectErr) throw selectErr;

    if (dry_run === 'true') {
      return res.json({
        dry_run: true,
        would_delete: count,
        sample: (targets || []).slice(0, 5).map(p => ({ id: p.id, name: `${p.first_name} ${p.last_name}`, created_at: p.created_at })),
      });
    }

    if (!targets?.length) return res.json({ deleted: 0, message: 'No matching prospects found' });

    const ids = targets.map(p => p.id);

    // Delete related records first (status_history, interactions)
    await supabaseAdmin.from('status_history').delete().in('prospect_id', ids);
    await supabaseAdmin.from('interactions').delete().in('prospect_id', ids);

    // Delete prospects in batches of 100
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const { error: delErr } = await supabaseAdmin.from('prospects').delete()
        .eq('account_id', req.accountId)
        .in('id', batch);
      if (delErr) throw delErr;
      deleted += batch.length;
    }

    console.log(`[Admin] Purged ${deleted} incomplete prospects (campaign: ${campaign_id || 'all'}, after: ${created_after || 'any'})`);
    res.json({ deleted, campaign_id: campaign_id || 'all', filters: { created_after, created_before } });
  } catch (err) {
    console.error('Erreur /api/admin/purge-incomplete-prospects:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Releaf Pilot démarré sur http://localhost:${PORT}`);

  // Regenerate all sales_nav_url to purge stale keyword-contaminated URLs
  try {
    const { data: campaigns } = await supabaseAdmin
      .from('campaigns')
      .select('id, name, criteria, sales_nav_url')
      .not('criteria', 'is', null);

    let updated = 0;
    for (const camp of (campaigns || [])) {
      try {
        const c = camp.criteria;
        if (!c || typeof c !== 'object') continue;
        const hasCriteria = (c.jobTitles?.length || c.seniorities?.length || c.geoIds?.length || c.sectorIds?.length || c.headcounts?.length);
        const newUrl = hasCriteria ? buildSalesNavUrl(c) : null;
        if (newUrl !== camp.sales_nav_url) {
          await supabaseAdmin.from('campaigns').update({ sales_nav_url: newUrl }).eq('id', camp.id);
          updated++;
          console.log(`[startup] Updated sales_nav_url for "${camp.name}" (id=${camp.id})`);
        }
      } catch (e) {
        console.error(`[startup] Error regenerating URL for campaign ${camp.id}:`, e.message);
      }
    }
    console.log(`[startup] sales_nav_url regeneration done: ${updated} updated out of ${(campaigns || []).length}`);
  } catch (err) {
    console.error('[startup] Failed to regenerate sales_nav_url:', err.message);
  }
});
