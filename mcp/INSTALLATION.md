# releaf-deals dans Claude Desktop : installation (Windows)

Ce dossier branche le pipeline commercial Releaf (HubSpot) directement dans Claude Desktop.
Une fois installé, tu demandes « donne-moi le pipeline » ou « quels deals sont en retard ? »
et Claude va chercher la donnée réelle dans le CRM.

Compte 10 minutes.

## 1. Vérifier Node.js

Ouvre PowerShell (touche Windows, tape « powershell ») et lance :

```
node -v
```

Si tu vois un numéro de version (v20 ou plus), passe à l'étape 2.
Sinon, installe Node.js LTS depuis https://nodejs.org, puis relance PowerShell et refais le test.

## 2. Poser le dossier

Décompresse `kit-releaf-deals` dans `C:\Users\<ton-nom>\`.
Tu dois obtenir cette arborescence :

```
C:\Users\<ton-nom>\kit-releaf-deals\
    .env
    package.json
    INSTALLATION.md
    mcp\deals-server.js
    node_modules\
```

Le dossier `node_modules` est déjà rempli, tu n'as rien à installer.

Remplace `<ton-nom>` par ton nom d'utilisateur Windows partout dans la suite. Pour le connaître :

```
echo $env:USERNAME
```

## 3. Déclarer le serveur dans Claude Desktop

Ouvre le fichier de configuration :

```
notepad $env:APPDATA\Claude\claude_desktop_config.json
```

Si Notepad dit que le fichier n'existe pas, accepte de le créer.

Colle ceci, en remplaçant `<ton-nom>` :

```json
{
  "mcpServers": {
    "releaf-deals": {
      "command": "node",
      "args": ["C:\\Users\\<ton-nom>\\kit-releaf-deals\\mcp\\deals-server.js"]
    }
  }
}
```

Attention aux doubles antislashs `\\` : c'est obligatoire dans du JSON.

Si le fichier contenait déjà un bloc `mcpServers`, ajoute seulement la ligne `"releaf-deals": {...}`
à l'intérieur, sans créer un deuxième bloc.

Enregistre et ferme.

## 4. Redémarrer Claude Desktop

Quitte complètement l'application : clic droit sur l'icône dans la barre des tâches (en bas à droite,
sous la flèche) puis Quitter. Fermer la fenêtre ne suffit pas.

Relance Claude Desktop. Dans une nouvelle conversation, l'icône outils (prise électrique) doit
afficher `releaf-deals` avec ses 14 outils.

## 5. Tester

Demande dans Claude :

> donne-moi le pipeline commercial

Tu dois recevoir le nombre de deals ouverts, le montant total et la ventilation par étape.
Si ça marche, c'est fini.

## Ce que tu peux faire avec

### Lecture

- `get_pipeline` : deals ouverts par étape, forecast pondéré, ventilation par tag
- `get_deals_analytics` : deals clôturés sur une période, gagné/perdu, taux de conversion, panier moyen
- `list_deals` : liste filtrable par statut, période, étape, tag
- `get_tasks`, `get_overdue_deals`, `get_daily_briefing` : tâches et deals en retard

### Écriture

Claude demande ta confirmation avant chaque appel.

- `create_deal`, `update_deal`, `close_deal` écrivent dans HubSpot, donc dans le CRM réel de Releaf
- `set_deal_tags`, `add_deal_note`, `log_relance`, `add_deal_task`, `assign_deal` écrivent dans la
  base Supabase du dashboard, c'est réversible

Le périmètre couvert est le pipeline `default` uniquement.

## Mettre à jour

Le serveur tourne **sur ton ordinateur**. Il ne se met pas à jour tout seul : quand le calcul
change côté Releaf, ta copie continue de répondre comme avant, avec ses anciens chiffres.

Tu n'as pas à y penser : ta copie te prévient. Si Claude te dit que **le serveur MCP est
obsolète**, ou si tu vois `"outdated": true` dans une réponse, fais ceci.

1. Demande le kit à jour à Nathan.
2. Ferme complètement Claude Desktop (icône dans la barre des tâches, puis « Quitter »).
3. **Mets ton fichier `.env` de côté**, il n'est pas dans le kit et tu le perdrais.
4. Supprime l'ancien dossier `kit-releaf-deals` et décompresse le nouveau au même endroit.
5. Remets ton `.env` à la racine du dossier, comme à l'étape 2.
6. Relance Claude Desktop.

Rien d'autre à refaire : la configuration de l'étape 3 pointe sur le même chemin.

Pour vérifier quelle version tourne chez toi, demande n'importe quoi à Claude sur les deals :
chaque réponse porte un bloc `_mcp` avec `server_version`.

> **Côté Releaf, pour fabriquer et diffuser un kit** : `npm run mcp:kit` produit le zip, puis
> `npm run mcp:kit -- --publish` publie la version comme minimum requis. Publier **après** avoir
> envoyé le zip, sinon tout le monde reçoit l'avertissement avant d'avoir de quoi le corriger.

## Si ça ne marche pas

### releaf-deals n'apparaît pas dans le menu outils

Le JSON est probablement mal formé. Recolle le bloc de l'étape 3 tel quel et vérifie les `\\`.
Vérifie aussi que tu as bien quitté puis relancé Claude Desktop.

### Erreur « node introuvable »

Claude Desktop ne voit pas Node dans le PATH. Remplace `"command": "node"` par le chemin complet :
`"command": "C:\\Program Files\\nodejs\\node.exe"`.

### Claude annonce que le serveur est obsolète

Ce n'est pas une panne : ta copie est simplement plus ancienne que la version en service, et
elle te le dit pour que tu ne t'appuies pas sur des chiffres périmés. Voir « Mettre à jour ».

### Erreur d'authentification HubSpot

Préviens Guillaume, la clé API a probablement été régénérée.

## Sécurité

Le fichier `.env` contient les clés d'accès HubSpot et Supabase de Releaf. Ne le transfère à
personne et ne le mets pas sur un dépôt Git.
