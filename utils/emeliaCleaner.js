'use strict';

/**
 * @param {object[]} rows - Array of objects with Emelia column names (format-agnostic — works with csv-parse or xlsx output)
 * @param {Set<string>} existingLinkedinUrls - LinkedIn URLs already in DB for this account
 * @returns {{ accepted: object[], rejections: object[] }}
 */
function cleanEmeliaRows(rows, existingLinkedinUrls) {
  if (!(existingLinkedinUrls instanceof Set)) throw new TypeError('existingLinkedinUrls must be a Set');
  const seenUrls = new Set(); // tracks URLs added during this import only
  const accepted = [];
  const rejections = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const firstName = String(row.firstName || '').trim();
    const lastName = String(row.lastName || '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ') || '(inconnu)';
    const linkedinUrl = String(row.linkedinUrlProfile || '').trim();
    const title = String(row.title || '').trim();
    const company = String(row.company || '').trim();

    if (!firstName) {
      rejections.push({ row: rowNum, name: '(inconnu)', reason: 'Prénom manquant' });
      return;
    }
    if (!linkedinUrl) {
      rejections.push({ row: rowNum, name, reason: 'URL LinkedIn manquante' });
      return;
    }
    if (!title && !company) {
      rejections.push({ row: rowNum, name, reason: 'Titre de poste et entreprise manquants' });
      return;
    }
    if (existingLinkedinUrls.has(linkedinUrl)) {
      rejections.push({ row: rowNum, name, reason: 'Doublon (déjà présent dans un compte actif)' });
      return;
    }
    if (seenUrls.has(linkedinUrl)) {
      rejections.push({ row: rowNum, name, reason: 'Doublon (présent plusieurs fois dans ce fichier)' });
      return;
    }

    seenUrls.add(linkedinUrl);

    const summaryParts = [row.summary, row.description]
      .map(s => String(s || '').trim())
      .filter(Boolean);
    const linkedinSummary = summaryParts.length > 1
      ? summaryParts.join('\n\n---\n\n')
      : summaryParts[0] || null;

    accepted.push({
      first_name: firstName,
      last_name: lastName || null,
      linkedin_url: linkedinUrl,
      job_title: title || null,
      company: company || null,
      sector: String(row.industry || '').trim() || null,
      geography: String(row.location || '').trim() || null,
      linkedin_summary: linkedinSummary,
      company_description: String(row.companyDescription || '').trim() || null,
    });
  });

  return { accepted, rejections };
}

module.exports = { cleanEmeliaRows };
