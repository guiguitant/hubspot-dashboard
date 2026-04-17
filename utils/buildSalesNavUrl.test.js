const { buildSalesNavUrl } = require('./buildSalesNavUrl');

describe('buildSalesNavUrl', () => {
  it('génère une URL avec GEO + INDUSTRY + HEADCOUNT', () => {
    const url = buildSalesNavUrl({
      geoIds: [{ id: '104246759', text: 'Île-de-France, France', type: 'include' }],
      sectorIds: [{ id: 48, label: 'Construction', parent_category: 'Construction', type: 'include' }],
      headcounts: ['D', 'E'],
      jobTitles: [], seniorities: []
    });
    expect(url).toContain('type:REGION');
    expect(url).toContain('id:104246759');
    expect(url).toContain('type:INDUSTRY');
    expect(url).toContain('id:48');
    expect(url).toContain('text:Construction');
    expect(url).toContain('type:COMPANY_HEADCOUNT');
    expect(url).toContain('id:D');
    expect(url).toMatch(/\/sales\/search\/people/);
  });

  it('inclut text: obligatoire pour INDUSTRY (sinon filtre silencieusement ignoré)', () => {
    const url = buildSalesNavUrl({
      sectorIds: [{ id: 3197, label: 'Matériaux de construction', parent_category: 'Wholesale', type: 'include' }],
      geoIds: [], jobTitles: [], headcounts: [], seniorities: []
    });
    expect(url).toContain('type:INDUSTRY');
    expect(url).toContain('id:3197');
    expect(url).toContain('text:');
    expect(url).toContain('text:Mat%C3%A9riaux%20de%20construction');
    expect(url).toContain('selectionType:INCLUDED');
  });

  it('encode correctement TOUS les accents français', () => {
    const url = buildSalesNavUrl({
      geoIds: [{ id: '102203735', text: "Provence-Alpes-Côte d'Azur", type: 'include' }],
      jobTitles: [{ value: 'Responsable HSE', type: 'include' }],
      sectorIds: [], headcounts: [], seniorities: []
    });
    expect(url).not.toMatch(/[éèêîôçàùÉÈÊÎÔÇÀÙœæûâ]/);
    expect(url).toContain('type:CURRENT_TITLE');
    expect(url).toContain('%C3%B4'); // ô
  });

  it('utilise les IDs numériques 3 chiffres pour SENIORITY_LEVEL avec text: obligatoire', () => {
    const url = buildSalesNavUrl({
      seniorities: [{ code: 'DIRECTOR', type: 'include' }],
      geoIds: [], jobTitles: [], sectorIds: [], headcounts: []
    });
    expect(url).toContain('type:SENIORITY_LEVEL');
    expect(url).toContain('id:220');
    expect(url).toContain('text:Directeur');
    expect(url).not.toContain('id:DIRECTOR');
    expect(url).not.toContain('id:6');
  });

  it('génère un filtre CURRENT_TITLE avec include ET exclude', () => {
    const url = buildSalesNavUrl({
      jobTitles: [
        { value: 'Directeur HSE', type: 'include' },
        { value: 'stagiaire', type: 'exclude' }
      ],
      geoIds: [], sectorIds: [], headcounts: [], seniorities: []
    });
    expect(url).toContain('selectionType:INCLUDED');
    expect(url).toContain('selectionType:EXCLUDED');
  });

  it('inclut recentSearchParam et spellCorrectionEnabled', () => {
    const url = buildSalesNavUrl({ geoIds: [], jobTitles: [], sectorIds: [], headcounts: [], seniorities: [] });
    expect(url).toContain('recentSearchParam:(doLogHistory:true)');
    expect(url).toContain('spellCorrectionEnabled:true');
  });

  it('encapsule les keywords multi-mots entre guillemets encodés', () => {
    const url = buildSalesNavUrl({
      geoIds: [], jobTitles: [], sectorIds: [], headcounts: [], seniorities: [],
      keywords: ['Bilan Carbone', 'RSE']
    });
    expect(url).toContain('keywords:');
    expect(url).toContain('%22Bilan%20Carbone%22');
  });

  it('retourne une URL structurellement valide même avec criteria vide', () => {
    const url = buildSalesNavUrl({ geoIds: [], jobTitles: [], sectorIds: [], headcounts: [], seniorities: [] });
    expect(url).toMatch(/^https:\/\/www\.linkedin\.com\/sales\/search\/people\?query=\(/);
    expect(url).not.toContain('filters:List()');
  });
});
