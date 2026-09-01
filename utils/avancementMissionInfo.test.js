'use strict';
const { missionAvancementInfo, MIN_MONTANT } = require('./avancementMissionInfo');

describe('missionAvancementInfo : champs additifs GET /api/avancement (spec §5.1 bis)', () => {
  test('montantSolde = max(0, ca - montantAcompte), jamais negatif', () => {
    const info = missionAvancementInfo({ ca: 10000, montantAcompte: 4000 });
    expect(info.montantSolde).toBe(6000);
    const infoDepasse = missionAvancementInfo({ ca: 1000, montantAcompte: 1500 });
    expect(infoDepasse.montantSolde).toBe(0);
  });

  test('annee de rattachement = annee de la date de facture quand le volet est emis', () => {
    const info = missionAvancementInfo({
      ca: 10000, montantAcompte: 4000,
      dateFactureAcompte: '2025-06-01', dateFactureFinale: '2026-01-15',
    });
    expect(info.anneeAcompte).toBe(2025);
    expect(info.anneeSolde).toBe(2026);
  });

  test('repli sur "Annee final" quand la facture n est pas encore emise (meme regle que signedAmountForYear)', () => {
    const info = missionAvancementInfo({
      ca: 10000, montantAcompte: 4000,
      dateFactureAcompte: '2025-06-01', dateFactureFinale: null, anneeFinal: '2026',
    });
    expect(info.anneeAcompte).toBe(2025);
    expect(info.anneeSolde).toBe(2026); // solde non facture -> repli sur Annee final
  });

  test('ni date ni "Annee final" : annee null (non rattachable)', () => {
    const info = missionAvancementInfo({ ca: 10000, montantAcompte: 4000, dateFactureFinale: null, anneeFinal: '' });
    expect(info.anneeSolde).toBeNull();
  });

  describe('aCheval : les deux volets existent, deux annees connues et differentes', () => {
    test('acompte 2025 / solde 2026 -> a cheval', () => {
      const info = missionAvancementInfo({
        ca: 10000, montantAcompte: 4000,
        dateFactureAcompte: '2025-06-01', dateFactureFinale: '2026-02-10',
      });
      expect(info.aCheval).toBe(true);
    });

    test('acompte et solde la meme annee -> pas a cheval (mission lancee et terminee dans l annee)', () => {
      const info = missionAvancementInfo({
        ca: 10000, montantAcompte: 4000,
        dateFactureAcompte: '2026-02-01', dateFactureFinale: '2026-08-20',
      });
      expect(info.aCheval).toBe(false);
    });

    test('un volet sous le seuil MIN_MONTANT ne compte pas comme existant', () => {
      const info = missionAvancementInfo({
        ca: 10000, montantAcompte: 3, // < MIN_MONTANT
        dateFactureAcompte: '2025-12-20', dateFactureFinale: '2026-01-05',
      });
      expect(MIN_MONTANT).toBe(5);
      expect(info.aCheval).toBe(false);
    });

    test('annee de rattachement inconnue d un cote -> pas a cheval', () => {
      const info = missionAvancementInfo({ ca: 10000, montantAcompte: 4000, dateFactureAcompte: '2025-06-01', dateFactureFinale: null, anneeFinal: '' });
      expect(info.aCheval).toBe(false);
    });

    test('Alphapro groupe (spec §5.1 bis) : 15 500 EUR factures en une fois le 2025-04-30, avancee a 70 % au 31/12/2025 -> PCA de 4 650 EUR, jamais a cheval au sens des dates de facture', () => {
      // Mission one-shot : le volet "Acompte" est negligeable (< MIN_MONTANT), tout est sur "Solde"
      // (meme convention que buildInvoiceLines cote front : "Acompte forcé" ~ 1 EUR ou absent).
      const alphapro = {
        ca: 15500, montantAcompte: 0,
        dateFactureAcompte: null, dateFactureFinale: '2025-04-30', anneeFinal: '2025',
      };
      const info = missionAvancementInfo(alphapro);
      expect(info.montantSolde).toBe(15500);
      expect(info.anneeSolde).toBe(2025);
      expect(info.aCheval).toBe(false); // c est exactement le cas que l echappatoire front doit couvrir
    });
  });

  test('mission vide/partielle : ne jette jamais, valeurs par defaut sures', () => {
    expect(() => missionAvancementInfo({})).not.toThrow();
    expect(() => missionAvancementInfo(null)).not.toThrow();
    const info = missionAvancementInfo(null);
    expect(info.montantAcompte).toBe(0);
    expect(info.montantSolde).toBe(0);
    expect(info.anneeAcompte).toBeNull();
    expect(info.anneeSolde).toBeNull();
    expect(info.aCheval).toBe(false);
  });
});
