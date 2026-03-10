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

// Detect EU tokens (prefix "eu1-") and use the EU API base
const IS_EU = HUBSPOT_API_KEY.startsWith('eu1-');
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
      monthly[key] = { year, month, total: 0, count: 0 };
    }
    monthly[key].total += amount;
    monthly[key].count += 1;
  }

  return monthly;
}

// --- Main dashboard endpoint ---
app.get('/api/dashboard', async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const previousYear = currentYear - 1;

    const [deals, openDealsCount, stages] = await Promise.all([
      fetchClosedWonDeals(),
      fetchOpenDealsCount(),
      fetchPipelineStages(),
    ]);

    const monthly = aggregateByMonth(deals);

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
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Erreur dashboard:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard commercial démarré sur http://localhost:${PORT}`);
});
