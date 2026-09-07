'use strict';
const { compareVersions, MCP_SERVER_VERSION } = require('./mcpVersion');

describe('compareVersions', () => {
  it('compare numériquement, pas alphabétiquement', () => {
    // Le piège classique : en texte, '1.10.0' < '1.9.0'. Un serveur en 1.9.0 se
    // croirait alors à jour face à un minimum de 1.10.0.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  it('versions égales -> 0', () => {
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
  });

  it('segments manquants valent 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')).toBe(1);
  });

  it('ordonne majeur avant mineur avant correctif', () => {
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });

  it('valeurs illisibles traitées comme 0 plutôt que NaN', () => {
    expect(compareVersions('abc', '0.0.0')).toBe(0);
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
  });

  it('la version publiée est bien formée', () => {
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
