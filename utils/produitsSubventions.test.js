'use strict';
const { classifyProduitSubvention, isProduit, CATEGORIE_SUBVENTIONS } = require('./produitsSubventions');

describe('classifyProduitSubvention', () => {
  describe('categorie hors sujet', () => {
    it("renvoie null si la categorie parente n'est pas 'Subventions et aides'", () => {
      expect(classifyProduitSubvention('Impôts et taxes', 'Remboursement IS')).toBeNull();
    });

    it('renvoie null pour une categorie totalement differente (encaissement client)', () => {
      expect(classifyProduitSubvention('Ventes', 'Facture client')).toBeNull();
    });

    it('renvoie null si la categorie est absente/null', () => {
      expect(classifyProduitSubvention(null, 'Subvention')).toBeNull();
      expect(classifyProduitSubvention(undefined, 'Aide')).toBeNull();
    });
  });

  describe("famille 'exclu' (avance remboursable = emprunt, jamais un produit)", () => {
    it("classe 'Avance remboursable' en exclu", () => {
      expect(classifyProduitSubvention('Subventions et aides', 'Avance remboursable')).toBe('exclu');
    });

    it("classe 'Avance' seul en exclu", () => {
      expect(classifyProduitSubvention('Subventions et aides', 'Avance')).toBe('exclu');
    });

    it("classe 'Prêt' en exclu", () => {
      expect(classifyProduitSubvention('Subventions et aides', 'Prêt BFT')).toBe('exclu');
    });

    it('insensible aux accents et a la casse (AVANCE REMBOURSABLE)', () => {
      expect(classifyProduitSubvention('SUBVENTIONS ET AIDES', 'AVANCE REMBOURSABLE')).toBe('exclu');
    });

    // M1 : precedence VOULUE de MOTIFS_EXCLU sur MOTIFS_PRODUIT. Un libelle qui contient les deux
    // familles ("Avance sur subvention") sort en 'exclu' : exclure a tort sous-estime l'EBE (erreur
    // visible, corrigeable en reclassant), l'inclure a tort le surestime en silence.
    it("libelle ambigu 'Avance sur subvention' -> exclu (MOTIFS_EXCLU teste avant MOTIFS_PRODUIT)", () => {
      expect(classifyProduitSubvention('Subventions et aides', 'Avance sur subvention')).toBe('exclu');
      expect(classifyProduitSubvention('Subventions et aides', "Avance sur aide à l'embauche")).toBe('exclu');
    });
  });

  describe("famille 'produit' sous-typee subvention / aide (I4)", () => {
    it("classe 'Subvention' en produit-subvention", () => {
      expect(classifyProduitSubvention('Subventions et aides', 'Subvention BFT')).toBe('produit-subvention');
    });

    it("classe 'Aide a l'embauche' en produit-aide", () => {
      expect(classifyProduitSubvention('Subventions et aides', "Aide à l'embauche")).toBe('produit-aide');
    });

    it('insensible aux accents et a la casse (subvention pure)', () => {
      expect(classifyProduitSubvention('subventions et aides', 'subvention pure')).toBe('produit-subvention');
    });

    it("libelle portant les DEUX motifs produit : 'subvention' gagne (ordre de MOTIFS_PRODUIT)", () => {
      expect(classifyProduitSubvention('Subventions et aides', "Subvention aide à l'embauche")).toBe('produit-subvention');
    });

    it('isProduit reconnait les deux sous-types, et eux seuls', () => {
      expect(isProduit('produit-subvention')).toBe(true);
      expect(isProduit('produit-aide')).toBe(true);
      expect(isProduit('exclu')).toBe(false);
      expect(isProduit('inconnu')).toBe(false);
      expect(isProduit(null)).toBe(false);
    });
  });

  describe("famille 'inconnu' (a signaler, jamais silencieux)", () => {
    it('sous-categorie absente/vide -> inconnu (jamais null : la categorie parente EST le sujet)', () => {
      expect(classifyProduitSubvention('Subventions et aides', null)).toBe('inconnu');
      expect(classifyProduitSubvention('Subventions et aides', '')).toBe('inconnu');
      expect(classifyProduitSubvention('Subventions et aides', undefined)).toBe('inconnu');
    });

    it('sous-categorie non reconnue -> inconnu', () => {
      expect(classifyProduitSubvention('Subventions et aides', 'Autre')).toBe('inconnu');
    });
  });

  it('CATEGORIE_SUBVENTIONS est normalisee (export pour reference)', () => {
    expect(CATEGORIE_SUBVENTIONS).toBe('subventions et aides');
  });
});
