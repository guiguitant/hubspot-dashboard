#!/usr/bin/env node
'use strict';

/**
 * Fabrique le kit d'installation du serveur MCP "releaf-deals".
 *
 * POURQUOI CE SCRIPT EXISTE
 * Le kit précédent avait été assemblé à la main. Il n'a donc jamais été refait, et il a
 * distribué pendant des semaines une version du serveur dont les probabilités étaient
 * codées en dur : chaque poste calculait un forecast faux, sans que rien ne le signale.
 * Une redistribution qui coûte cher est une redistribution qui n'a pas lieu. D'où ce script.
 *
 * USAGE
 *   npm run mcp:kit              fabrique mcp/kit-releaf-deals.zip
 *   npm run mcp:kit -- --publish idem, PUIS publie la version comme minimum requis,
 *                                ce qui fait avertir toutes les copies plus anciennes.
 *
 * L'ordre compte : on publie APRÈS avoir envoyé le zip, sinon tout le monde reçoit
 * l'avertissement d'obsolescence avant d'avoir de quoi le corriger.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const AdmZip = require('adm-zip');

const RACINE = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RACINE, '.env') });
const { MCP_SERVER_VERSION } = require(path.join(RACINE, 'utils', 'mcpVersion'));

const NOM_KIT = 'kit-releaf-deals';
const SORTIE = path.join(RACINE, 'mcp', `${NOM_KIT}.zip`);

// Fichiers embarqués. La structure de dossiers est REPRODUITE À L'IDENTIQUE dans le kit :
// deals-server.js fait `require('../utils/dealDormancy')` et lit `../.env`. Aplatir
// l'arborescence casserait le serveur au démarrage, sans message compréhensible.
const FICHIERS = [
  'mcp/deals-server.js',
  'mcp/INSTALLATION.md',
  'utils/dealDormancy.js',
  'utils/mcpVersion.js',
];

// Seules les dépendances que le serveur MCP charge réellement. Le dépôt en compte une
// quarantaine (React, googleapis, express...) : les embarquer ferait un kit de plusieurs
// centaines de mégaoctets pour rien.
const DEPENDANCES = ['@modelcontextprotocol/sdk', '@supabase/supabase-js', 'zod', 'dotenv'];

const log = (...a) => console.log('[kit]', ...a);

// Copie un fichier en créant les dossiers parents au besoin.
function copier(relatif, destination) {
  const src = path.join(RACINE, relatif);
  if (!fs.existsSync(src)) throw new Error(`Fichier introuvable : ${relatif}`);
  const dst = path.join(destination, relatif);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Lance le serveur fraîchement assemblé et attend son message de démarrage.
// Un kit qui ne démarre pas est pire qu'un kit périmé : personne ne saura pourquoi.
// Ce test aurait attrapé l'oubli de `utils/` le jour où le serveur a gagné cette dépendance.
function verifierDemarrage(dossier) {
  return new Promise((resolve, reject) => {
    const serveur = spawn(process.execPath, [path.join(dossier, 'mcp', 'deals-server.js')], {
      env: process.env, // les clés viennent du .env du dépôt : rien n'est écrit dans le kit
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    const minuteur = setTimeout(() => {
      serveur.kill();
      reject(new Error(`le serveur du kit n'a pas démarré en 20 s. Sortie erreur :\n${err}`));
    }, 20000);
    serveur.stderr.on('data', (d) => {
      err += d;
      if (err.includes('serveur prêt')) {
        clearTimeout(minuteur);
        serveur.kill();
        resolve();
      }
    });
    serveur.on('error', (e) => { clearTimeout(minuteur); reject(e); });
    serveur.on('exit', (code) => {
      clearTimeout(minuteur);
      if (code !== null && code !== 0) reject(new Error(`le serveur du kit s'est arrêté (code ${code}) :\n${err}`));
    });
  });
}

// Publie la version courante comme minimum requis : toute copie plus ancienne
// se met alors à avertir son utilisateur à chaque réponse.
async function publierVersion() {
  const { createClient } = require(path.join(RACINE, 'node_modules', '@supabase', 'supabase-js'));
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absentes du .env');
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await sb.from('kpi_prime_config').upsert({
    id: 'mcp_version',
    config: { min_version: MCP_SERVER_VERSION, published_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });
  if (error) throw new Error(`publication de la version : ${error.message}`);
  log(`version minimale publiée : ${MCP_SERVER_VERSION}`);
  log('les copies plus anciennes avertiront désormais leur utilisateur à chaque réponse.');
}

async function main() {
  const publier = process.argv.includes('--publish');
  log(`fabrication du kit, serveur version ${MCP_SERVER_VERSION}`);

  const travail = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-mcp-'));
  const dossier = path.join(travail, NOM_KIT);
  fs.mkdirSync(dossier, { recursive: true });

  for (const f of FICHIERS) copier(f, dossier);
  log(`${FICHIERS.length} fichiers copiés`);

  // package.json du kit : versions reprises du dépôt, pour installer exactement ce qui a été testé.
  const racinePkg = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
  const dependencies = {};
  for (const d of DEPENDANCES) {
    if (!racinePkg.dependencies[d]) throw new Error(`dépendance ${d} absente du package.json du dépôt`);
    dependencies[d] = racinePkg.dependencies[d];
  }
  fs.writeFileSync(path.join(dossier, 'package.json'), JSON.stringify({
    name: NOM_KIT,
    version: MCP_SERVER_VERSION,
    private: true,
    description: 'Serveur MCP releaf-deals pour Claude Desktop',
    dependencies,
  }, null, 2) + '\n');

  log('installation des dépendances (quelques dizaines de secondes)...');
  // Lancer npm proprement sous Windows demande une precaution. Depuis Node 20, un fichier
  // .cmd ne peut plus etre lance sans shell (correctif de securite), et passer par `shell:true`
  // concatene les arguments sans les echapper, ce que Node deprecie. On appelle donc le script
  // npm directement avec l'executable Node : ni shell, ni .cmd, et le meme comportement partout.
  // npm_execpath est renseigne des qu'on passe par `npm run` ; sinon on retombe sur le shell.
  const npmCli = process.env.npm_execpath;
  const [commande, args] = npmCli
    ? [process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund']]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund']];
  execFileSync(commande, args, {
    cwd: dossier, stdio: 'pipe',
    shell: !npmCli && process.platform === 'win32',
  });

  log('vérification : le serveur du kit démarre-t-il ?');
  await verifierDemarrage(dossier);
  log('démarrage confirmé');

  const zip = new AdmZip();
  zip.addLocalFolder(dossier, NOM_KIT);
  zip.writeZip(SORTIE);
  const mo = (fs.statSync(SORTIE).size / 1024 / 1024).toFixed(1);
  log(`kit écrit : ${path.relative(RACINE, SORTIE)} (${mo} Mo)`);

  fs.rmSync(travail, { recursive: true, force: true });

  if (publier) {
    await publierVersion();
  } else {
    log('version NON publiée. Envoyez d\'abord le zip, puis lancez :');
    log('  npm run mcp:kit -- --publish');
  }
}

main().catch((e) => { console.error('[kit] ÉCHEC :', e.message); process.exit(1); });
