'use strict';

// =====================================================================
//  Version du serveur MCP — À INCRÉMENTER À CHAQUE MODIFICATION
// =====================================================================
// Ce serveur est DISTRIBUÉ : une copie tourne sur le poste de chaque utilisateur,
// lancée par Claude Desktop, et rien ne la met à jour toute seule. Sans numéro de
// version, on ne peut ni savoir ce qui tourne chez qui, ni prévenir quelqu'un que
// sa copie est périmée : elle répond alors des chiffres faux avec assurance.
// C'est exactement ainsi qu'un forecast erroné a pu circuler sans être vu.
//
// Convention MAJEUR.MINEUR.CORRECTIF. Monter le MINEUR dès qu'un chiffre renvoyé
// peut changer, puis publier ce numéro comme minimum requis :
//   npm run mcp:kit -- --publish
//
// Fichier volontairement sans dépendance : il part tel quel dans le kit.
const MCP_SERVER_VERSION = '1.1.0';

// Compare deux versions « MAJEUR.MINEUR.CORRECTIF ».
// -1 si a < b, 0 si égales, 1 si a > b. Comparaison NUMÉRIQUE segment par segment :
// en comparaison de texte, '1.10.0' passerait avant '1.9.0', ce qui laisserait un
// serveur périmé se croire à jour. Les segments manquants valent 0 ('1.2' == '1.2.0').
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { MCP_SERVER_VERSION, compareVersions };
