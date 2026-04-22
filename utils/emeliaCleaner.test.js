'use strict';
const { cleanEmeliaRows, normalizeLinkedinUrl, slug, companyMatch } = require('./emeliaCleaner');

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
    expect(rejections[0].reason).toBe('Doublon (URL déjà connue)');
  });

  it('déduplique au sein du même import (intra-import)', () => {
    const rows = [baseRow, { ...baseRow }];
    const { accepted, rejections } = cleanEmeliaRows(rows, new Set());
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe('Doublon (présent plusieurs fois dans ce fichier)');
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

  it('rejette si firstName ne contient que des espaces', () => {
    const { accepted, rejections } = cleanEmeliaRows([{ ...baseRow, firstName: '   ' }], new Set());
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Prénom manquant');
  });

  it('met last_name à null si lastName vide', () => {
    const { accepted } = cleanEmeliaRows([{ ...baseRow, lastName: '' }], new Set());
    expect(accepted).toHaveLength(1);
    expect(accepted[0].last_name).toBeNull();
  });

  it('ignore silencieusement les lignes entièrement vides (padding Emelia)', () => {
    const emptyRow = { firstName: '', lastName: '', linkedinUrlProfile: '', title: '', company: '' };
    const { accepted, rejections } = cleanEmeliaRows([emptyRow, baseRow], new Set());
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(0);
  });

  it('détecte les doublons malgré des variations de format d\'URL (trailing slash, www, protocole, casse, query)', () => {
    const variants = [
      { ...baseRow, linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR' },
      { ...baseRow, linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR/' },
      { ...baseRow, linkedinUrlProfile: 'http://linkedin.com/in/ACwAABR' },
      { ...baseRow, linkedinUrlProfile: 'https://www.linkedin.com/in/acwaabr' },
      { ...baseRow, linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR?locale=fr_FR' },
      { ...baseRow, linkedinUrlProfile: 'www.linkedin.com/in/ACwAABR' },
    ];
    const { accepted, rejections } = cleanEmeliaRows(variants, new Set());
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(5);
    rejections.forEach(r => expect(r.reason).toBe('Doublon (présent plusieurs fois dans ce fichier)'));
  });

  it('détecte un doublon vs existingUrls même si format différent', () => {
    const existing = new Set(['http://linkedin.com/in/acwaabr/']);
    const { accepted, rejections } = cleanEmeliaRows([baseRow], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Doublon (URL déjà connue)');
  });
});

describe('normalizeLinkedinUrl', () => {
  it('canonicalise les variations courantes', () => {
    const canonical = 'https://www.linkedin.com/in/acwaabr';
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/ACwAABR')).toBe(canonical);
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/ACwAABR/')).toBe(canonical);
    expect(normalizeLinkedinUrl('http://linkedin.com/in/ACwAABR')).toBe(canonical);
    expect(normalizeLinkedinUrl('www.linkedin.com/in/ACwAABR')).toBe(canonical);
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/ACwAABR?locale=fr_FR')).toBe(canonical);
    expect(normalizeLinkedinUrl('  https://www.linkedin.com/in/ACwAABR  ')).toBe(canonical);
  });

  it('retourne chaîne vide pour input vide', () => {
    expect(normalizeLinkedinUrl('')).toBe('');
    expect(normalizeLinkedinUrl(null)).toBe('');
    expect(normalizeLinkedinUrl(undefined)).toBe('');
  });
});

describe('slug', () => {
  it('lowercase + strip accents + keep only alphanumeric', () => {
    expect(slug('Anne-Laure')).toBe('annelaure');
    expect(slug('Alstef Mobile Robotics')).toBe('alstefmobilerobotics');
    expect(slug('L\'Oréal')).toBe('loreal');
    expect(slug('  Éléonore  ')).toBe('eleonore');
    expect(slug('')).toBe('');
    expect(slug(null)).toBe('');
  });
});

describe('companyMatch', () => {
  it('matche exact après normalisation', () => {
    expect(companyMatch('Alstef', 'alstef')).toBe(true);
    expect(companyMatch('L\'Oréal', 'loreal')).toBe(true);
  });

  it('matche quand un nom est inclus dans une version plus longue', () => {
    expect(companyMatch('Alstef', 'Alstef Mobile Robotics')).toBe(true);
    expect(companyMatch('Alstef Mobile Robotics', 'Alstef')).toBe(true);
  });

  it('matche acronymes courts via préfixe générique ("Groupe VSB" ≡ "VSB")', () => {
    expect(companyMatch('VSB', 'Groupe VSB')).toBe(true);
    expect(companyMatch('IBM', 'IBM France')).toBe(true);
    expect(companyMatch('SAP', 'SAP SE')).toBe(true);
  });

  it('matche "Université X Y" ≡ "Université de X Y" (mot générique "de" retiré)', () => {
    expect(companyMatch('Université de Bretagne Occidentale', 'Université Bretagne Occidentale')).toBe(true);
  });

  it('ne matche pas des noms similaires mais différents', () => {
    expect(companyMatch('Alstef', 'Alcatel')).toBe(false);
    expect(companyMatch('Microsoft', 'Microtest')).toBe(false);
    expect(companyMatch('Decathlon', 'Deca')).toBe(false);
  });

  it('ne matche pas si seuls des tokens génériques / courts sont partagés', () => {
    expect(companyMatch('SAS Dupont', 'SAS Martin')).toBe(false);
    expect(companyMatch('Groupe A', 'Groupe B')).toBe(false);
  });

  it('retourne false pour input vide', () => {
    expect(companyMatch('', 'Alstef')).toBe(false);
    expect(companyMatch('Alstef', '')).toBe(false);
    expect(companyMatch(null, null)).toBe(false);
  });
});

describe('cleanEmeliaRows — filtre de secours nom+entreprise', () => {
  const rowAL = {
    firstName: 'Anne-Laure', lastName: 'Avril',
    linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR18tsB9GrAIxO0p0EU5K_2REeIBiCn0r0',
    title: 'Responsable Achats', company: 'Alstef Mobile Robotics',
  };

  it('rejette si même prénom+nom+entreprise existe en DB avec URL vanity différente', () => {
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/anne-laure-avril-1234',
      first_name: 'Anne-Laure', last_name: 'Avril', company: 'Alstef Mobile Robotics',
    }];
    const { accepted, rejections } = cleanEmeliaRows([rowAL], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Doublon (même nom + entreprise)');
  });

  it('matche même si entreprise existe en version courte ("Alstef") vs longue ("Alstef Mobile Robotics")', () => {
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/autre-url',
      first_name: 'Anne-Laure', last_name: 'Avril', company: 'Alstef',
    }];
    const { accepted, rejections } = cleanEmeliaRows([rowAL], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Doublon (même nom + entreprise)');
  });

  it('matche malgré casse et accents différents', () => {
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/autre',
      first_name: 'anne-laure', last_name: 'AVRIL', company: 'alstef mobile robotics',
    }];
    const { accepted, rejections } = cleanEmeliaRows([rowAL], existing);
    expect(accepted).toHaveLength(0);
  });

  it('accepte si même nom mais entreprise totalement différente', () => {
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/autre',
      first_name: 'Anne-Laure', last_name: 'Avril', company: 'Decathlon',
    }];
    const { accepted, rejections } = cleanEmeliaRows([rowAL], existing);
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(0);
  });

  it('accepte si même entreprise mais prénom différent', () => {
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/autre',
      first_name: 'Marc', last_name: 'Avril', company: 'Alstef',
    }];
    const { accepted } = cleanEmeliaRows([rowAL], existing);
    expect(accepted).toHaveLength(1);
  });

  it('bloque aussi les doublons avec statut "Non pertinent" et expose statut + campagne', () => {
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/anne-laure-avril-1234',
      first_name: 'Anne-Laure', last_name: 'Avril', company: 'Alstef',
      status: 'Non pertinent', campaign_name: 'Industriels Bretagne',
    }];
    const row = {
      firstName: 'Anne-Laure', lastName: 'Avril',
      linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR',
      title: 'Responsable', company: 'Alstef Mobile Robotics',
    };
    const { accepted, rejections } = cleanEmeliaRows([row], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Doublon (même nom + entreprise)');
    expect(rejections[0].existing_status).toBe('Non pertinent');
    expect(rejections[0].existing_campaign).toBe('Industriels Bretagne');
    expect(rejections[0].company).toBe('Alstef Mobile Robotics');
  });

  it('cas réel: Maël Lagarde chez "Groupe VSB" matche existing "VSB"', () => {
    const row = {
      firstName: 'Maël', lastName: 'Lagarde',
      linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAAAi_CiUBkSayxuEMishWX9klqE6HpQkGMaA',
      title: 'Directeur', company: 'Groupe VSB',
    };
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/mael-lagarde',
      first_name: 'Maël', last_name: 'Lagarde', company: 'VSB',
    }];
    const { accepted, rejections } = cleanEmeliaRows([row], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Doublon (même nom + entreprise)');
  });

  it('cas réel: Gaël Labat chez "Université de Bretagne Occidentale" matche variation sans "de"', () => {
    const row = {
      firstName: 'Gaël', lastName: 'Labat',
      linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABJeZp4B9pd8PMf2ubUig2ZctjaqCOmJPQo',
      title: 'Chercheur', company: 'Université de Bretagne Occidentale',
    };
    const existing = [{
      linkedin_url: 'https://www.linkedin.com/in/gael-labat',
      first_name: 'Gaël', last_name: 'Labat', company: 'Université Bretagne Occidentale',
    }];
    const { accepted, rejections } = cleanEmeliaRows([row], existing);
    expect(accepted).toHaveLength(0);
    expect(rejections[0].reason).toBe('Doublon (même nom + entreprise)');
  });

  it('dédup intra-fichier: même personne, deux URLs différentes dans le même import', () => {
    const row1 = { ...rowAL, linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR_v1' };
    const row2 = { ...rowAL, linkedinUrlProfile: 'https://www.linkedin.com/in/ACwAABR_v2' };
    const { accepted, rejections } = cleanEmeliaRows([row1, row2], []);
    expect(accepted).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].reason).toBe('Doublon (présent plusieurs fois dans ce fichier)');
  });
});
