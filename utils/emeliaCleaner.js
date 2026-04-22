'use strict';

/**
 * Canonical form of a LinkedIn profile URL for dedup comparison.
 * Handles variations in protocol, www prefix, trailing slash, query string, and case.
 * Returns '' for empty/invalid input.
 */
function normalizeLinkedinUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return `https://www.linkedin.com${path}`;
  } catch {
    return s.toLowerCase().replace(/\/+$/, '').replace(/\?.*$/, '');
  }
}

/**
 * Slug form for text comparison: lowercase, accents stripped, keep only [a-z0-9].
 * Removes spaces, hyphens, punctuation, symbols.
 */
function slug(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Generic tokens stripped before comparison (common corporate prefixes, legal forms,
// and short stopwords). Keeps the comparison on the identifying part of the name.
const GENERIC_COMPANY_TOKENS = new Set([
  'groupe', 'group', 'holding', 'company', 'compagnie',
  'sa', 'sas', 'sarl', 'sasu', 'eurl', 'spa', 'srl',
  'ltd', 'limited', 'inc', 'llc', 'gmbh', 'ag', 'corp', 'corporation', 'co',
  'le', 'la', 'les', 'un', 'une',
  'de', 'du', 'des', 'et', 'and', 'the', 'for', 'in', 'of',
]);

function companyTokens(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !GENERIC_COMPANY_TOKENS.has(t));
}

/**
 * True when two company names look like the same org.
 * Rule: share at least one identifying token (≥ 3 chars, non-generic) after normalization.
 * Catches "VSB" ≡ "Groupe VSB", "Alstef" ≡ "Alstef Mobile Robotics",
 * "Université Bretagne Occidentale" ≡ "Université de Bretagne Occidentale".
 * Rejects "Alstef" vs "Alcatel", "SAS" vs "SAS Dupont".
 */
function companyMatch(a, b) {
  const ta = new Set(companyTokens(a));
  const tb = companyTokens(b);
  if (ta.size > 0 && tb.length > 0 && tb.some(t => ta.has(t))) return true;
  // Fallback: slug equality — handles edge cases like apostrophes ("L'Oréal" ≡ "LOreal")
  const sa = slug(a);
  const sb = slug(b);
  return !!sa && sa === sb;
}

function personNameKey(firstName, lastName) {
  const fn = slug(firstName);
  const ln = slug(lastName);
  if (!fn || !ln) return null;
  return `${fn}|${ln}`;
}

/**
 * @param {object[]} rows - Array of objects with Emelia column names (format-agnostic — works with csv-parse or xlsx output)
 * @param {Array<{linkedin_url?: string, first_name?: string, last_name?: string, company?: string, status?: string}> | Set<string>} existing -
 *   Existing prospects in DB (preferred) OR legacy Set of LinkedIn URLs.
 * @returns {{ accepted: object[], rejections: object[] }}
 */
function cleanEmeliaRows(rows, existing) {
  // Normalize signature: support legacy Set<url> and modern Array<prospect>
  let existingProspects;
  if (existing instanceof Set) {
    existingProspects = [...existing].map(u => ({ linkedin_url: u }));
  } else if (Array.isArray(existing)) {
    existingProspects = existing;
  } else {
    throw new TypeError('existing must be an Array of prospects or a Set of URLs');
  }

  const existingByUrl = new Map(); // normalized url → { status, campaign_name }
  const existingByName = new Map(); // "firstnameSlug|lastnameSlug" → [{ company, status, campaign_name }]
  for (const p of existingProspects) {
    const info = { status: p.status || null, campaign_name: p.campaign_name || null };
    const n = normalizeLinkedinUrl(p.linkedin_url);
    if (n) existingByUrl.set(n, info);
    const nameKey = personNameKey(p.first_name, p.last_name);
    if (nameKey) {
      if (!existingByName.has(nameKey)) existingByName.set(nameKey, []);
      existingByName.get(nameKey).push({ company: p.company || '', ...info });
    }
  }

  const seenUrls = new Set();
  const seenNameCompany = new Map(); // same shape as existingByName, for intra-import dedup
  const accepted = [];
  const rejections = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const firstName = String(row.firstName || '').trim();
    const lastName = String(row.lastName || '').trim();
    const name = [firstName, lastName].filter(Boolean).join(' ') || '(inconnu)';
    const linkedinUrl = String(row.linkedinUrlProfile || '').trim();
    const normalizedUrl = normalizeLinkedinUrl(linkedinUrl);
    const title = String(row.title || '').trim();
    const company = String(row.company || '').trim();

    // Silently skip fully empty rows (Emelia pads exports with blank lines)
    if (!firstName && !lastName && !linkedinUrl && !title && !company) return;

    const base = { row: rowNum, name, company: company || null };

    if (!firstName) {
      rejections.push({ ...base, name: '(inconnu)', reason: 'Prénom manquant' });
      return;
    }
    if (!linkedinUrl) {
      rejections.push({ ...base, reason: 'URL LinkedIn manquante' });
      return;
    }
    if (!title && !company) {
      rejections.push({ ...base, reason: 'Titre de poste et entreprise manquants' });
      return;
    }

    // --- Dedup checks ---

    // 1) Exact URL match (primary) — catches future Emelia-only imports
    if (existingByUrl.has(normalizedUrl)) {
      const info = existingByUrl.get(normalizedUrl);
      rejections.push({ ...base, reason: 'Doublon (URL déjà connue)', existing_status: info.status, existing_campaign: info.campaign_name });
      return;
    }
    // 2) Name + company match (safety net) — catches the case where DB has a resolved/vanity
    //    URL and the Emelia export has the encoded ACoAA/ACwAABR form for the same person.
    const nameKey = personNameKey(firstName, lastName);
    if (nameKey) {
      const existingCandidates = existingByName.get(nameKey) || [];
      const hit = existingCandidates.find(c => companyMatch(c.company, company));
      if (hit) {
        rejections.push({ ...base, reason: 'Doublon (même nom + entreprise)', existing_status: hit.status, existing_campaign: hit.campaign_name });
        return;
      }
    }
    // 3) Intra-file: same URL twice in this CSV
    if (seenUrls.has(normalizedUrl)) {
      rejections.push({ ...base, reason: 'Doublon (présent plusieurs fois dans ce fichier)' });
      return;
    }
    // 4) Intra-file: same name + company twice in this CSV
    if (nameKey) {
      const seenCandidates = seenNameCompany.get(nameKey) || [];
      if (seenCandidates.some(c => companyMatch(c.company, company))) {
        rejections.push({ ...base, reason: 'Doublon (présent plusieurs fois dans ce fichier)' });
        return;
      }
    }

    seenUrls.add(normalizedUrl);
    if (nameKey) {
      if (!seenNameCompany.has(nameKey)) seenNameCompany.set(nameKey, []);
      seenNameCompany.get(nameKey).push({ company });
    }

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

module.exports = { cleanEmeliaRows, normalizeLinkedinUrl, slug, companyMatch };
