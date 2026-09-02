'use strict';
const { missionAvancementInfo } = require('./avancementMissionInfo');

describe('missionAvancementInfo : champs additifs GET /api/avancement (spec §5.1 bis)', () => {
  test('montantSolde = max(0, ca - montantAcompte), jamais negatif', () => {
    const info = missionAvancementInfo({ ca: 10000, montantAcompte: 4000 });
    expect(info.montantSolde).toBe(6000);
    const infoDepasse = missionAvancementInfo({ ca: 1000, montantAcompte: 1500 });
    expect(infoDepasse.montantSolde).toBe(0);
  });

  // Ronde de correctifs 1 (revue) : chaque cas qui porte des dates asserte desormais explicitement
  // dateFactureAcompte ET dateFactureFinale (pas seulement les annees/aCheval qui en decoulent).
  // Preuve que la garde mord : intervertir les deux champs dans missionAvancementInfo fait tomber
  // ces assertions (voir §"Mutation de controle" du rapport de tache).
  test('annee de rattachement = annee de la date de facture quand le volet est emis', () => {
    const info = missionAvancementInfo({
      ca: 10000, montantAcompte: 4000,
      dateFactureAcompte: '2025-06-01', dateFactureFinale: '2026-01-15',
    });
    expect(info.dateFactureAcompte).toBe('2025-06-01');
    expect(info.dateFactureFinale).toBe('2026-01-15');
    expect(info.anneeAcompte).toBe(2025);
    expect(info.anneeSolde).toBe(2026);
  });

  test('repli sur "Annee final" quand la facture n est pas encore emise (meme regle que signedAmountForYear)', () => {
    const info = missionAvancementInfo({
      ca: 10000, montantAcompte: 4000,
      dateFactureAcompte: '2025-06-01', dateFactureFinale: null, anneeFinal: '2026',
    });
    expect(info.dateFactureAcompte).toBe('2025-06-01');
    expect(info.dateFactureFinale).toBeNull(); // solde non facture : la DATE reste null, seule l annee replie
    expect(info.anneeAcompte).toBe(2025);
    expect(info.anneeSolde).toBe(2026); // solde non facture -> repli sur Annee final
    // Distinction volontaire (spec §5.1 quinquies point a) : anneeSolde replie sur "Annee final" pour
    // le RATTACHEMENT COMPTABLE, mais aCheval ne suit jamais ce repli, seulement la date d'emission
    // reelle. Ici le volet solde n'a pas de date de facture -> pas a cheval, meme si anneeSolde est connu.
    expect(info.aCheval).toBe(false);
  });

  test('ni date ni "Annee final" : annee null (non rattachable)', () => {
    const info = missionAvancementInfo({ ca: 10000, montantAcompte: 4000, dateFactureFinale: null, anneeFinal: '' });
    expect(info.dateFactureAcompte).toBeNull();
    expect(info.dateFactureFinale).toBeNull();
    expect(info.anneeSolde).toBeNull();
  });

  describe('aCheval : les deux volets portent une date d emission connue, sur des annees differentes (spec §5.1 quinquies point a, montants hors jeu)', () => {
    test('acompte 2025 / solde 2026 -> a cheval', () => {
      const info = missionAvancementInfo({
        ca: 10000, montantAcompte: 4000,
        dateFactureAcompte: '2025-06-01', dateFactureFinale: '2026-02-10',
      });
      expect(info.dateFactureAcompte).toBe('2025-06-01');
      expect(info.dateFactureFinale).toBe('2026-02-10');
      expect(info.aCheval).toBe(true);
    });

    test('acompte et solde la meme annee -> pas a cheval (mission lancee et terminee dans l annee)', () => {
      const info = missionAvancementInfo({
        ca: 10000, montantAcompte: 4000,
        dateFactureAcompte: '2026-02-01', dateFactureFinale: '2026-08-20',
      });
      expect(info.dateFactureAcompte).toBe('2026-02-01');
      expect(info.dateFactureFinale).toBe('2026-08-20');
      expect(info.aCheval).toBe(false);
    });

    // Correctif §5.1 quinquies point a (2026-09-02) : le seuil de montant (ex-MIN_MONTANT, herite a
    // tort de utils/billing.js) est retire de la detection du chevauchement. Ces deux tests prouvent
    // que le montant ne joue plus AUCUN role, y compris un acompte a zero ou symbolique, tant que la
    // date d'emission existe.
    test('un volet a 0 EUR mais avec une date d emission connue compte comme existant : le montant ne joue plus aucun role', () => {
      const info = missionAvancementInfo({
        ca: 10000, montantAcompte: 0,
        dateFactureAcompte: '2025-12-20', dateFactureFinale: '2026-01-05',
      });
      expect(info.montantAcompte).toBe(0);
      expect(info.dateFactureAcompte).toBe('2025-12-20');
      expect(info.dateFactureFinale).toBe('2026-01-05');
      expect(info.aCheval).toBe(true);
    });

    // Cas reel qui a motive le correctif : "Wienerberger - Phaunis", acompte symbolique de 1 EUR au
    // 01/12/2026, solde au 01/02/2027. Avec l'ancien seuil de 5 EUR, l'acompte etait ignore et la
    // mission jamais declaree a cheval, ce qui videait entierement la grille de la cloture 2026 alors
    // que cette mission la concernait au premier chef. L'acompte symbolique est justement le motif
    // habituel des factures a etablir : la DATE qu'il porte est l'information utile, pas son montant.
    test('Wienerberger - Phaunis (cas reel, spec §5.1 quinquies point a) : acompte de 1 EUR au 01/12/2026, solde au 01/02/2027 -> a cheval malgre l acompte symbolique', () => {
      const info = missionAvancementInfo({
        ca: 5000, montantAcompte: 1,
        dateFactureAcompte: '2026-12-01', dateFactureFinale: '2027-02-01',
      });
      expect(info.montantAcompte).toBe(1);
      expect(info.dateFactureAcompte).toBe('2026-12-01');
      expect(info.dateFactureFinale).toBe('2027-02-01');
      expect(info.anneeAcompte).toBe(2026);
      expect(info.anneeSolde).toBe(2027);
      expect(info.aCheval).toBe(true);
    });

    // Exigence explicite de la tache (ronde de correctifs §5.1 quinquies) : un volet sans AUCUNE date
    // (ni date de facture, ni repli "Annee final") ne doit jamais rendre la mission a cheval, quel que
    // soit son montant.
    test('un volet sans aucune date d emission (ni repli "Annee final") -> jamais a cheval', () => {
      const info = missionAvancementInfo({
        ca: 8000, montantAcompte: 3000,
        dateFactureAcompte: '2026-11-01', dateFactureFinale: null, anneeFinal: '',
      });
      expect(info.dateFactureAcompte).toBe('2026-11-01');
      expect(info.dateFactureFinale).toBeNull();
      expect(info.anneeSolde).toBeNull();
      expect(info.aCheval).toBe(false);
    });

    // Cas limite (ronde de correctifs 1, minor) : les deux volets existent (montants au-dessus du
    // seuil) mais AUCUNE des deux annees n'est connue (ni date de facture, ni repli "Annee final").
    // Ne doit evidemment jamais etre "a cheval" : on n'a rien a comparer.
    test('les deux annees de rattachement sont inconnues simultanement -> pas a cheval', () => {
      const info = missionAvancementInfo({
        ca: 10000, montantAcompte: 4000,
        dateFactureAcompte: null, dateFactureFinale: null, anneeFinal: '',
      });
      expect(info.anneeAcompte).toBeNull();
      expect(info.anneeSolde).toBeNull();
      expect(info.aCheval).toBe(false);
    });

    test('annee de rattachement inconnue d un cote -> pas a cheval', () => {
      const info = missionAvancementInfo({ ca: 10000, montantAcompte: 4000, dateFactureAcompte: '2025-06-01', dateFactureFinale: null, anneeFinal: '' });
      expect(info.dateFactureAcompte).toBe('2025-06-01');
      expect(info.dateFactureFinale).toBeNull();
      expect(info.aCheval).toBe(false);
    });

    test('Alphapro groupe (spec §5.1 bis) : 15 500 EUR factures en une fois le 2025-04-30, avancee a 70 % au 31/12/2025 -> PCA de 4 650 EUR, jamais a cheval au sens des dates de facture', () => {
      // Mission one-shot : le volet "Acompte" n'a pas ete facture (aucune date), tout est sur "Solde"
      // (meme convention que buildInvoiceLines cote front : "Acompte forcé" ~ 1 EUR ou absent). Reste
      // non a cheval avec la nouvelle regle : ce n'est pas le montant qui l'exclut mais l'absence de
      // date sur le volet acompte, aCheval exige les DEUX dates.
      const alphapro = {
        ca: 15500, montantAcompte: 0,
        dateFactureAcompte: null, dateFactureFinale: '2025-04-30', anneeFinal: '2025',
      };
      const info = missionAvancementInfo(alphapro);
      expect(info.dateFactureAcompte).toBeNull();
      expect(info.dateFactureFinale).toBe('2025-04-30');
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
    expect(info.dateFactureAcompte).toBeNull();
    expect(info.dateFactureFinale).toBeNull();
    expect(info.anneeAcompte).toBeNull();
    expect(info.anneeSolde).toBeNull();
    expect(info.aCheval).toBe(false);
  });
});
