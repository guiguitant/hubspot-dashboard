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

async function fetchAllNotionMissions() {
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

  return allPages.map(page => {
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
    };
  });
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

async function buildPrevisionnel({ qontoData, pipelineDeals, notionMissions, salaries, revenus, chargesFixesExtras, pipelineFactor, fictionalDeals }) {
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

  const previsionnelFinal = qontoData.previsionnel.map((mois) => {
    const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
    const factEnvoye = Math.round(encaissementsEnvoye[mKey] || 0);
    const factPrev = Math.round(encaissementsPrev[mKey] || 0);
    const factRetard = Math.round(encaissementsRetard[mKey] || 0);
    const encaissementsFactures = factEnvoye + factPrev + factRetard;
    const revExc = Math.round(revenusParMois[mKey] || 0);
    const masse = masseSalarialeMois(mois.annee, mois.mois, salaries);
    const chargesFixesExtra = Math.round(chargesFixesParMois[mKey] || 0);
    const fictionalEnc = Math.round(fictionalEncaissements[mKey] || 0);
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
      decaissements: mois.decaissements + chargesFixesExtra,
      encaissementsTotal: mois.encaissements + encaissementsFactures + revExc + fictionalEnc,
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

    const result = await buildPrevisionnel({
      qontoData, pipelineDeals, notionMissions,
      salaries: allSalaries, revenus,
      chargesFixesExtras: [], pipelineFactor: 1, fictionalDeals: [],
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
  const validTypes = ['salaire', 'pipeline', 'charges_fixes', 'revenu_exceptionnel'];
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
  const [qontoData, pipelineDeals, notionMissions] = await Promise.all([
    buildTresorerieFromQonto(),
    fetchOpenDeals(),
    fetchAllNotionMissions(),
  ]);
  const { data: revenusExceptionnels } = await supabase.from('revenus_exceptionnels').select('*');
  const { data: salariesList } = await supabase.from('salaries').select('*');
  return {
    qontoData, pipelineDeals, notionMissions,
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
      case 'charges_fixes':
        chargesFixesExtras.push({
          libelle: d.libelle,
          montant_mensuel: d.montant_mensuel || 0,
          mois_debut: d.mois_debut,
          mois_fin: d.mois_fin,
        });
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

  return { salaries, revenus, chargesFixesExtras, pipelineFactor, fictionalDeals };
}

app.get('/api/scenarios/baseline/projection', async (req, res) => {
  try {
    const base = await fetchBaseData();
    const result = await buildPrevisionnel({
      qontoData: base.qontoData, pipelineDeals: base.pipelineDeals,
      notionMissions: base.notionMissions, salaries: base.salaries,
      revenus: base.revenus, chargesFixesExtras: [], pipelineFactor: 1, fictionalDeals: [],
    });
    res.json({ nom: 'Baseline', previsionnel: result.previsionnel });
  } catch (err) {
    console.error('Erreur baseline projection:', err.message);
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

app.listen(PORT, () => {
  console.log(`Releaf Pilot démarré sur http://localhost:${PORT}`);
});
