require('dotenv').config();
const express = require('express');
const https = require('https');
const path = require('path');

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
    // Toutes les missions non soldées + les missions de l'année en cours soldées
    const FACT_YEAR = new Date().getFullYear();
    const missions = allMissions.filter(m => {
      const norm = (m.facturation || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const isSolde = norm.includes('solde paye');
      if (!isSolde) return true;
      return m.anneeFinal === String(FACT_YEAR);
    });

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
      year: FACT_YEAR,
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

app.get('/api/tresorerie', async (req, res) => {
  try {
    // Fetch Qonto data + HubSpot pipeline + Notion missions in parallel
    const [qontoData, pipelineDeals, notionMissions] = await Promise.all([
      buildTresorerieFromQonto(),
      fetchOpenDeals(),
      fetchAllNotionMissions(),
    ]);

    // --- A encaisser depuis Notion (factures envoyées + prévisionnelles) ---
    const facturesAEncaisser = [];
    const now = new Date();

    for (const m of notionMissions) {
      if (m.ca <= 0) continue;
      const status = (m.facturation || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // Skip missions entièrement payées
      if (status.includes('solde paye')) continue;

      // Helper: calculer échéance J+45
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
            client: m.client || m.nom,
            mission: m.nom,
            type: 'Acompte',
            montant: m.montantAcompte,
            dateEmission,
            dateEcheance,
            status: isLate ? 'late' : 'upcoming',
            previsionnel: false,
          });
        } else if (status.includes('acompte a envoyer') || status === 'non defini') {
          const dateEmission = m.dateFactureAcompte;
          const dateEcheance = echeanceJ45(dateEmission);
          facturesAEncaisser.push({
            client: m.client || m.nom,
            mission: m.nom,
            type: 'Acompte',
            montant: m.montantAcompte,
            dateEmission,
            dateEcheance,
            status: 'previsionnel',
            previsionnel: true,
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
            client: m.client || m.nom,
            mission: m.nom,
            type: 'Solde',
            montant: montantSolde,
            dateEmission,
            dateEcheance,
            status: isLate ? 'late' : 'upcoming',
            previsionnel: false,
          });
        } else if (status.includes('acompte paye') || status.includes('solde a envoyer')
                   || status.includes('acompte a envoyer') || status === 'non defini') {
          const dateEmission = m.dateFactureFinale;
          const dateEcheance = echeanceJ45(dateEmission);
          facturesAEncaisser.push({
            client: m.client || m.nom,
            mission: m.nom,
            type: 'Solde',
            montant: montantSolde,
            dateEmission,
            dateEcheance,
            status: 'previsionnel',
            previsionnel: true,
          });
        }
      }
    }

    // Tri : envoyées d'abord (par échéance), puis prévisionnelles (par échéance)
    facturesAEncaisser.sort((a, b) => {
      if (a.previsionnel !== b.previsionnel) return a.previsionnel ? 1 : -1;
      return new Date(a.dateEcheance || '2099-12-31') - new Date(b.dateEcheance || '2099-12-31');
    });

    const totalEnvoye = facturesAEncaisser.filter(f => !f.previsionnel).reduce((s, f) => s + f.montant, 0);
    const totalPrevisionnel = facturesAEncaisser.filter(f => f.previsionnel).reduce((s, f) => s + f.montant, 0);
    const totalAEncaisserNotion = totalEnvoye + totalPrevisionnel;

    // Calcul du pipeline pondéré HubSpot
    let pipelinePondere = 0;
    const pipelineDetail = [];
    for (const stage of KANBAN_STAGES) {
      const deals = pipelineDeals[stage.label] || [];
      for (const deal of deals) {
        const weighted = deal.amount * (deal.probability / 100);
        pipelinePondere += weighted;
        pipelineDetail.push({
          name: deal.name,
          amount: deal.amount,
          probability: deal.probability,
          weighted: Math.round(weighted),
          stage: stage.label,
        });
      }
    }

    // Intégrer les factures à encaisser (envoyées + prévisionnelles) dans le prévisionnel
    // Chaque facture est placée dans le mois de son échéance estimée
    // Les factures sans date sont réparties sur le mois suivant
    const now2 = new Date();
    const moisCourantKey = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, '0')}`;
    const moisSuivant = new Date(now2.getFullYear(), now2.getMonth() + 1, 1);
    const moisSuivantKey = `${moisSuivant.getFullYear()}-${String(moisSuivant.getMonth() + 1).padStart(2, '0')}`;

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

    const previsionnelFinal = qontoData.previsionnel.map((mois) => {
      const mKey = `${mois.annee}-${String(mois.mois).padStart(2, '0')}`;
      const factEnvoye = Math.round(encaissementsEnvoye[mKey] || 0);
      const factPrev = Math.round(encaissementsPrev[mKey] || 0);
      const factRetard = Math.round(encaissementsRetard[mKey] || 0);
      const encaissementsFactures = factEnvoye + factPrev + factRetard;
      return {
        ...mois,
        encaissementsFactures,
        encaissementsEnvoye: factEnvoye,
        encaissementsPrev: factPrev,
        encaissementsRetard: factRetard,
        encaissementsTotal: mois.encaissements + encaissementsFactures,
      };
    });

    // Recalculer les soldes avec les encaissements factures
    let soldeCumul = qontoData.soldeActuel || 0;
    for (const mois of previsionnelFinal) {
      const encTotal = mois.encaissements + (mois.encaissementsFactures || 0);
      const variation = encTotal - mois.decaissements;
      mois.soldeDebut = Math.round(soldeCumul);
      soldeCumul += variation;
      mois.soldeFin = Math.round(soldeCumul);
    }

    res.json({
      source: 'qonto',
      soldeActuel: qontoData.soldeActuel,
      totalAEncaisser: Math.round(totalAEncaisserNotion),
      totalEnvoye: Math.round(totalEnvoye),
      totalPrevisionnel: Math.round(totalPrevisionnel),
      chargesMoisCourant: qontoData.chargesMoisCourant,
      chargesMoyennes: qontoData.chargesMoyennes,
      facturesImpayees: facturesAEncaisser,
      ventilationCharges: qontoData.ventilationCharges,
      chargesDetailParMois: qontoData.chargesDetailParMois,
      creditsDetailParMois: qontoData.creditsDetailParMois,
      previsionnel: previsionnelFinal,
      pipelinePondere: Math.round(pipelinePondere),
      pipelineDetail,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur trésorerie:', err.message);
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

app.listen(PORT, () => {
  console.log(`Dashboard commercial démarré sur http://localhost:${PORT}`);
});
