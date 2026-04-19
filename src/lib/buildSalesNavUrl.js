import { SENIORITY_URL_ID_MAP } from './constants';

export function buildSalesNavUrl(criteria) {
  const filters = [];

  function encodeText(text) {
    return encodeURIComponent(text);
  }

  function buildFilterBlock(type, items) {
    if (!items || items.length === 0) return null;
    const values = items.map(item => {
      const selType = item.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
      return item.text
        ? `(id:${item.id},text:${encodeText(item.text)},selectionType:${selType})`
        : `(id:${item.id},selectionType:${selType})`;
    });
    return `(type:${type},values:List(${values.join(',')}))`;
  }

  // REGION (pas GEO — vérifié sur URL Sales Nav réelle le 17/04/2026)
  const geo = buildFilterBlock('REGION', criteria.geoIds || []);
  if (geo) filters.push(geo);

  if (criteria.jobTitles?.length > 0) {
    const titles = criteria.jobTitles.map(t => {
      const sel = t.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
      return `(text:${encodeText(t.value)},selectionType:${sel})`;
    });
    filters.push(`(type:CURRENT_TITLE,values:List(${titles.join(',')}))`);
  }

  if (criteria.seniorities?.length > 0) {
    const seniorities = criteria.seniorities
      .map(s => {
        const sel = s.type === 'include' ? 'INCLUDED' : 'EXCLUDED';
        const mapping = SENIORITY_URL_ID_MAP[s.code];
        if (!mapping) return null;
        return `(id:${mapping.id},text:${encodeText(mapping.text)},selectionType:${sel})`;
      })
      .filter(Boolean);
    if (seniorities.length > 0) {
      filters.push(`(type:SENIORITY_LEVEL,values:List(${seniorities.join(',')}))`);
    }
  }

  const sectors = criteria.sectorIds || [];
  if (sectors.length > 0) {
    const sector = buildFilterBlock(
      'INDUSTRY',
      sectors.map(s => ({ id: s.id, text: s.label, type: s.type }))
    );
    if (sector) filters.push(sector);
  }

  if (criteria.headcounts?.length > 0) {
    const hc = criteria.headcounts.map(code => `(id:${code},selectionType:INCLUDED)`);
    filters.push(`(type:COMPANY_HEADCOUNT,values:List(${hc.join(',')}))`);
  }

  // keywords et instructions Claude ne sont PAS injectés dans la recherche Sales Nav
  const base = 'https://www.linkedin.com/sales/search/people';

  const filterPart = filters.length > 0 ? `filters:List(${filters.join(',')})` : '';

  const queryParts = [
    'recentSearchParam:(doLogHistory:true)',
    'spellCorrectionEnabled:true',
    filterPart,
  ].filter(Boolean).join(',');

  return `${base}?query=(${queryParts})`;
}
