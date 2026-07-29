'use strict';
const { isDealDormant, DORMANT_DAYS, DORMANT_GRACE_DAYS } = require('./dealDormancy');

// Référence temporelle fixe pour des tests déterministes.
const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const daysAgo = n => new Date(NOW - n * DAY).toISOString();
const inDays = n => new Date(NOW + n * DAY).toISOString();

describe('isDealDormant', () => {
  it('deal ancien sans aucun contact -> en sommeil (repli sur la date de création)', () => {
    expect(isDealDormant({ createdate: daysAgo(200) }, null, NOW)).toBe(true);
  });

  it('deal récent (dans le délai de grâce) -> jamais en sommeil', () => {
    expect(isDealDormant({ createdate: daysAgo(DORMANT_GRACE_DAYS - 1) }, {}, NOW)).toBe(false);
  });

  it('deal ancien mais relancé récemment -> pas en sommeil', () => {
    const meta = { relances: [{ at: daysAgo(10) }] };
    expect(isDealDormant({ createdate: daysAgo(200) }, meta, NOW)).toBe(false);
  });

  it('deal ancien avec dernière relance trop vieille -> en sommeil', () => {
    const meta = { relances: [{ at: daysAgo(120) }] };
    expect(isDealDormant({ createdate: daysAgo(200) }, meta, NOW)).toBe(true);
  });

  it('une note récente compte comme un contact', () => {
    const meta = { relances: [{ at: daysAgo(200) }], notes: [{ at: daysAgo(5) }] };
    expect(isDealDormant({ createdate: daysAgo(300) }, meta, NOW)).toBe(false);
  });

  it('RDV futur planifié -> jamais en sommeil, même très ancien', () => {
    const meta = { relances: [{ at: daysAgo(200) }], next_meeting_at: inDays(3) };
    expect(isDealDormant({ createdate: daysAgo(300) }, meta, NOW)).toBe(false);
  });

  it('tâche non terminée à échéance future -> pas en sommeil', () => {
    const meta = { relances: [{ at: daysAgo(200) }], tasks: [{ status: 'todo', due_at: inDays(2) }] };
    expect(isDealDormant({ createdate: daysAgo(300) }, meta, NOW)).toBe(false);
  });

  it('tâche terminée (status done) n\'empêche pas le sommeil', () => {
    const meta = { relances: [{ at: daysAgo(200) }], tasks: [{ status: 'done', due_at: inDays(2) }] };
    expect(isDealDormant({ createdate: daysAgo(300) }, meta, NOW)).toBe(true);
  });

  it('seuil exact : >= DORMANT_DAYS est en sommeil, en dessous non', () => {
    expect(isDealDormant({ createdate: daysAgo(DORMANT_DAYS) }, {}, NOW)).toBe(true);
    expect(isDealDormant({ createdate: daysAgo(DORMANT_DAYS - 1) }, {}, NOW)).toBe(false);
  });

  it('sans date de création ni contact -> pas en sommeil (rien à mesurer)', () => {
    expect(isDealDormant({ createdate: null }, {}, NOW)).toBe(false);
  });
});
