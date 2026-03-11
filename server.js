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

app.listen(PORT, () => {
  console.log(`Dashboard commercial démarré sur http://localhost:${PORT}`);
});
