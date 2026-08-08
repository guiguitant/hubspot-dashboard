'use strict';
const { classifyProduitSubvention, CATEGORIE_SUBVENTIONS } = require('./produitsSubventions');

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
  });

  describe("famille 'produit' (subvention pure ou aide a l'embauche)", () => {
    it("classe 'Subvention' en produit", () => {
      expect(classifyProduitSubvention('Subventions et aides', 'Subvention BFT')).toBe('produit');
    });

    it("classe 'Aide a l'embauche' en produit", () => {
      expect(classifyProduitSubvention('Subventions et aides', "Aide à l'embauche")).toBe('produit');
    });

    it('insensible aux accents et a la casse (subvention pure)', () => {
      expect(classifyProduitSubvention('subventions et aides', 'subvention pure')).toBe('produit');
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
