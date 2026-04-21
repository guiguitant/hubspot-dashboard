'use strict';
const { cleanEmeliaRows } = require('./emeliaCleaner');

const baseRow = {
  firstName: 'Anne-Laure', lastName: 'Avril',
  linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR',
  title: 'Responsable Achats', company: 'Alstef',
  industry: 'Fabrication', location: 'Rennes',
  summary: 'Expert achats', description: 'En charge de',
  companyDescription: 'Fabricant de robots',
};

describe('cleanEmeliaRows', () => {
  it('accepte une ligne valide complète', () => {
    const { accepted, rejections } = cleanEmeliaRows([baseRow], new Set());
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(0);
    expect(accepted[0].first_name).toBe('Anne-Laure');
    expect(accepted[0].linkedin_url).toBe('https://www.linkedin.com/in/ACwAABR');
  });

  it('rejette si firstName vide', () => {
    const { accepted, rejections } = cleanEmeliaRows([{ ...baseRow, firstName: '' }], new Set());
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Prénom manquant');
    expect(rejections[0].name).toBe('(inconnu)');
  });

  it('rejette si linkedinUrlProfile absent', () => {
    const { accepted, rejections } = cleanEmeliaRows([{ ...baseRow, linkedinUrlProfile: '' }], new Set());
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('URL LinkedIn manquante');
  });

  it('rejette si title ET company tous les deux vides', () => {
    const { accepted, rejections } = cleanEmeliaRows([{ ...baseRow, title: '', company: '' }], new Set());
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Titre de poste et entreprise manquants');
  });

  it('accepte si title vide mais company présente', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, title: '' }], new Set());
    expect(accepted).toHaveLength(1);
    expect(accepted[0].job_title).toBeNull();
    expect(accepted[0].company).toBe('Alstef');
  });

  it('accepte si company vide mais title présent', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, company: '' }], new Set());
    expect(accepted).toHaveLength(1);
    expect(accepted[0].company).toBeNull();
    expect(accepted[0].job_title).toBe('Responsable Achats');
  });

  it('rejette un doublon (url déjà dans existingUrls)', () => {
    const existing = new Set(['https://www.linkedin.com/in/ACwAABR']);
    const { accepted, rejections } = cleanEmeliaRows([baseRow], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toContain('Doublon');
  });

  it('déduplique au sein du même import (intra-import)', () => {
    const rows = [baseRow, { ...baseRow }];
    const { accepted, rejections } = cleanEmeliaRows(rows, new Set());
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toContain('Doublon');
  });

  it('concatène summary et description avec séparateur', () => {
    const { accepted } = cleanEmeliaRows([baseRow], new Set());
    expect(accepted[0].linkedin_summary).toBe('Expert achats\n\n---\n\nEn charge de');
  });

  it('utilise uniquement summary si description vide', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, description: '' }], new Set());
    expect(accepted[0].linkedin_summary).toBe('Expert achats');
  });

  it('met linkedin_summary à null si summary ET description vides', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, summary: '', description: '' }], new Set());
    expect(accepted[0].linkedin_summary).toBeNull();
  });

  it('mappe company_description', () => {
    const { accepted } = cleanEmeliaRows([baseRow], new Set());
    expect(accepted[0].company_description).toBe('Fabricant de robots');
  });

  it('numéro de ligne commence à 2 (ligne 1 = header)', () => {
    const { rejections } = cleanEmeliaRows([{ ...baseRow, firstName: '' }], new Set());
    expect(rejections[0].row).toBe(2);
  });
});
