# MCP — Serveur "deals" pour Claude Desktop

Expose la donnée commerciale HubSpot à l'application Claude Desktop, pour
poser des questions en langage naturel (« donne-moi l'analytics des deals
du Q1 2026 », « quels deals sont à risque ? »).

## Fonctionnement

- `deals-server.js` : serveur MCP **stdio**, autonome.
- Lit **`HUBSPOT_API_KEY`** dans le `.env` à la racine du projet (auth EU/PAT
  auto-détectée, comme `server.js`) pour les deals, et **Supabase**
  (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) pour les **tags**
  (table `deal_metadata`, jointure par `deal_id`) pour les **tags, l'assigné et
  la dormance**, ainsi que le **barème de pondération** (table `kpi_prime_config`,
  ligne `pipeline_ponderation`). Aucune dépendance au backend en exécution : il
  fonctionne que le dashboard tourne ou non.

## Périmètre du pipe pondéré — à lire avant d'exploiter `get_pipeline`

Trois chiffres différents ont circulé pour le même portefeuille tant que ces
règles n'étaient pas explicites. Elles le sont désormais **dans la réponse** :
les consommateurs (agent quotidien, artifact « Attribution du pipe ») doivent
lire les champs, jamais redériver les règles de leur côté.

- Chaque deal ouvert est dans **un** de ces trois états, lisible sur le deal :
  - `frozen` — rangé dans « À relancer plus tard » (gel manuel). Hors projection.
  - `dormant` — 90 j sans relance ni note, sauf RDV futur, tâche à échéance future,
    deal créé depuis moins de 7 j, ou réveil manuel récent. Hors projection.
  - actif — le reste. `counts_in_forecast: true`.
- **`active_count` / `active_amount` sont les chiffres comparables à la carte
  « Commercial » de Pilot.** `open_deals` / `total_amount` comptent TOUT, gelés
  et dormants inclus : les citer donne un pipe gonflé d'un facteur ~2,6.
- La règle de dormance est définie à **un seul endroit**, `utils/dealDormancy.js`,
  partagé avec `server.js`. Ne jamais la réécrire ailleurs.
- Les **probabilités** viennent des réglages de Pilot (écran de pondération),
  relues à chaud toutes les 60 s, et sont renvoyées dans `stage_probabilities`.
  Aucune valeur n'est codée en dur dans le serveur.
- Si le barème est injoignable ou incomplet : `weighted_forecast: null` +
  `warning: "stage probabilities unavailable"`. **Aucun repli sur des valeurs par
  défaut** : un pipe pondéré faux ne se voit pas, un pipe pondéré absent se voit.

Les **descriptions** des deals ne sont pas renvoyées par défaut : `include_descriptions: true`
pour une lecture qualitative deal par deal. `summary.descriptions_included` dit ce qui a été
renvoyé, pour qu'un champ absent ne se lise pas comme une description vide.

`get_daily_briefing` répond sous **20 s** ; au-delà il renvoie ce qui est prêt
avec `truncated: true` et `truncated_reasons`. `timings_ms` détaille chaque étape.

## Outils exposés

### Lecture

| Outil | Usage | Arguments |
|-------|-------|-----------|
| `get_pipeline` | Deals **ouverts** par stage + forecast pondéré + assigné + état (actif / dormant / gelé) + ventilation par tag | `tag?`, `include_descriptions?` |
| `get_deals_analytics` | Deals **clôturés** sur une période : gagné/perdu, taux de conversion, panier moyen, par tag et **par assigné** | `from`, `to` (YYYY-MM-DD, sur `closedate`), `tag?` |
| `list_deals` | Liste filtrable (statut / période / stage / tag) | `status` (open\|closed\|all), `from?`, `to?`, `stage?`, `tag?` |

### Écriture

> Claude Desktop demande une **confirmation manuelle avant chaque appel**.
> 🔴 = écrit dans HubSpot (CRM réel) · 🟢 = écrit dans Supabase (local, réversible).

| Outil | Effet | Arguments |
|-------|-------|-----------|
| 🔴 `create_deal` | Crée un deal (pipeline `default`) | `name`, `stage`, `amount?`, `closedate?`, `tags?` |
| 🔴 `update_deal` | Modifie montant / stage / date / description | `id`, `amount?`, `stage?`, `closedate?`, `description?` |
| 🔴 `close_deal` | **Clôture** gagné/perdu (sensible) | `id`, `outcome` (won\|lost), `closedate?` |
| 🟢 `set_deal_tags` | Remplace la liste de tags | `id`, `tags[]` |
| 🟢 `add_deal_note` | Note append-only | `id`, `text` |
| 🟢 `log_relance` | Logge une relance email/tél | `id`, `type` (email\|phone), `note` |
| 🟢 `add_deal_task` | Ajoute une tâche | `id`, `type`, `label?`, `due_at?` |
| 🟢 `assign_deal` | Assigne / fixe le prochain RDV | `id`, `assignee?`, `next_meeting_at?` |

Validations conservées (miroir `server.js`) : stage parmi les labels connus,
assignee ∈ {Guillaume, Vincent, Nathan}, montants/dates valides. Pas de
garde-fou serveur supplémentaire au-delà de la confirmation Claude Desktop.

Claude choisit l'outil selon la question. Ex : « analytics Q1 2026 »
→ `get_deals_analytics(from=2026-01-01, to=2026-03-31)` ; « pipeline EPD »
→ `get_pipeline(tag='EPD')`.

### Tags

Les tags vivent dans Supabase `deal_metadata.tags` (posés via le dashboard) :
**EPD**, **Bilan carbone**, **Web app**, **ACV**. Bien couverts sur le
**pipeline ouvert**, mais **peu présents sur l'historique clôturé** — d'où le
bloc `tag_coverage` renvoyé par `get_deals_analytics` : quand peu de deals
clôturés sont taggés, Claude est instruit de signaler que l'analyse par tag
sur le clôturé est indicative, pas exhaustive.

## Branchement dans Claude Desktop

1. Ouvre le fichier de config :
   `%APPDATA%\Claude\claude_desktop_config.json`
   (Windows : `C:\Users\<toi>\AppData\Roaming\Claude\claude_desktop_config.json`).
   S'il n'existe pas, crée-le.

2. Ajoute le serveur (fusionne avec un éventuel bloc `mcpServers` existant) :

```json
{
  "mcpServers": {
    "releaf-deals": {
      "command": "node",
      "args": ["C:\\Users\\GuillaumeTant\\hubspot-dashboard\\mcp\\deals-server.js"]
    }
  }
}
```

3. **Redémarre Claude Desktop** (quitter complètement, pas juste fermer la
   fenêtre). Le serveur `releaf-deals` apparaît dans le menu outils (icône
   prise/✶). Tu peux alors demander : *« donne-moi l'analytics des deals du
   Q1 2026 »*.

> `node` doit être accessible dans le PATH système. Vérifie avec `node -v`
> dans un terminal. Si Claude Desktop ne trouve pas `node`, remplace
> `"command": "node"` par le chemin absolu (ex : `"C:\\Program Files\\nodejs\\node.exe"`).

## Limites actuelles

- Périmètre = pipeline `default` uniquement (les 5 stages du kanban pour
  l'ouvert ; tous les clôturés pour l'analytics).
- Analytics filtré sur `closedate`. Pour des deals non clôturés sur une
  période, utiliser `list_deals` avec `status=open` (filtre alors `createdate`).
