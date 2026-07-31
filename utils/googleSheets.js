'use strict';
const { google } = require('googleapis');

let _sheets = null;
// Client Sheets memoise, authentifie via le compte de service (.env). scope = ecriture Sheets.
function sheetsClient() {
  if (_sheets) return _sheets;
  const auth = new google.auth.JWT({
    email: process.env.client_email,
    key: (process.env.private_key || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

// Lit une plage 'A1:BZ300' d'un onglet. Retourne un tableau 2D (lignes), valeurs affichees.
async function readGrid(spreadsheetId, tabName, range) {
  const res = await sheetsClient().spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!${range}`,
    valueRenderOption: 'FORMATTED_VALUE',
    majorDimension: 'ROWS',
  });
  return res.data.values || [];
}

// Ecrit une liste de cellules en un seul appel. updates = [{ range:'Onglet!J7', value:3500 }].
async function batchWrite(spreadsheetId, updates) {
  if (!updates || !updates.length) return { updated: 0 };
  const res = await sheetsClient().spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({ range: u.range, values: [[u.value]] })),
    },
  });
  return { updated: res.data.totalUpdatedCells || 0 };
}

module.exports = { readGrid, batchWrite };
