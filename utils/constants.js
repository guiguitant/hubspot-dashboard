// IDs et labels vérifiés sur URL Sales Navigator réelle — 16/04/2026
const SENIORITY_URL_ID_MAP = {
  OWNER_PARTNER: { id: 320, text: 'Propriétaire / partenaire' },
  C_LEVEL:       { id: 310, text: 'Comité Exécutif' },
  VP:            { id: 300, text: 'Vice-président' },
  DIRECTOR:      { id: 220, text: 'Directeur' },
  MANAGER_SR:    { id: 210, text: 'Manager expérimenté' },
  MANAGER_JR:    { id: 200, text: 'Manager niveau débutant' },
  STRATEGIC:     { id: 130, text: 'Stratégique' },
  SENIOR:        { id: 120, text: 'Expérimenté' },
  ENTRY:         { id: 110, text: 'Premier emploi' },
  TRAINEE:       { id: 100, text: 'Stagiaire' },
};

const HEADCOUNT_OPTIONS = [
  { code: 'B', label: '1-10 salariés' },
  { code: 'C', label: '11-50 salariés' },
  { code: 'D', label: '51-200 salariés' },
  { code: 'E', label: '201-500 salariés' },
  { code: 'F', label: '501-1 000 salariés' },
  { code: 'G', label: '1 001-5 000 salariés' },
  { code: 'H', label: '5 001-10 000 salariés' },
  { code: 'I', label: '10 001+ salariés' },
];

const SENIORITY_OPTIONS = [
  { code: 'OWNER_PARTNER', label: 'Propriétaire / partenaire' },
  { code: 'C_LEVEL',       label: 'Comité Exécutif' },
  { code: 'VP',            label: 'Vice-président' },
  { code: 'DIRECTOR',      label: 'Directeur' },
  { code: 'MANAGER_SR',    label: 'Manager expérimenté' },
  { code: 'MANAGER_JR',    label: 'Manager niveau débutant' },
  { code: 'STRATEGIC',     label: 'Stratégique' },
  { code: 'SENIOR',        label: 'Expérimenté' },
  { code: 'ENTRY',         label: 'Premier emploi' },
  { code: 'TRAINEE',       label: 'Stagiaire' },
];

module.exports = { SENIORITY_URL_ID_MAP, HEADCOUNT_OPTIONS, SENIORITY_OPTIONS };
